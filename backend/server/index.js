import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import mongoose from 'mongoose';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { Task } from './models/Task.js';
import { Sprint } from './models/Sprint.js';
import { TaskHistory } from './models/TaskHistory.js';
import { endDateForStart, summarizeTasks, computeSprintDay, validateSprintRange, todayIsoDate } from './lib/sprintDates.js';
import { sortBacklog } from './lib/backlogOrder.js';
import {
  BACKLOG_STATUS, SPRINT_ENTRY_STATUS, isPermittedSprintStatusChange,
  sprintAcceptsBacklogItem, statusLabel, taskCanReturnToBacklog
} from './lib/taskTransitions.js';
import { normalizeDueDate, migrateLegacyFields } from './lib/taskMigration.js';
import { User } from './models/User.js';
import { connectDatabase, databaseStatus, reconnectDatabase } from './db.js';
import { Board } from './models/Board.js';
import {
  createAuthError, isAuthError, createUser, authenticateUser, createAuthSession,
  requireAuth, requireRole, invalidateSession, revokeAllSessionsForUser, validatePassword,
  memoryUsers, hashPassword, setDatabaseReady,
  refreshSessionUser, serializeUser, sessions,
  findUserByEmail, findUserById, findUserAiKey, updateUserAiKey,
  isEmailVerified, markEmailVerified, normalizeDeviceId, isTrustedDevice, trustDevice,
  normalizeAndValidateUsername, isUsernameTaken
} from './auth.js';
import { issueCode, verifyCode, findCodeByChallenge, findActiveChallenge, discardCode } from './lib/authCodes.js';
import { sendMail } from './lib/email.js';
import { chatWithContext, MAX_MESSAGE_LENGTH, findBestSkilledMember, pickRandomMember } from './ai.js';
import {
  setOverride, removeOverride, clearOverrides, getAllEffective
} from './lib/envConfig.js';
import{
  BOARD_SUMMARY_LIMIT, PRIORITY_TASK_LIMIT, activeSprintsOf, dueDateText, isOpenTask, isOverdueTask,
  numberOf, orderDashboardTasks, stageCounts, taskBelongsTo
} from './lib/dashboard.js';
import {
  boardNameFromGoal, createBoardWithPlan, normalizeBoardGenerationRequest, planningMessage, tasksFromAiResult
} from './lib/aiBoardPlan.js';
import {
  applyStatusLifecycle, emitTaskCreated, emitTaskAssigned, emitTaskStatusChanged
} from './lib/taskService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const app = express();
const port = Number(process.env.PORT || 4000);
const uploadsDir = path.join(__dirname, '../uploads');
const allowedStatuses = ['backlog', 'todo', 'progress', 'review', 'done'];
// One board shape shared by Copilot and AI board generation.
const BOARD_COLUMNS = [
  { id: 'backlog', label: 'Backlog', color: 'slate', hint: 'Shape the next move' },
  { id: 'todo', label: 'To Do', color: 'cyan', hint: 'Ready to pick up' },
  { id: 'progress', label: 'In Progress', color: 'violet', hint: 'Active execution' },
  { id: 'review', label: 'In Review / QA', color: 'blue', hint: 'Validate and ship' },
  { id: 'done', label: 'Done', color: 'green', hint: 'Verified outcomes' }
];
const allowedPriorities = ['urgent', 'high', 'medium', 'low'];
const rateLimits = new Map();
let mongoReady = false;
let memorySprints = [];
let memoryBoards = [];
let memoryTaskHistory = [];

fs.mkdirSync(uploadsDir, { recursive: true });
app.use(express.json({ limit: '150kb' }));
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
const RATE_LIMIT_WINDOW_MS = 60_000;
app.use((req, res, next) => {
  const key = `${req.ip}:${req.path}`;
  const now = Date.now();
  // Expired windows are only removed when their key is used again, so sweep
  // occasionally to keep the map from growing with every unique visitor.
  if (rateLimits.size > 5_000) {
    for (const [entryKey, entry] of rateLimits) {
      if (now - entry.startedAt > RATE_LIMIT_WINDOW_MS) rateLimits.delete(entryKey);
    }
  }
  const windowStart = rateLimits.get(key) || { count: 0, startedAt: now };
  if (now - windowStart.startedAt > RATE_LIMIT_WINDOW_MS) {
    windowStart.count = 0;
    windowStart.startedAt = now;
  }
  windowStart.count += 1;
  rateLimits.set(key, windowStart);
  const limit = req.path.startsWith('/api/auth') ? 20 : 120;
  if (windowStart.count > limit) return res.status(429).json({ error: 'Too many requests. Try again later.' });
  next();
});

function starterTasksFor(user) {
  const name = user?.name && user.name !== user.email ? user.name : 'You';
  // Task.dueDate is a real date, so the starter templates must use dates too.
  // Free text ("Today", "This week") failed schema validation and made every
  // signup return 500 after the account had already been created.
  const today = todayIsoDate();
  const inDays = (days) => new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
  return [
    { title: 'Welcome to your LeadAI board', status: 'done', priority: 'low', labels: ['Getting Started'], assignee: name, dueDate: today, description: 'This board belongs to you. Create, organize, and move tasks however you like.' },
    { title: 'Create your first task', status: 'todo', priority: 'high', labels: ['Getting Started'], assignee: name, dueDate: today, description: 'Click "Add Task" to capture something you are working on. Try adding a label and a due date.' },
    { title: 'Drag a card between columns', status: 'todo', priority: 'low', labels: ['Getting Started'], assignee: name, dueDate: null, description: 'Move this card from To Do into In Progress to watch the board update instantly.' },
    { title: 'Agree on a definition of done', status: 'review', priority: 'medium', labels: ['Process'], assignee: name, dueDate: inDays(3), description: 'A clear definition of done keeps completed work consistent across your board.' },
    { title: 'Invite a teammate to collaborate', status: 'backlog', priority: 'medium', labels: ['Team'], assignee: 'Unassigned', dueDate: null, description: 'Share your workspace so others can comment on and track shared work.' }
  ];
}
let memoryTasks = [];
function seedSprint(ownerId, boardId = null) {
  const start = new Date(`${todayIsoDate()}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 3);
  const startDate = start.toISOString().slice(0, 10);
  return {
    name: 'Q3 Product Engineering Sprint 14',
    goal: 'Ship the core orchestration engine v2.4 with a working LLM fallback matrix.',
    startDate,
    endDate: endDateForStart(startDate),
    ownerId: String(ownerId),
    boardId: boardId ? String(boardId) : null,
    createdAt: new Date()
  };
}
const sprintId = (sprint) => String(sprint._id ?? sprint.id);
const boardId = (board) => String(board._id ?? board.id);
let memorySprintCounter = 0;
function withSprintId(sprint) {
  return sprint._id ? sprint : { ...sprint, _id: `mem-sprint-${Date.now()}-${++memorySprintCounter}` };
}
async function seedStarterTasks(user, board) {
  for (const template of starterTasksFor(user)) {
    await store.create({ key: await newTaskKey(), ownerId: String(user._id), boardId: boardId(board), ...template, comments: [], attachments: [], dependencies: [] });
  }
}

async function connectMongo() {
  const status = await connectDatabase();
  mongoReady = status.mode === 'mongodb';
  setDatabaseReady(mongoReady);
  return status;
}

const store = {
  list: () => mongoReady ? Task.find().sort({ createdAt: 1 }).lean() : Promise.resolve(memoryTasks),
  find: (key) => mongoReady ? Task.findOne({ key }) : Promise.resolve(memoryTasks.find((task) => task.key === key)),
  create: async (data) => {
    if (mongoReady) return new Task(data).save();
    const task = { ...data, _id: crypto.randomUUID(), createdAt: new Date(), updatedAt: new Date() };
    memoryTasks = [...memoryTasks, task];
    return task;
  },
  update: async (key, data) => {
    if (mongoReady) return Task.findOneAndUpdate({ key }, { $set: data }, { new: true, runValidators: true });
    const current = memoryTasks.find((task) => task.key === key);
    if (!current) return null;
    memoryTasks = memoryTasks.map((task) => task.key === key ? { ...task, ...data, updatedAt: new Date() } : task);
    return memoryTasks.find((task) => task.key === key);
  },
  remove: async (key) => {
    if (mongoReady) return Task.deleteOne({ key });
    const before = memoryTasks.length;
    memoryTasks = memoryTasks.filter((task) => task.key !== key);
    return { deletedCount: before - memoryTasks.length };
  },
  listBySprint: (id) => mongoReady ? Task.find({ sprintId: id }).sort({ createdAt: 1 }).lean() : Promise.resolve(memoryTasks.filter((task) => String(task.sprintId) === String(id))),
  listByBoard: (id) => mongoReady ? Task.find({ boardId: id }).sort({ createdAt: 1 }).lean() : Promise.resolve(memoryTasks.filter((task) => String(task.boardId) === String(id))),
  // Board and profile queries are owner-scoped in the database; a shared database must
  // never require loading every developer's tasks to show one person's board.
  listByOwner: (ownerId) => mongoReady ? Task.find({ ownerId }).sort({ createdAt: 1 }).lean() : Promise.resolve(memoryTasks.filter((task) => String(task.ownerId) === String(ownerId))),
  listWithoutSprint: (ownerId) => {
    if (!mongoReady) return Promise.resolve(memoryTasks.filter((task) => !task.sprintId && (!ownerId || String(task.ownerId) === String(ownerId))));
    return Task.find(ownerId ? { sprintId: null, ownerId } : { sprintId: null }).sort({ createdAt: 1 }).lean();
  }
};

// Ids are generated by us, so a collision is rare; a bounded retry still beats
// looping forever if the collection ever grows past the key space.
// ponytail: 24-bit random suffix (16.7M keys), switch to a per-board counter if a
// single database ever reaches that many tasks.
async function newTaskKey() {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const key = `KAN-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    if (!await store.find(key)) return key;
  }
  throw createAuthError(503, 'Could not allocate a task key. Please try again.');
}

const sprintStore = {
  list: (ownerId) => mongoReady ? Sprint.find({ ownerId }).sort({ createdAt: 1 }).lean() : Promise.resolve(memorySprints.filter((sprint) => String(sprint.ownerId) === String(ownerId))),
  find: (id, ownerId) => {
    if (!mongoReady) return Promise.resolve(memorySprints.find((sprint) => sprintId(sprint) === String(id) && String(sprint.ownerId) === String(ownerId)));
    // A malformed id would otherwise throw a CastError and surface as a 500.
    return mongoose.isValidObjectId(id) ? Sprint.findOne({ _id: id, ownerId }).lean() : Promise.resolve(null);
  },
  create: async (data) => {
    if (mongoReady) return new Sprint(data).save();
    const sprint = withSprintId({ ...data, createdAt: new Date() });
    memorySprints = [...memorySprints, sprint];
    return sprint;
  },
  update: async (id, ownerId, data) => {
    if (mongoReady) return Sprint.findOneAndUpdate({ _id: id, ownerId }, { $set: data }, { new: true, runValidators: true }).lean();
    const current = await sprintStore.find(id, ownerId);
    if (!current) return null;
    memorySprints = memorySprints.map((sprint) => sprintId(sprint) === String(id) ? { ...sprint, ...data } : sprint);
    return sprintStore.find(id, ownerId);
  }
};

const boardStore = {
  list: (userId) => mongoReady
    ? Board.find({ $or: [{ ownerId: userId }, { memberIds: userId }] }).sort({ createdAt: 1 }).lean()
    : Promise.resolve(memoryBoards.filter((board) => String(board.ownerId) === String(userId) || (board.memberIds || []).includes(String(userId)))),
  // A well-formed-looking id that is not an ObjectId would otherwise throw a
  // CastError and surface as a 500 instead of a clean 404.
  find: (id) => {
    if (!mongoReady) return Promise.resolve(memoryBoards.find((board) => boardId(board) === String(id)));
    return mongoose.isValidObjectId(id) ? Board.findById(id).lean() : Promise.resolve(null);
  },
  create: async (data) => {
    if (mongoReady) return new Board(data).save();
    const board = { ...data, _id: `mem-board-${Date.now()}-${crypto.randomUUID()}`, createdAt: new Date() };
    memoryBoards = [...memoryBoards, board];
    return board;
  },
  update: async (id, data) => {
    if (mongoReady) {
      if (!mongoose.isValidObjectId(id)) return null;
      return Board.findByIdAndUpdate(id, { $set: data }, { new: true, runValidators: true }).lean();
    }
    const current = await boardStore.find(id);
    if (!current) return null;
    memoryBoards = memoryBoards.map((board) => boardId(board) === String(id) ? { ...board, ...data } : board);
    return boardStore.find(id);
  },
  remove: async (id) => {
    if (mongoReady) {
      if (!mongoose.isValidObjectId(id)) return { deletedCount: 0 };
      return Board.deleteOne({ _id: id });
    }
    const before = memoryBoards.length;
    memoryBoards = memoryBoards.filter((board) => boardId(board) !== String(id));
    return { deletedCount: before - memoryBoards.length };
  }
};

async function createDefaultBoard(user) {
  return boardStore.create({ ownerId: String(user._id), memberIds: [String(user._id)], name: `${user.name || 'My'}'s board` });
}

// A newly verified account gets its starter board exactly once. Seeding is
// deferred until verification so abandoned signups do not fill the database
// with boards and tasks.
async function ensureStarterWorkspace(user) {
  const existing = await boardStore.list(String(user._id));
  if (existing.length) return existing[0];
  const board = await createDefaultBoard(user);
  await seedStarterTasks(user, board);
  return board;
}

const CODE_EMAILS = {
  signup: {
    subject: 'Confirm your LeadAI email address',
    intro: 'Use this code to confirm your email and finish setting up your LeadAI workspace.'
  },
  login: {
    subject: 'Your LeadAI sign-in code',
    intro: 'Someone signed in to LeadAI from a browser we do not recognize. Use this code to continue.'
  },
  reset: {
    subject: 'Reset your LeadAI password',
    intro: 'Use this code to choose a new LeadAI password.'
  }
};

async function sendCodeEmail({ email, purpose, code }) {
  const copy = CODE_EMAILS[purpose] || CODE_EMAILS.login;
  const text = `${copy.intro}\n\n    ${code}\n\nThis code expires in 10 minutes. If you did not request it, you can ignore this email.`;
  return sendMail({ to: email, subject: copy.subject, text });
}

// Test suites that only need a session set AUTH_OTP_DISABLED=1. It is never a
// production default: unset means email verification is on.
const otpEnabled = () => process.env.AUTH_OTP_DISABLED !== '1';

function requestDevice(req) {
  return {
    id: normalizeDeviceId(req.body?.deviceId),
    label: String(req.body?.deviceLabel || req.get('user-agent') || '').slice(0, 120)
  };
}

async function startSessionFor(user) {
  const session = createAuthSession(user);
  if (mongoReady) await User.updateOne({ _id: user._id }, { $addToSet: { authSessions: session.token } });
  return session;
}

async function issueAuthChallenge(user, purpose) {
  const { challengeId, code } = await issueCode({ email: user.email, purpose });
  await sendCodeEmail({ email: user.email, purpose, code });
  return challengeId;
}

function otpResponse(user, purpose, challengeId) {
  return {
    otpRequired: true,
    purpose,
    challengeId,
    email: user.email,
    message: purpose === 'signup'
      ? 'Enter the 6-digit code to confirm your account.'
      : 'Enter the 6-digit code to finish signing in.'
  };
}

async function authorizedBoard(req, res, options = {}) {
  const id = String(req.params.id || '');
  if (!/^[a-zA-Z0-9_-]{8,}$/.test(id)) {
    res.status(400).json({ error: 'Invalid board id.' });
    return null;
  }
  const board = await boardStore.find(id);
  if (!board) { res.status(404).json({ error: 'Board not found.' }); return null; }
  const member = String(board.ownerId) === userId(req) || (board.memberIds || []).map(String).includes(userId(req));
  if (!member) { res.status(403).json({ error: 'You do not have access to this board.' }); return null; }
  if (options.ownerOnly && String(board.ownerId) !== userId(req)) {
    res.status(403).json({ error: 'Only the board owner may perform this action.' });
    return null;
  }
  return board;
}

async function defaultBoardFor(req) {
  const boards = await boardStore.list(userId(req));
  return boards[0] || null;
}

async function ensureDefaultSprint(ownerId) {
  const existing = await sprintStore.list(ownerId);
  if (existing.length) return existing[0];
  return sprintStore.create(seedSprint(ownerId));
}

function sprintView(sprint, tasks = []) {
  const progress = summarizeTasks(tasks);
  const current = computeSprintDay(sprint.startDate, sprint.endDate);
  return { ...sprint, id: sprintId(sprint), durationDays: 14, progress, current };
}

async function authorizedSprint(req, res) {
  const id = String(req.params.id || '');
  if (!/^[a-zA-Z0-9_-]{8,}$/.test(id)) {
    res.status(400).json({ error: 'Invalid sprint id.' });
    return null;
  }
  const sprint = await sprintStore.find(id, userId(req));
  if (!sprint) {
    res.status(404).json({ error: 'Sprint not found.' });
    return null;
  }
  return sprint;
}

const DASHBOARD_TASK_SCAN_LIMIT = 1000;

// Only the user's accessible boards are ever queried, and the aggregation returns
// counters instead of documents, so a large shared database is not loaded to show
// a handful of cards.
async function boardOpenTaskCounts(accessibleIds) {
  if (!accessibleIds.length) return new Map();
  if (mongoReady) {
    const rows = await Task.aggregate([
      { $match: { boardId: { $in: accessibleIds } } },
      {
        $group: {
          _id: '$boardId',
          total: { $sum: 1 },
          open: { $sum: { $cond: [{ $ne: ['$status', 'done'] }, 1, 0] } }
        }
      }
    ]);
    return new Map(rows.map((row) => [String(row._id), { total: row.total, open: row.open }]));
  }
  const counts = new Map(accessibleIds.map((id) => [id, { total: 0, open: 0 }]));
  for (const task of memoryTasks) {
    const entry = counts.get(String(task.boardId || ''));
    if (!entry) continue;
    entry.total += 1;
    if (isOpenTask(task)) entry.open += 1;
  }
  return counts;
}

async function assignedOpenTasks(accessibleIds, names) {
  if (!accessibleIds.length || !names.length) return [];
  if (mongoReady) {
    return Task.find({ boardId: { $in: accessibleIds }, assignee: { $in: names }, status: { $ne: 'done' } })
      .select('key title status priority dueDate createdAt boardId sprintId storyPoints assignee')
      .sort({ createdAt: 1 })
      .limit(DASHBOARD_TASK_SCAN_LIMIT)
      .lean();
  }
  return memoryTasks
    .filter((task) => accessibleIds.includes(String(task.boardId || '')) && names.includes(String(task.assignee || '')) && isOpenTask(task))
    .slice(0, DASHBOARD_TASK_SCAN_LIMIT);
}

async function assignedOpenTaskCounts(accessibleIds, names, today) {
  if (!accessibleIds.length || !names.length) return { open: 0, overdue: 0 };
  if (mongoReady) {
    const openQuery = { boardId: { $in: accessibleIds }, assignee: { $in: names }, status: { $ne: 'done' } };
    const [open, overdue] = await Promise.all([
      Task.countDocuments(openQuery),
      // dueDate is a real Date in the schema, so it is compared as a date, not
      // matched as text (a $regex against a Date field throws in MongoDB).
      Task.countDocuments({ ...openQuery, dueDate: { $ne: null, $lt: new Date(`${today}T00:00:00.000Z`) } })
    ]);
    return { open, overdue };
  }
  const mine = memoryTasks.filter((task) => accessibleIds.includes(String(task.boardId || '')) && names.includes(String(task.assignee || '')) && isOpenTask(task));
  return { open: mine.length, overdue: mine.filter((task) => isOverdueTask(task, today)).length };
}

async function buildDashboard(req) {
  const uid = userId(req);
  const user = req.user || {};
  const today = todayIsoDate();
  const boards = await boardStore.list(uid);
  const accessibleIds = boards.map((board) => boardId(board));
  const names = [user.name, user.email].map((value) => String(value || '').trim()).filter(Boolean);

  const [boardCounts, myTasks, myCounts, sprints] = await Promise.all([
    boardOpenTaskCounts(accessibleIds),
    assignedOpenTasks(accessibleIds, names),
    assignedOpenTaskCounts(accessibleIds, names, today),
    sprintStore.list(uid)
  ]);

  const boardById = new Map(boards.map((board) => [boardId(board), board]));
  const boardNameFor = (id) => boardById.get(String(id || ''))?.name || null;

  // No active sprint is created here: the dashboard is read-only, so opening it
  // never mutates sprint or task state.
  const activeSprints = activeSprintsOf(sprints, today);
  const active = activeSprints[0] || null;
  let activeSprint = null;
  if (active) {
    const sprintTasks = await store.listBySprint(sprintId(active));
    const view = sprintView(active, sprintTasks);
    const linkedBoard = (active.boardId ? boardById.get(String(active.boardId)) : null)
      || (sprintTasks[0]?.boardId ? boardById.get(String(sprintTasks[0].boardId)) : null);
    activeSprint = {
      id: view.id,
      name: view.name,
      goal: view.goal || '',
      startDate: view.startDate,
      endDate: view.endDate,
      durationDays: view.durationDays,
      boardId: linkedBoard ? boardId(linkedBoard) : null,
      boardName: linkedBoard?.name || null,
      current: view.current,
      // Reuse the exact sprint progress calculation used by Sprint Backlog.
      progress: view.progress,
      stages: stageCounts(sprintTasks)
    };
  }

  const updatedTime = (board) => {
    const time = new Date(board.updatedAt || board.createdAt || 0).getTime();
    return Number.isFinite(time) ? time : 0;
  };

  const boardCards = boards
    .map((board) => {
      const id = boardId(board);
      const counts = boardCounts.get(id) || { total: 0, open: 0 };
      const linkedSprint = activeSprints.find((sprint) => String(sprint.boardId || '') === id)
        || (active && activeSprint?.boardId === id ? active : null);
      return {
        id,
        name: String(board.name || 'Untitled board'),
        isOwner: String(board.ownerId) === uid,
        memberCount: (board.memberIds || []).length,
        openTasks: counts.open,
        totalTasks: counts.total,
        updatedAt: board.updatedAt || board.createdAt || null,
        activeSprint: linkedSprint ? {
          id: sprintId(linkedSprint),
          name: linkedSprint.name,
          endDate: linkedSprint.endDate
        } : null
      };
    })
    .sort((a, b) => updatedTime(b) - updatedTime(a) || a.name.localeCompare(b.name))
    .slice(0, BOARD_SUMMARY_LIMIT);

  const priorityTasks = orderDashboardTasks(myTasks.filter((task) => taskBelongsTo(task, names)), today)
    .slice(0, PRIORITY_TASK_LIMIT)
    .map((task) => ({
      key: String(task.key),
      title: String(task.title || ''),
      status: String(task.status || 'backlog'),
      priority: String(task.priority || 'medium'),
      dueDate: dueDateText(task.dueDate),
      assignee: String(task.assignee || 'Unassigned'),
      storyPoints: numberOf(task.storyPoints),
      boardId: String(task.boardId || ''),
      boardName: boardNameFor(task.boardId),
      sprintId: task.sprintId ? String(task.sprintId) : null,
      overdue: isOverdueTask(task, today)
    }));

  return {
    today,
    generatedAt: new Date().toISOString(),
    stats: {
      boards: boards.length,
      myOpenTasks: myCounts.open,
      overdueTasks: myCounts.overdue,
      activeSprints: activeSprints.length,
      sprintProgress: activeSprint ? activeSprint.progress.progressPercent : 0
    },
    boards: boardCards,
    priorityTasks,
    activeSprint,
    // Copilot is available when either the workspace key (env or Settings
    // override) or the member's personal key exists.
    ai: { configured: Boolean(getAllEffective().OPENROUTER_API_KEY?.trim()) || Boolean(await findUserAiKey(userId(req))) }
  };
}

// Date-only field: MongoDB hands back a Date, the board UI expects YYYY-MM-DD.
function taskView(task) {
  if (!task) return task;
  // A Mongoose document keeps its fields behind toObject(); spreading the
  // document directly would drop them from the response.
  const value = typeof task.toObject === 'function' ? task.toObject() : task;
  return { ...value, dueDate: dueDateText(value.dueDate) || null };
}

function userId(req) { return String(req.user._id); }
async function boardMembers(board) {
  const members = await Promise.all((board.memberIds || []).map((id) => findUserById(id)));
  return members.filter(Boolean).map((member) => ({
    id: String(member._id),
    name: String(member.name || member.email),
    email: String(member.email),
    skills: Array.isArray(member.skills) ? member.skills : []
  }));
}
function resolveBoardAssignee(value, members) {
  const requested = String(value || 'Unassigned').trim();
  if (!requested || requested.toLowerCase() === 'unassigned') return 'Unassigned';
  const match = members.find((member) => member.email.toLowerCase() === requested.toLowerCase()
    || member.name.toLowerCase() === requested.toLowerCase());
  if (!match) throw createAuthError(400, `Assignee "${requested}" is not a member of this board.`);
  return match.name;
}
async function canAccess(task, req) {
  if (req.role === 'admin' || String(task.ownerId) === userId(req)) return true;
  if (!task.boardId) return false;
  const board = await boardStore.find(task.boardId);
  return Boolean(board && ((board.memberIds || []).map(String).includes(userId(req)) || String(board.ownerId) === userId(req)));
}
async function authorizedTask(req, res) {
  if (!validTaskKey(req.params.key)) { res.status(400).json({ error: 'Invalid task key.' }); return null; }
  const task = await store.find(req.params.key);
  if (!task) { res.status(404).json({ error: 'Task not found.' }); return null; }
  if (!await canAccess(task, req)) { res.status(403).json({ error: 'You do not have access to this task.' }); return null; }
  return task;
}
function validateTaskInput(body, partial = false) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw createAuthError(400, 'Task data must be an object.');
  if (!partial && (!body.title || typeof body.title !== 'string' || !body.title.trim())) throw createAuthError(400, 'A task title is required.');
  if (body.title !== undefined && (typeof body.title !== 'string' || body.title.trim().length > 180)) throw createAuthError(400, 'Task title must be 1-180 characters.');
  if (body.description !== undefined && (typeof body.description !== 'string' || body.description.length > 4000)) throw createAuthError(400, 'Description must be text up to 4000 characters.');
  if (body.status !== undefined && !allowedStatuses.includes(body.status)) throw createAuthError(400, 'Invalid status.');
  if (body.priority !== undefined && !allowedPriorities.includes(body.priority)) throw createAuthError(400, 'Invalid priority.');
  if (body.labels !== undefined && (!Array.isArray(body.labels) || body.labels.length > 10 || body.labels.some((label) => typeof label !== 'string' || !label.trim() || label.length > 40))) throw createAuthError(400, 'Labels must be non-empty text values.');
  if (body.assignee !== undefined && (typeof body.assignee !== 'string' || body.assignee.trim().length > 120)) throw createAuthError(400, 'Assignee must be text up to 120 characters.');
  if (body.dueDate !== undefined && body.dueDate !== null && (typeof body.dueDate !== 'string' || body.dueDate.length > 40)) throw createAuthError(400, 'Due date must be text up to 40 characters.');
  if (body.sprintId !== undefined && (body.sprintId !== null && (typeof body.sprintId !== 'string' || !/^[a-zA-Z0-9_-]{8,}$/.test(body.sprintId)))) throw createAuthError(400, 'Invalid sprint id.');
  if (body.assigneeId !== undefined && (body.assigneeId !== null && (typeof body.assigneeId !== 'string' || !/^[a-zA-Z0-9_-]{8,}$/.test(body.assigneeId)))) throw createAuthError(400, 'Invalid assignee id.');
  if (body.storyPoints !== undefined && (!Number.isInteger(body.storyPoints) || body.storyPoints < 0 || body.storyPoints > 100)) throw createAuthError(400, 'Story points must be an integer from 0 to 100.');
  if (body.estimateHours !== undefined && (typeof body.estimateHours !== 'number' || !Number.isFinite(body.estimateHours) || body.estimateHours < 0 || body.estimateHours > 1000)) throw createAuthError(400, 'Estimate hours must be a number from 0 to 1000.');
}

// What a person can type into the due-date field. Relative words the API accepts
// are resolved here; legacy values ("Oct 18", "Unscheduled") stay in
// convertDueDate so the migration keeps its own, narrower contract.
function validTaskKey(key) { return typeof key === 'string' && /^KAN-[A-Z0-9]+$/i.test(key); }
function taskUpdates(body) {
  return Object.fromEntries(['title', 'description', 'status', 'priority', 'labels', 'assignee', 'assigneeId', 'dueDate', 'sprintId', 'storyPoints', 'estimateHours'].filter((field) => body[field] !== undefined).map((field) => [field, body[field]]));
}

async function writeTaskHistory(taskId, teamId, from, to, actorId, at) {
  if (!actorId) return;
  const entry = { taskId: String(taskId), teamId: teamId ? String(teamId) : null, from: from ?? null, to: String(to), actorId: String(actorId), at: at || new Date() };
  if (mongoReady) {
    await TaskHistory.create(entry);
  } else {
    memoryTaskHistory = [...memoryTaskHistory, { ...entry, _id: crypto.randomUUID(), createdAt: new Date(), updatedAt: new Date() }];
  }
}
function dependencyGraph(tasks) {
  const graph = new Map(tasks.map((task) => [task.key, (task.dependencies || []).map((dep) => dep.toTask)]));
  return graph;
}
function createsCycle(tasks, fromTask, toTask) {
  const graph = dependencyGraph(tasks);
  graph.set(fromTask, [...(graph.get(fromTask) || []), toTask]);
  const visiting = new Set();
  const visited = new Set();
  function visit(key) {
    if (visiting.has(key)) return true;
    if (visited.has(key)) return false;
    visiting.add(key);
    if ((graph.get(key) || []).some(visit)) return true;
    visiting.delete(key);
    visited.add(key);
    return false;
  }
  return visit(fromTask);
}
function blockedTask(task, tasks, seen = new Set()) {
  if (seen.has(task.key)) return false;
  seen.add(task.key);
  const byKey = new Map(tasks.map((item) => [item.key, item]));
  return (task.dependencies || []).some((dep) => {
    const prerequisite = byKey.get(dep.toTask);
    return prerequisite && (prerequisite.status !== 'done' || blockedTask(prerequisite, tasks, seen));
  });
}

const BIO_MAX = 300;
const AVATAR_MAX_BYTES = 80 * 1024;
const AVATAR_MAX_LENGTH = 110_000;

function profileView(user) {
  const value = serializeUser(user);
  return {
    _id: String(value._id),
    email: value.email,
    name: value.name || '',
    username: value.username || '',
    bio: value.bio || '',
    location: value.location || '',
    website: value.website || '',
    avatar: value.avatar || '',
    skills: Array.isArray(value.skills) ? value.skills : [],
    role: value.role || 'member',
    createdAt: value.createdAt || null,
    updatedAt: value.updatedAt || null
  };
}

function avatarIsValid(value) {
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return false;
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > AVATAR_MAX_BYTES) return false;
  const signature = bytes.subarray(0, 12).toString('hex');
  if (match[1] === 'png') return signature.startsWith('89504e47');
  if (match[1] === 'jpeg') return signature.startsWith('ffd8ff');
  return bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
}

// Whitelist only. Email, role, sessions and password hashes are never read from the body,
// so a manipulated profile request cannot change them.
function profileUpdates(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw createAuthError(400, 'Profile data must be an object.');
  const updates = {};
  if (body.name !== undefined) {
    if (typeof body.name !== 'string') throw createAuthError(400, 'Name must be text.');
    updates.name = body.name.trim();
    if (updates.name.length > 80) throw createAuthError(400, 'Name must be 80 characters or fewer.');
  }
  if (body.username !== undefined) {
    if (typeof body.username !== 'string') throw createAuthError(400, 'Username must be text.');
    updates.username = body.username.trim().toLowerCase();
    if (updates.username) updates.username = normalizeAndValidateUsername(updates.username);
  }
  if (body.bio !== undefined) {
    if (typeof body.bio !== 'string') throw createAuthError(400, 'Bio must be text.');
    updates.bio = body.bio.trim();
    if (updates.bio.length > BIO_MAX) throw createAuthError(400, `Bio must be ${BIO_MAX} characters or fewer.`);
  }
  if (body.location !== undefined) {
    if (typeof body.location !== 'string') throw createAuthError(400, 'Location must be text.');
    updates.location = body.location.trim();
    if (updates.location.length > 80) throw createAuthError(400, 'Location must be 80 characters or fewer.');
  }
  if (body.website !== undefined) {
    if (typeof body.website !== 'string') throw createAuthError(400, 'Website must be text.');
    updates.website = body.website.trim();
    if (updates.website.length > 200) throw createAuthError(400, 'Website must be 200 characters or fewer.');
    if (updates.website) {
      let parsed;
      try { parsed = new URL(updates.website); } catch { throw createAuthError(400, 'Website must be a full URL starting with http:// or https://.'); }
      if (!['http:', 'https:'].includes(parsed.protocol)) throw createAuthError(400, 'Website must start with http:// or https://.');
    }
  }
  if (body.avatar !== undefined) {
    if (typeof body.avatar !== 'string') throw createAuthError(400, 'Avatar must be an image.');
    updates.avatar = body.avatar;
    if (updates.avatar && (updates.avatar.length > AVATAR_MAX_LENGTH || !avatarIsValid(updates.avatar))) {
      throw createAuthError(400, 'Avatar must be a PNG, JPEG, or WebP image of 80 KB or less.');
    }
  }
  if (body.skills !== undefined) {
    if (!Array.isArray(body.skills) || body.skills.length > 20 || body.skills.some((skill) => typeof skill !== 'string' || !skill.trim() || skill.trim().length > 50)) {
      throw createAuthError(400, 'Skills must be an array of up to 20 non-empty strings, each 50 characters or fewer.');
    }
    updates.skills = body.skills.map((skill) => skill.trim()).filter(Boolean);
  }
  return updates;
}

async function profilePayload(user) {
  const ownerId = String(user._id);
  const [tasks, sprints] = await Promise.all([store.listByOwner(ownerId), sprintStore.list(ownerId)]);
  const currentSprint = sprints[0] || null;
  const sprintTasks = currentSprint ? tasks.filter((task) => String(task.sprintId) === sprintId(currentSprint)) : [];
  return {
    profile: profileView(user),
    stats: {
      totalTasks: tasks.length,
      openTasks: tasks.filter((task) => task.status !== 'done').length,
      completedTasks: tasks.filter((task) => task.status === 'done').length,
      inProgressTasks: tasks.filter((task) => task.status === 'progress').length,
      sprints: sprints.length
    },
    recentTasks: [...tasks]
      .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0))
      .slice(0, 5)
      .map((task) => ({ key: task.key, title: task.title, status: task.status, priority: task.priority, updatedAt: task.updatedAt || task.createdAt || null })),
    sprint: currentSprint ? {
      id: sprintId(currentSprint),
      name: currentSprint.name,
      startDate: currentSprint.startDate,
      endDate: currentSprint.endDate,
      progress: summarizeTasks(sprintTasks),
      current: computeSprintDay(currentSprint.startDate, currentSprint.endDate)
    } : null
  };
}

async function currentProfileUser(req) {
  if (!mongoReady) return memoryUsers.get(req.user.email) || req.user;
  return await User.findById(req.user._id);
}

app.get('/api/profile', requireAuth, async (req, res, next) => {
  try {
    const user = await currentProfileUser(req);
    if (!user) return res.status(401).json({ error: 'Session expired or invalid.' });
    res.setHeader('Cache-Control', 'no-store');
    res.json(await profilePayload(user));
  } catch (error) { next(error); }
});

app.patch('/api/profile', requireAuth, async (req, res, next) => {
  try {
    const updates = profileUpdates(req.body || {});
    let user;
    if (mongoReady) {
      if (updates.username) {
        const taken = await User.findOne({ username: updates.username, _id: { $ne: req.user._id } }).select('_id');
        if (taken) throw createAuthError(409, 'That username is already taken.');
      }
      const set = {};
      const unset = {};
      for (const [field, value] of Object.entries(updates)) {
        if (field === 'username' && !value) unset.username = '';
        else set[field] = value;
      }
      try {
        user = await User.findByIdAndUpdate(req.user._id, {
          ...(Object.keys(set).length ? { $set: set } : {}),
          ...(Object.keys(unset).length ? { $unset: unset } : {})
        }, { returnDocument: 'after', runValidators: true });
      } catch (error) {
        if (error?.code === 11000) throw createAuthError(409, 'That username is already taken.');
        throw error;
      }
      if (!user) return res.status(401).json({ error: 'Session expired or invalid.' });
    } else {
      user = memoryUsers.get(req.user.email);
      if (!user) return res.status(401).json({ error: 'Session expired or invalid.' });
      if (updates.username) {
        const taken = [...memoryUsers.values()].some((other) => String(other._id) !== String(user._id) && other.username === updates.username);
        if (taken) throw createAuthError(409, 'That username is already taken.');
      }
      Object.assign(user, updates);
      if ('username' in updates && !updates.username) delete user.username;
    }
    refreshSessionUser(user);
    res.setHeader('Cache-Control', 'no-store');
    res.json(await profilePayload(user));
  } catch (error) { next(error); }
});

app.get('/api/health', (_req, res) => {
  const status = databaseStatus();
  const ok = status.mode === 'memory' ? true : status.ready;
  res.status(ok ? 200 : 503).json({ ok, database: status.mode, db: status.name });
});
app.get('/api/dashboard/summary', requireAuth, async (req, res, next) => {
  try { res.json(await buildDashboard(req)); } catch (error) { next(error); }
});

// Server configuration is operator data. Members may see whether it is
// configured; only an admin can change it. Secrets are never returned, so a
// compromised member session cannot exfiltrate the database URI or AI key.
function settingsView(canEdit, personalKeyConfigured = false) {
  const effective = getAllEffective();
  const uri = String(effective.MONGODB_URI || '');
  const key = String(effective.OPENROUTER_API_KEY || '');
  return {
    canEdit,
    // Whether the server is configured is useful to everyone (it explains why
    // Copilot is offline). The host, database name and key hint are
    // infrastructure detail and stay with administrators.
    mongodbConfigured: Boolean(uri),
    mongodbDatabase: canEdit ? /^mongodb(?:\+srv)?:\/\/[^/]*\/([^?]+)/.exec(uri)?.[1] || null : null,
    mongodbHost: canEdit ? /^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)/.exec(uri)?.[1] || null : null,
    openrouterConfigured: Boolean(key),
    openrouterKeyHint: canEdit && key ? `••••${key.slice(-4)}` : '',
    openrouterModel: effective.OPENROUTER_MODEL || '',
    // The member's own key (if any) explains why Copilot works for them even
    // when the workspace has no key. Only its presence is shared, never a hint.
    personalKeyConfigured
  };
}

app.get('/api/settings/env', requireAuth, async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json(settingsView(req.role === 'admin', Boolean(await findUserAiKey(userId(req)))));
  } catch (error) { next(error); }
});

// Personal AI key: any signed-in member may store their own OpenRouter key.
// It is used only when the workspace has no key, is never returned to the
// browser (only a hint), and can be cleared by sending an empty value.
const AI_KEY_MAX_LENGTH = 256;

app.get('/api/settings/user-key', requireAuth, async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    const key = await findUserAiKey(userId(req));
    res.json({
      configured: Boolean(key),
      keyHint: key ? `••••${key.slice(-4)}` : '',
      // A workspace key always wins; say so, so members are not confused about
      // why their personal key seems ignored.
      workspaceKeyConfigured: Boolean(getAllEffective().OPENROUTER_API_KEY)
    });
  } catch (error) { next(error); }
});

app.put('/api/settings/user-key', requireAuth, async (req, res, next) => {
  try {
    const raw = req.body?.openrouterApiKey;
    if (raw !== undefined && typeof raw !== 'string') {
      return res.status(400).json({ error: 'openrouterApiKey must be a string.' });
    }
    const key = String(raw || '').trim();
    if (key.length > AI_KEY_MAX_LENGTH) {
      return res.status(400).json({ error: `API key must be ${AI_KEY_MAX_LENGTH} characters or fewer.` });
    }
    await updateUserAiKey(userId(req), key);
    res.json({
      saved: true,
      configured: Boolean(key),
      keyHint: key ? `••••${key.slice(-4)}` : '',
      workspaceKeyConfigured: Boolean(getAllEffective().OPENROUTER_API_KEY)
    });
  } catch (error) { next(error); }
});

app.post('/api/settings/env', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const { mongodbUri, openrouterApiKey, openrouterModel } = req.body || {};
    const updates = {};
    if (mongodbUri !== undefined) updates.MONGODB_URI = String(mongodbUri || '').trim();
    if (openrouterApiKey !== undefined) updates.OPENROUTER_API_KEY = String(openrouterApiKey || '').trim();
    if (openrouterModel !== undefined) updates.OPENROUTER_MODEL = String(openrouterModel || '').trim();

    const uriChanged = updates.MONGODB_URI !== undefined && updates.MONGODB_URI !== getAllEffective().MONGODB_URI;

    // Validate Mongo URI scheme before persisting an override.
    if (updates.MONGODB_URI !== undefined && updates.MONGODB_URI !== '') {
      if (!/^mongodb(\+srv)?:\/\//.test(updates.MONGODB_URI)) {
        return res.status(400).json({ error: 'MONGODB_URI must start with mongodb:// or mongodb+srv://.' });
      }
      const name = /^mongodb(?:\+srv)?:\/\/[^/]*\/([^?]+)/.exec(updates.MONGODB_URI);
      if (!name || !name[1]) {
        return res.status(400).json({ error: 'MONGODB_URI must name a database, e.g. mongodb://127.0.0.1:27017/leadai_dev.' });
      }
    }

    for (const [key, value] of Object.entries(updates)) {
      if (value === '') removeOverride(key);
      else setOverride(key, value);
    }

    // If the database URI changed, reconnect live without restarting. Revert
    // the override if the new URI cannot connect, keeping the server running.
    if (uriChanged) {
      try {
        const status = await reconnectDatabase();
        // Keep the request-time store in sync with the connection that just opened.
        mongoReady = status.mode === 'mongodb';
        setDatabaseReady(mongoReady);
      } catch (error) {
        removeOverride('MONGODB_URI');
        return res.status(400).json({ error: `Could not connect to MongoDB: ${error.message}. Override reverted.` });
      }
    }

    res.json({ saved: true, ...settingsView(true) });
  } catch (error) { next(error); }
});

app.get('/api/auth/username-available', async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    const username = normalizeAndValidateUsername(req.query?.username);
    // Informational only. The unique index and createUser() remain the
    // authority; this endpoint exists so the wizard can warn early.
    res.json({ username, available: !(await isUsernameTaken(username)) });
  } catch (error) { next(error); }
});

app.post('/api/auth/signup', async (req, res, next) => {
  try {
    if (!otpEnabled()) {
      const legacyUser = await createUser(req.body || {});
      const board = await createDefaultBoard(legacyUser);
      await seedStarterTasks(legacyUser, board);
      return res.status(201).json(legacyUser);
    }
    const user = await createUser({ ...(req.body || {}), emailVerified: false });
    let challengeId;
    try {
      // A signup code is the same single-use, hashed, attempt-limited record
      // used by sign-in. No session exists until the code is verified.
      const issued = await issueCode({ email: user.email, purpose: 'signup' });
      challengeId = issued.challengeId;
      await sendCodeEmail({ email: user.email, purpose: 'signup', code: issued.code });
    } catch (error) {
      // Never leave an account nobody can verify behind when its email could
      // not be sent.
      if (challengeId) await discardCode(challengeId).catch(() => {});
      if (mongoReady) await User.deleteOne({ _id: user._id, emailVerified: false });
      else memoryUsers.delete(user.email);
      if (isAuthError(error)) throw error;
      console.error('Signup verification email failed:', error.message);
      throw createAuthError(503, 'We could not send the verification email. Check the mail settings and try again.');
    }
    return res.status(201).json({
      otpRequired: true,
      purpose: 'signup',
      challengeId,
      email: user.email,
      message: 'Enter the 6-digit code to confirm your account.'
    });
  } catch (error) { next(error); }
});
app.post('/api/auth/signin', async (req, res, next) => {
  try {
    const user = await authenticateUser(req.body || {});
    // No session is issued until the email address is confirmed. This check is
    // server-side on every sign-in, never trusted from the frontend.
    if (!isEmailVerified(user)) {
      // The password was correct, so it is safe to reveal that this account
      // exists and to offer a fresh signup code. Reuse a live challenge rather
      // than sending a second email within the cooldown.
      let challengeId;
      try {
        const active = await findActiveChallenge({ email: user.email, purpose: 'signup' });
        challengeId = active?.challengeId || await issueAuthChallenge(user, 'signup');
      } catch (error) {
        if (isAuthError(error)) throw error;
        console.error('Signup verification email failed:', error.message);
        throw createAuthError(503, 'We could not send the confirmation code. Check the mail settings and try again.');
      }
      return res.status(403).json({
        code: 'EMAIL_NOT_VERIFIED',
        otpRequired: true,
        purpose: 'signup',
        challengeId,
        email: user.email,
        error: 'Confirm your email address before signing in. Enter the 6-digit code for this account.'
      });
    }
    if (otpEnabled()) {
      const device = requestDevice(req);
      const purpose = !device.id || !isTrustedDevice(user, device.id) ? 'login' : null;
      if (purpose) {
        // A code may already be in flight. Reuse it rather than replying with
        // the resend cooldown.
        const active = await findActiveChallenge({ email: user.email, purpose });
        if (active) return res.json(otpResponse(user, purpose, active.challengeId));
        let challengeId;
        try {
          challengeId = await issueAuthChallenge(user, purpose);
        } catch (error) {
          if (isAuthError(error)) throw error;
          console.error('Sign-in code email failed:', error.message);
          throw createAuthError(503, 'We could not send the sign-in code. Check the mail server settings and try again.');
        }
        return res.json(otpResponse(user, purpose, challengeId));
      }
    }
    res.json(await startSessionFor(user));
  } catch (error) { next(error); }
});
app.post('/api/auth/otp/verify', async (req, res, next) => {
  try {
    const record = await verifyCode({
      challengeId: req.body?.challengeId, code: req.body?.code, purposes: ['signup', 'login']
    });
    const user = await findUserByEmail(record.email);
    if (!user) return res.status(400).json({ error: 'This code is no longer valid. Request a new one.' });
    if (record.purpose === 'signup') {
      if (!isEmailVerified(user)) await markEmailVerified(user);
      await ensureStarterWorkspace(user);
    }
    const device = requestDevice(req);
    if (device.id) await trustDevice(user, device.id, device.label);
    res.json(await startSessionFor(user));
  } catch (error) { next(error); }
});
app.post('/api/auth/otp/resend', async (req, res, next) => {
  try {
    const previous = await findCodeByChallenge(req.body?.challengeId);
    if (!previous || previous.purpose === 'reset') return res.status(400).json({ error: 'Request a new code from the sign-in screen.' });
    const user = await findUserByEmail(previous.email);
    if (!user) return res.status(400).json({ error: 'This code is no longer valid. Sign in again.' });
    let challengeId;
    try {
      // The previous code still exists here, so the one-minute cooldown applies.
      challengeId = await issueAuthChallenge(user, previous.purpose);
    } catch (error) {
      if (isAuthError(error)) throw error;
      console.error('Verification email failed:', error.message);
      throw createAuthError(503, 'We could not send the email. Check the mail settings and try again.');
    }
    await discardCode(previous.challengeId);
    res.json({ ok: true, challengeId });
  } catch (error) { next(error); }
});
app.post('/api/auth/signout', requireAuth, async (req, res, next) => {
  try { await invalidateSession(req.authToken); res.json({ ok: true }); } catch (error) { next(error); }
});
app.get('/api/auth/current', requireAuth, (req, res) => res.json(req.user));

app.get('/api/boards', requireAuth, async (req, res, next) => {
  try {
    const boards = await boardStore.list(userId(req));
    res.json(await Promise.all(boards.map(async (board) => ({
      ...board,
      id: boardId(board),
      isOwner: String(board.ownerId) === userId(req),
      memberIds: (board.memberIds || []).map(String),
      members: await boardMembers(board)
    }))));
  } catch (error) { next(error); }
});
app.post('/api/boards', requireAuth, async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name || name.length > 120) return res.status(400).json({ error: 'Board name must be between 1 and 120 characters.' });
    const board = await boardStore.create({ ownerId: userId(req), memberIds: [userId(req)], name });
    res.status(201).json({ ...board, id: boardId(board), isOwner: true });
  } catch (error) { next(error); }
});
app.patch('/api/boards/:id', requireAuth, async (req, res, next) => {
  try {
    const board = await authorizedBoard(req, res, { ownerOnly: true });
    if (!board) return;
    const name = String(req.body?.name || '').trim();
    if (!name || name.length > 120) return res.status(400).json({ error: 'Board name must be between 1 and 120 characters.' });
    const updated = await boardStore.update(boardId(board), { name });
    res.json({ ...updated, id: boardId(updated), isOwner: true });
  } catch (error) { next(error); }
});
app.delete('/api/boards/:id', requireAuth, async (req, res, next) => {
  try {
    const board = await authorizedBoard(req, res, { ownerOnly: true });
    if (!board) return;
    const result = await boardStore.remove(boardId(board));
    if (mongoReady) await Task.deleteMany({ boardId: boardId(board) });
    else memoryTasks = memoryTasks.filter((task) => String(task.boardId) !== boardId(board));
    res.json({ ok: result.deletedCount === 1 });
  } catch (error) { next(error); }
});
app.post('/api/boards/:id/members', requireAuth, async (req, res, next) => {
  try {
    const board = await authorizedBoard(req, res, { ownerOnly: true });
    if (!board) return;
    const email = String(req.body?.email || '').trim().toLowerCase();
    const member = await findUserByEmail(email);
    if (!member) return res.status(404).json({ error: 'No account was found for that email.' });
    const memberId = String(member._id);
    const memberIds = [...new Set([...(board.memberIds || []).map(String), memberId])];
    const updated = await boardStore.update(boardId(board), { memberIds });
    res.status(201).json({ ...updated, id: boardId(updated), isOwner: true });
  } catch (error) { next(error); }
});
app.delete('/api/boards/:id/members/:memberId', requireAuth, async (req, res, next) => {
  try {
    const board = await authorizedBoard(req, res, { ownerOnly: true });
    if (!board) return;
    if (String(req.params.memberId) === userId(req)) return res.status(400).json({ error: 'The board owner cannot be removed.' });
    const updated = await boardStore.update(boardId(board), { memberIds: (board.memberIds || []).map(String).filter((id) => id !== String(req.params.memberId)) });
    res.json({ ...updated, id: boardId(updated), isOwner: true });
  } catch (error) { next(error); }
});
app.post('/api/auth/reset-password/request', async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    // Unknown addresses get a challenge too, so the response cannot be used to
    // discover which emails have accounts.
    const { challengeId, code } = await issueCode({ email, purpose: 'reset' });
    const user = await findUserByEmail(email);
    if (user) {
      try {
        await sendCodeEmail({ email, purpose: 'reset', code });
      } catch (error) {
        console.error('Password reset email failed:', error.message);
        return res.status(503).json({ error: 'We could not send the reset email. Check the mail server settings and try again.' });
      }
    }
    res.json({
      ok: true,
      challengeId,
      message: 'If an account exists for that email, a 6-digit code has been generated. It expires in 10 minutes.'
    });
  } catch (error) { next(error); }
});
app.post('/api/auth/reset-password/confirm', async (req, res, next) => {
  try {
    const { challengeId, code, password } = req.body || {};
    validatePassword(password);
    const record = await verifyCode({ challengeId, code, purposes: ['reset'] });
    const user = await findUserByEmail(record.email);
    if (!user) return res.status(400).json({ error: 'This code is no longer valid. Request a new one.' });
    const passwordHash = await hashPassword(password);
    // A reset code proves control of the mailbox, so the address counts as
    // verified. Every session and remembered device is revoked: the next
    // sign-in asks for a code again.
    if (mongoReady) {
      await User.updateOne({ _id: user._id }, { $set: { passwordHash, authSessions: [], trustedDevices: [], emailVerified: true } });
    } else {
      memoryUsers.set(user.email, { ...(memoryUsers.get(user.email) || user), passwordHash, trustedDevices: [], emailVerified: true });
    }
    await revokeAllSessionsForUser(user._id);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.get('/api/sprints', requireAuth, async (req, res, next) => {
  try {
    await ensureDefaultSprint(userId(req));
    const sprints = await sprintStore.list(userId(req));
    res.json(await Promise.all(sprints.map(async (sprint) => sprintView(sprint, await store.listBySprint(sprintId(sprint))))));
  } catch (error) { next(error); }
});
app.post('/api/sprints', requireAuth, async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim();
    const goal = String(req.body?.goal || '').trim();
    const startDate = String(req.body?.startDate || todayIsoDate());
    if (!name || name.length > 120) return res.status(400).json({ error: 'Sprint name must be between 1 and 120 characters.' });
    if (goal.length > 1000) return res.status(400).json({ error: 'Sprint goal must be 1000 characters or fewer.' });
    const endDate = String(req.body?.endDate || endDateForStart(startDate));
    const dateValidation = validateSprintRange(startDate, endDate);
    if (!dateValidation.ok) return res.status(400).json({ error: dateValidation.error });
    res.status(201).json(sprintView(await sprintStore.create({ ownerId: userId(req), name, goal, startDate, endDate }), []));
  } catch (error) { next(error); }
});
app.get('/api/sprints/:id', requireAuth, async (req, res, next) => {
  try {
    const sprint = await authorizedSprint(req, res);
    if (!sprint) return;
    res.json(sprintView(sprint, await store.listBySprint(sprintId(sprint))));
  } catch (error) { next(error); }
});
app.patch('/api/sprints/:id', requireAuth, async (req, res, next) => {
  try {
    const sprint = await authorizedSprint(req, res);
    if (!sprint) return;
    const updates = {};
    if (req.body?.name !== undefined) {
      updates.name = String(req.body.name).trim();
      if (!updates.name || updates.name.length > 120) return res.status(400).json({ error: 'Sprint name must be between 1 and 120 characters.' });
    }
    if (req.body?.goal !== undefined) {
      updates.goal = String(req.body.goal).trim();
      if (updates.goal.length > 1000) return res.status(400).json({ error: 'Sprint goal must be 1000 characters or fewer.' });
    }
    const startDate = req.body?.startDate ?? sprint.startDate;
    const endDate = req.body?.endDate ?? sprint.endDate;
    const dateValidation = validateSprintRange(startDate, endDate);
    if (!dateValidation.ok) return res.status(400).json({ error: dateValidation.error });
    updates.startDate = startDate; updates.endDate = endDate;
    const updated = await sprintStore.update(sprintId(sprint), userId(req), updates);
    res.json(sprintView(updated, await store.listBySprint(sprintId(updated))));
  } catch (error) { next(error); }
});
app.get('/api/sprints/:id/tasks', requireAuth, async (req, res, next) => {
  try {
    const sprint = await authorizedSprint(req, res);
    if (!sprint) return;
    // Authorized sprints are owner-scoped, so their tasks are the owner's too.
    res.json((await store.listBySprint(sprintId(sprint))).map(taskView));
  } catch (error) { next(error); }
});
app.get('/api/backlog', requireAuth, async (req, res, next) => {
  try {
    // Sprints are owner-scoped, so an owner-scoped query is what keeps the Product
    // Backlog consistent with the sprint list (and avoids loading other developers' rows).
    // Owner-scoped query: every returned task already belongs to the caller, so
    // no per-task access check (and no extra query per row) is needed.
    res.json(sortBacklog(await store.listWithoutSprint(userId(req))).map(taskView));
  } catch (error) { next(error); }
});
app.post('/api/sprints/:id/tasks', requireAuth, async (req, res, next) => {
  try {
    const sprint = await authorizedSprint(req, res);
    if (!sprint) return;
    const key = String(req.body?.key || '');
    const task = await store.find(key);
    if (!task || !(await canAccess(task, req))) return res.status(404).json({ error: 'Task not found.' });
    const blocked = sprintAcceptsBacklogItem(sprint, task);
    if (blocked) return res.status(409).json({ error: blocked });
    // Entering a sprint always lands in To Do, never in a later stage.
    const updated = await store.update(key, { sprintId: sprintId(sprint), status: SPRINT_ENTRY_STATUS });
    res.status(201).json(taskView(updated));
  } catch (error) { next(error); }
});
app.delete('/api/sprints/:id/tasks/:key', requireAuth, async (req, res, next) => {
  try {
    const sprint = await authorizedSprint(req, res);
    if (!sprint) return;
    const task = await store.find(req.params.key);
    if (!task || !(await canAccess(task, req)) || String(task.sprintId) !== sprintId(sprint)) return res.status(404).json({ error: 'Task not found in sprint.' });
    const blocked = taskCanReturnToBacklog(task);
    if (blocked) return res.status(409).json({ error: blocked });
    // Only the sprint assignment is removed; the task record itself is preserved.
    await store.update(task.key, { sprintId: null, status: BACKLOG_STATUS });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.get('/api/tasks', requireAuth, async (req, res, next) => {
  try {
    const board = req.query.boardId ? await authorizedBoard({ ...req, params: { id: req.query.boardId } }, res) : await defaultBoardFor(req);
    // authorizedBoard has already answered for a missing or forbidden board.
    if (!board) { if (!res.headersSent) res.json([]); return; }
    // Query this board's tasks directly. The previous version loaded every task
    // in the database and then re-checked access per task (an N+1 query storm
    // and a full collection scan on a shared database).
    res.json((await store.listByBoard(boardId(board))).map(taskView));
  } catch (error) { next(error); }
});
app.post('/api/tasks', requireAuth, async (req, res, next) => {
  try {
    validateTaskInput(req.body || {});
    const board = req.body.boardId ? await authorizedBoard({ ...req, params: { id: req.body.boardId } }, res) : await defaultBoardFor(req);
    if (!board) {
      if (!res.headersSent) res.status(404).json({ error: 'Create a board before adding tasks.' });
      return;
    }
    let sprint = null;
    if (req.body.sprintId) {
      sprint = await sprintStore.find(req.body.sprintId, userId(req));
      if (!sprint) return res.status(404).json({ error: 'Sprint not found.' });
      const blocked = sprintAcceptsBacklogItem(sprint, { sprintId: null, ownerId: userId(req), boardId: boardId(board) });
      if (blocked) return res.status(409).json({ error: blocked });
    }
    if (req.body.assigneeId !== undefined && req.body.assigneeId !== null && String(req.body.assigneeId) !== userId(req)) {
      return res.status(400).json({ error: 'You can only assign tasks to yourself.' });
    }
    const dueRaw = String(req.body.dueDate || '').trim();
    const due = normalizeDueDate(dueRaw);
    if (due.reason) throw createAuthError(400, `Due date "${dueRaw}" could not be understood. Use a date like 2026-10-24, or Today, Tomorrow, This week, Unscheduled.`);
    const dueDateValue = due.date ? due.date.toISOString().slice(0, 10) : null;
    const key = await newTaskKey();
    const task = await store.create({
      key, ownerId: userId(req), boardId: boardId(board), title: req.body.title.trim(), description: (req.body.description || '').slice(0, 4000),
      status: sprint ? SPRINT_ENTRY_STATUS : req.body.status || BACKLOG_STATUS, priority: req.body.priority || 'medium',
      labels: [...new Set(req.body.labels || [])], assignee: req.body.assignee ? String(req.body.assignee).trim().slice(0, 120) : (req.body.assigneeId && String(req.body.assigneeId) === String(userId(req)) ? String(req.user?.name || '').slice(0, 120) || 'Unassigned' : 'Unassigned'),
      assigneeId: req.body.assigneeId || null,
      dueDate: dueDateValue, sprintId: sprint ? sprintId(sprint) : null, storyPoints: req.body.storyPoints || 0, estimateHours: Math.max(0, Math.min(1000, Number(req.body.estimateHours) || 0)),
      comments: [], attachments: [], dependencies: []
    });
    const now = new Date();
    const teamId = sprint ? sprintId(sprint) : null;
    await writeTaskHistory(task._id, teamId, null, task.status, userId(req), now);
    // Domain events are emitted only after the task and its history entry are
    // persisted, so a failed write can never produce a success event.
    emitTaskCreated({ task, actorId: userId(req), teamId, at: now });
    if (task.assigneeId) emitTaskAssigned({ task, previousAssigneeId: null, actorId: userId(req), at: now });
    res.status(201).json(taskView(task));
  } catch (error) { next(error); }
});
app.patch('/api/tasks/:key', requireAuth, async (req, res, next) => {
  try {
    const task = await authorizedTask(req, res);
    if (!task) return;
    validateTaskInput(req.body || {}, true);
    if (req.body.sprintId !== undefined && String(req.body.sprintId ?? '') !== String(task.sprintId ?? '')) {
      // Sprint assignment is a validated transition, not a generic field edit: going
      // through one endpoint keeps "enter only via To Do" and the active-sprint checks intact.
      return res.status(409).json({ error: 'Use the sprint backlog to move a task between the Product Backlog and a sprint.' });
    }
    const updates = taskUpdates(req.body);
    delete updates.sprintId;
    if (updates.assigneeId !== undefined && updates.assigneeId !== null && String(updates.assigneeId) !== String(userId(req))) {
      return res.status(400).json({ error: 'You can only assign tasks to yourself.' });
    }
    if (updates.dueDate !== undefined) {
      const converted = normalizeDueDate(updates.dueDate);
      if (converted.reason) throw createAuthError(400, `Due date "${updates.dueDate}" could not be understood. Use a date like 2026-10-24, or Today, Tomorrow, This week, Unscheduled.`);
      updates.dueDate = converted.date ? converted.date.toISOString().slice(0, 10) : null;
    }
    // Clearing the assignee must also clear the display name, or the card keeps
    // showing whoever used to own it.
    if (updates.assigneeId === null) updates.assignee = 'Unassigned';
    if (updates.estimateHours !== undefined) {
      updates.estimateHours = Math.max(0, Math.min(1000, Number(updates.estimateHours) || 0));
    }
    if (updates.status !== undefined && task.sprintId && !isPermittedSprintStatusChange(task.status, updates.status)) {
      return res.status(409).json({
        error: `A sprint task cannot move directly from ${statusLabel(task.status)} to ${statusLabel(updates.status)}.`
      });
    }
    if (updates.title !== undefined) updates.title = updates.title.trim();
    if (updates.assignee !== undefined) updates.assignee = updates.assignee.trim() || 'Unassigned';
    if (updates.labels) updates.labels = [...new Set(updates.labels)];
    const previousStatus = task.status;
    const previousAssigneeId = task.assigneeId ?? null;
    let statusChangedAt = null;
    if (updates.status !== undefined && updates.status !== previousStatus) {
      const now = new Date();
      // Only the lifecycle fields are needed; spreading a Mongoose document
      // would drop the persisted timestamps and reset startedAt on every move.
      const lifecycle = applyStatusLifecycle({ startedAt: task.startedAt, completedAt: task.completedAt }, updates.status, now);
      if (lifecycle.startedAt !== task.startedAt) updates.startedAt = lifecycle.startedAt;
      if (lifecycle.completedAt !== task.completedAt) updates.completedAt = lifecycle.completedAt;
      updates.updatedAt = lifecycle.updatedAt;
      statusChangedAt = lifecycle.updatedAt;
      await writeTaskHistory(task._id, task.sprintId, previousStatus, updates.status, userId(req), now);
    }
    const updated = await store.update(task.key, updates);
    // Emit from persisted state, after the write: no-op edits and failed
    // validations never produce events.
    if (statusChangedAt) {
      emitTaskStatusChanged({
        task: updated, from: previousStatus, to: updated.status,
        actorId: userId(req), teamId: updated.sprintId ?? null, at: statusChangedAt
      });
    }
    if (updates.assigneeId !== undefined) {
      emitTaskAssigned({
        task: updated, previousAssigneeId, actorId: userId(req), at: new Date()
      });
    }
    res.json(taskView(updated));
  } catch (error) { next(error); }
});
app.delete('/api/tasks/:key', requireAuth, async (req, res, next) => {
  try {
    if (!await authorizedTask(req, res)) return;
    const result = await store.remove(req.params.key);
    res.json({ ok: result.deletedCount === 1 });
  } catch (error) { next(error); }
});

app.get('/api/tasks/:key/history', requireAuth, async (req, res, next) => {
  try {
    const task = await authorizedTask(req, res);
    if (!task) return;
    const history = mongoReady
      ? await TaskHistory.find({ taskId: task._id }).sort({ at: 1 }).lean()
      : memoryTaskHistory.filter((h) => h.taskId === String(task._id)).sort((a, b) => new Date(a.at) - new Date(b.at));
    res.json(history.map((h) => ({ from: h.from, to: h.to, actorId: h.actorId, at: h.at })));
  } catch (error) { next(error); }
});

// One-off, idempotent backfill of legacy free-text due dates and assignee names.
// Destructive collection-level operations stay out of the request handlers, and
// only an admin may trigger it.
app.post('/api/admin/migrate-tasks', requireAuth, requireRole('admin'), async (_req, res, next) => {
  try { res.json(await migrateLegacyFields()); } catch (error) { next(error); }
});

app.delete('/api/tasks/:key/history', requireAuth, async (req, res, next) => {
  try {
    const task = await authorizedTask(req, res);
    if (!task) return;
    if (req.role !== 'admin') return res.status(403).json({ error: 'Only admins can clear history.' });
    if (mongoReady) {
      await TaskHistory.deleteMany({ taskId: task._id });
    } else {
      memoryTaskHistory = memoryTaskHistory.filter((h) => h.taskId !== String(task._id));
    }
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.get('/api/teams/:id/history', requireAuth, async (req, res, next) => {
  try {
    const id = String(req.params.id || '');
    if (!/^[a-zA-Z0-9_-]{8,}$/.test(id)) {
      return res.status(400).json({ error: 'Invalid team id.' });
    }
    // Sprint ids double as team ids in this schema, so ownership of the sprint is
    // the membership check. Without it any signed-in user could read another
    // team's task audit trail by guessing an id.
    const sprint = await sprintStore.find(id, userId(req));
    if (!sprint) return res.status(404).json({ error: 'Team not found.' });
    // A task keeps the history it earned before it joined the sprint, so the
    // team trail is "entries tagged with this team" plus every entry of a task
    // that now lives in it. Otherwise moving a task into a sprint would hide
    // its earlier transitions from the team.
    const teamTaskIds = (await store.listBySprint(id)).map((task) => String(task._id));
    const history = mongoReady
      ? await TaskHistory.find({ $or: [{ teamId: id }, { taskId: { $in: teamTaskIds } }] }).sort({ at: 1 }).lean()
      : memoryTaskHistory
        .filter((h) => h.teamId === id || teamTaskIds.includes(h.taskId))
        .sort((a, b) => new Date(a.at) - new Date(b.at));
    res.json(history.map((h) => ({ from: h.from, to: h.to, actorId: h.actorId, at: h.at })));
  } catch (error) { next(error); }
});

app.post('/api/tasks/:key/comments', requireAuth, async (req, res, next) => {
  try {
    const task = await authorizedTask(req, res);
    if (!task) return;
    const body = String(req.body?.body || '').trim();
    if (!body || body.length > 2000) return res.status(400).json({ error: 'Comment must be between 1 and 2000 characters.' });
    const comment = { body, authorId: userId(req), authorName: req.user.name, createdAt: new Date(), updatedAt: new Date(), _id: crypto.randomUUID() };
    const comments = [...(task.comments || []), comment];
    await store.update(task.key, { comments });
    res.status(201).json(comment);
  } catch (error) { next(error); }
});
app.patch('/api/tasks/:key/comments/:commentId', requireAuth, async (req, res, next) => {
  try {
    const task = await authorizedTask(req, res);
    if (!task) return;
    const comment = (task.comments || []).find((item) => String(item._id) === req.params.commentId);
    if (!comment) return res.status(404).json({ error: 'Comment not found.' });
    if (comment.authorId !== userId(req) && req.role !== 'admin') return res.status(403).json({ error: 'Only the comment author may edit it.' });
    const body = String(req.body?.body || '').trim();
    if (!body || body.length > 2000) return res.status(400).json({ error: 'Comment must be between 1 and 2000 characters.' });
    comment.body = body; comment.updatedAt = new Date();
    await store.update(task.key, { comments: task.comments });
    res.json(comment);
  } catch (error) { next(error); }
});
app.delete('/api/tasks/:key/comments/:commentId', requireAuth, async (req, res, next) => {
  try {
    const task = await authorizedTask(req, res);
    if (!task) return;
    const comment = (task.comments || []).find((item) => String(item._id) === req.params.commentId);
    if (!comment) return res.status(404).json({ error: 'Comment not found.' });
    if (comment.authorId !== userId(req) && req.role !== 'admin') return res.status(403).json({ error: 'Only the comment author may delete it.' });
    await store.update(task.key, { comments: task.comments.filter((item) => String(item._id) !== req.params.commentId) });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.post('/api/tasks/:key/labels', requireAuth, async (req, res, next) => {
  try {
    const task = await authorizedTask(req, res);
    if (!task) return;
    const label = String(req.body?.label || '').trim();
    if (!label || label.length > 40) return res.status(400).json({ error: 'Label must be between 1 and 40 characters.' });
    if ((task.labels || []).includes(label)) return res.status(409).json({ error: 'This label is already attached.' });
    const labels = [...(task.labels || []), label];
    await store.update(task.key, { labels });
    res.json(labels);
  } catch (error) { next(error); }
});
app.delete('/api/tasks/:key/labels/:label', requireAuth, async (req, res, next) => {
  try {
    const task = await authorizedTask(req, res);
    if (!task) return;
    const labels = (task.labels || []).filter((label) => label !== req.params.label);
    await store.update(task.key, { labels });
    res.json(labels);
  } catch (error) { next(error); }
});

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadsDir,
    filename: (_req, file, callback) => callback(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`)
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    const allowed = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.txt', '.csv', '.doc', '.docx', '.xls', '.xlsx']);
    callback(null, allowed.has(extension));
  }
});
app.post('/api/tasks/:key/attachments', requireAuth, upload.single('attachment'), async (req, res, next) => {
  try {
    const task = await authorizedTask(req, res);
    if (!task) { if (req.file) fs.rmSync(req.file.path, { force: true }); return; }
    if (!req.file) return res.status(400).json({ error: 'A supported attachment file is required.' });
    const attachment = { storageName: req.file.filename, originalName: path.basename(req.file.originalname), size: req.file.size, mimetype: req.file.mimetype, uploadedBy: userId(req), createdAt: new Date(), _id: crypto.randomUUID() };
    await store.update(task.key, { attachments: [...(task.attachments || []), attachment] });
    res.status(201).json({ ...attachment, storageName: undefined });
  } catch (error) { if (req.file) fs.rmSync(req.file.path, { force: true }); next(error); }
});
app.get('/api/tasks/:key/attachments', requireAuth, async (req, res, next) => {
  try { const task = await authorizedTask(req, res); if (task) res.json((task.attachments || []).map(({ storageName, ...attachment }) => attachment)); } catch (error) { next(error); }
});
app.delete('/api/tasks/:key/attachments/:attachmentId', requireAuth, async (req, res, next) => {
  try {
    const task = await authorizedTask(req, res);
    if (!task) return;
    const attachment = (task.attachments || []).find((item) => String(item._id) === req.params.attachmentId);
    if (!attachment) return res.status(404).json({ error: 'Attachment not found.' });
    fs.rmSync(path.join(uploadsDir, path.basename(attachment.storageName)), { force: true });
    await store.update(task.key, { attachments: task.attachments.filter((item) => String(item._id) !== req.params.attachmentId) });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.post('/api/tasks/:key/dependencies', requireAuth, async (req, res, next) => {
  try {
    const task = await authorizedTask(req, res);
    if (!task) return;
    const dependsOn = String(req.body?.dependsOn || '').trim();
    const prerequisite = await store.find(dependsOn);
    if (!prerequisite) return res.status(404).json({ error: 'Dependency task not found.' });
    if (!await canAccess(prerequisite, req)) return res.status(403).json({ error: 'You do not have access to the dependency task.' });
    if (task.key === dependsOn) return res.status(400).json({ error: 'A task cannot depend on itself.' });
    if ((task.dependencies || []).some((dep) => dep.toTask === dependsOn)) return res.status(409).json({ error: 'This dependency already exists.' });
    const tasks = await store.list();
    if (createsCycle(tasks, task.key, dependsOn)) return res.status(409).json({ error: 'This dependency would create a circular reference.' });
    const dependency = { _id: crypto.randomUUID(), fromTask: task.key, toTask: dependsOn };
    await store.update(task.key, { dependencies: [...(task.dependencies || []), dependency] });
    res.status(201).json(dependency);
  } catch (error) { next(error); }
});
app.get('/api/tasks/:key/dependencies', requireAuth, async (req, res, next) => {
  try { const task = await authorizedTask(req, res); if (task) res.json(task.dependencies || []); } catch (error) { next(error); }
});
app.delete('/api/tasks/:key/dependencies/:dependencyId', requireAuth, async (req, res, next) => {
  try {
    const task = await authorizedTask(req, res);
    if (!task) return;
    if (!(task.dependencies || []).some((item) => String(item._id) === req.params.dependencyId)) return res.status(404).json({ error: 'Dependency not found.' });
    await store.update(task.key, { dependencies: task.dependencies.filter((item) => String(item._id) !== req.params.dependencyId) });
    res.json({ ok: true });
  } catch (error) { next(error); }
});
app.get('/api/tasks/:key/blocked', requireAuth, async (req, res, next) => {
  try { const task = await authorizedTask(req, res); if (task) { const tasks = await store.list(); res.json({ blocked: blockedTask(task, tasks), blockers: (task.dependencies || []).filter((dep) => tasks.find((item) => item.key === dep.toTask)?.status !== 'done').map((dep) => dep.toTask) }); } } catch (error) { next(error); }
});

app.post('/api/copilot/chat', requireAuth, async (req, res, next) => {
  try {
    const boardId = String(req.body?.boardId || '').trim();
    const message = String(req.body?.message || '').trim();
    if (!boardId || !message) return res.status(400).json({ error: 'boardId and message are required.' });
    if (message.length > MAX_MESSAGE_LENGTH) return res.status(400).json({ error: `Message must be ${MAX_MESSAGE_LENGTH} characters or fewer.` });

    const board = await authorizedBoard({ ...req, params: { id: boardId } }, res);
    if (!board) return;

    const tasks = await store.list();
    const boardTasks = tasks.filter((t) => String(t.boardId || '') === boardId);
    const members = await boardMembers(board);

    const columns = BOARD_COLUMNS;

    const result = await chatWithContext(message, boardTasks, columns, members, {
      // Personal key fallback: only read when the workspace has no key.
      userApiKey: getAllEffective().OPENROUTER_API_KEY ? '' : await findUserAiKey(userId(req))
    });
    if (result.action?.type === 'create' || result.action?.type === 'create_many') {
      const requestedTasks = result.action.type === 'create' ? [result.action] : result.action.tasks;
      const assignmentNotes = [];
      requestedTasks.forEach((item) => {
        validateTaskInput(item, false);
        const requested = String(item.assignee || 'Unassigned').trim();
        if (!requested || requested.toLowerCase() === 'unassigned') {
          // Skill-based assignment: match task labels/title/description against member skills.
          const skilled = findBestSkilledMember(item, members);
          if (skilled) {
            item.assignee = skilled.name;
            assignmentNotes.push(`Assigned “${item.title}” to ${skilled.name} (skill match).`);
          } else {
            const random = pickRandomMember(members);
            if (random) {
              item.assignee = random.name;
              assignmentNotes.push(`Assigned “${item.title}” randomly to ${random.name} (no skill match found).`);
            } else {
              item.assignee = 'Unassigned';
            }
          }
        }
        item.assignee = resolveBoardAssignee(item.assignee, members);
      });
      const created = [];
      for (const item of requestedTasks) {
        const key = await newTaskKey();
        created.push(await store.create({
          key,
          ownerId: userId(req),
          boardId,
          title: item.title.trim(),
          description: item.description || '',
          status: item.status,
          priority: item.priority,
          labels: [...new Set(item.labels || [])],
          assignee: item.assignee,
          dueDate: (() => {
            const due = normalizeDueDate(item.dueDate);
            if (due.reason) throw createAuthError(400, `Due date "${item.dueDate}" could not be understood. Use a date like 2026-10-24, or Today, Tomorrow, This week, Unscheduled.`);
            return due.date ? due.date.toISOString().slice(0, 10) : null;
          })(),
          sprintId: null,
          storyPoints: 0,
          comments: [],
          attachments: [],
          dependencies: []
        }));
      }
      result.action = { type: 'created_many', keys: created.map((item) => item.key) };
      result.matchedTask = created.length === 1 ? { key: created[0].key, title: created[0].title, columnName: columns.find((column) => column.id === created[0].status).label } : null;
      let replyText = `Created ${created.length} tasks on the board: ${created.map((item) => `#${item.key} “${item.title}”`).join(', ')}.`;
      if (assignmentNotes.length) replyText += ' ' + assignmentNotes.join(' ');
      result.reply = replyText;
    } else if (result.action?.type === 'update' || result.action?.type === 'update_many') {
      const requestedUpdates = result.action.type === 'update' ? [result.action] : result.action.updates;
      const prepared = requestedUpdates.map((item) => {
        const task = boardTasks.find((candidate) => String(candidate.key) === String(item.key));
        if (!task) throw createAuthError(404, `Task ${item.key} is no longer on the current board.`);
        validateTaskInput(item.changes, true);
        const changes = { ...item.changes };
        if (changes.assignee !== undefined) changes.assignee = resolveBoardAssignee(changes.assignee, members);
        if (changes.labels) changes.labels = [...new Set(changes.labels)];
        if (changes.dueDate !== undefined) {
          const due = normalizeDueDate(changes.dueDate);
          if (due.reason) throw createAuthError(400, `Due date "${changes.dueDate}" could not be understood. Use a date like 2026-10-24, or Today, Tomorrow, This week, Unscheduled.`);
          changes.dueDate = due.date ? due.date.toISOString().slice(0, 10) : null;
        }
        if (changes.title !== undefined) changes.title = changes.title.trim();
        return { task, changes };
      });
      const updated = [];
      for (const item of prepared) updated.push(await store.update(item.task.key, item.changes));
      result.action = { type: 'updated_many', keys: updated.map((item) => item.key), changes: prepared.map((item) => item.changes) };
      result.matchedTask = updated.length === 1 ? { key: updated[0].key, title: updated[0].title, columnName: columns.find((column) => column.id === updated[0].status).label } : null;
      result.reply = `Updated ${updated.length} tasks on the board.`;
    }
    res.json(result);
  } catch (error) { next(error); }
});

// Home-page board generation. It reuses the same AI integration and task
// validation as Copilot; the only new behaviour is creating the destination board
// first and persisting the validated plan. Secrets stay on the server.
app.post('/api/ai/boards', requireAuth, async (req, res, next) => {
  try {
    const input = normalizeBoardGenerationRequest(req.body || {});
    if (input.error) return res.status(400).json({ error: input.error });

    // The workspace key wins; a member's personal key is the fallback.
    const userApiKey = getAllEffective().OPENROUTER_API_KEY ? '' : await findUserAiKey(userId(req));
    if (!getAllEffective().OPENROUTER_API_KEY?.trim() && !userApiKey) {
      return res.status(503).json({
        error: 'AI board generation is not configured on this server. Add OPENROUTER_API_KEY to backend/.env, set one in Settings, or create a board manually.',
        code: 'AI_NOT_CONFIGURED'
      });
    }

    const ownerId = userId(req);
    const members = [{
      id: ownerId,
      name: String(req.user.name || req.user.email),
      email: String(req.user.email),
      skills: Array.isArray(req.user.skills) ? req.user.skills : []
    }];
    const result = await chatWithContext(planningMessage(input.goal, input.name), [], BOARD_COLUMNS, members, { userApiKey });
    const plannedTasks = tasksFromAiResult(result);
    if (!plannedTasks.length) {
      return res.status(422).json({
        error: 'The AI planner could not turn that goal into tasks. Describe the project and its main outcomes, or create a board manually.',
        code: 'AI_NO_PLAN'
      });
    }

    // Validate everything before creating the board, so bad AI output cannot
    // leave an empty board behind. Apply skill-based assignment to unassigned tasks.
    const assignmentNotes = [];
    for (const task of plannedTasks) {
      validateTaskInput(task, false);
      const requested = String(task.assignee || 'Unassigned').trim();
      if (!requested || requested.toLowerCase() === 'unassigned') {
        const skilled = findBestSkilledMember(task, members);
        if (skilled) {
          task.assignee = skilled.name;
          assignmentNotes.push(`Assigned “${task.title}” to ${skilled.name} (skill match).`);
        } else {
          const random = pickRandomMember(members);
          task.assignee = random ? random.name : 'Unassigned';
          if (random) assignmentNotes.push(`Assigned “${task.title}” randomly to ${random.name} (no skill match found).`);
        }
      }
      task.assignee = resolveBoardAssignee(task.assignee, members);
    }

    const { board, created } = await createBoardWithPlan({
      boardData: {
        ownerId,
        memberIds: [ownerId],
        name: input.name || boardNameFromGoal(input.goal)
      },
      tasks: plannedTasks,
      createBoard: boardStore.create,
      createTask: async (task) => {
        const key = await newTaskKey();
        return store.create({
          key,
          ownerId,
          boardId: task.boardId,
          title: String(task.title || '').trim(),
          description: String(task.description || '').slice(0, 4000),
          status: task.status || BACKLOG_STATUS,
          priority: task.priority || 'medium',
          labels: [...new Set(task.labels || [])],
          assignee: task.assignee || 'Unassigned',
          dueDate: (() => {
            const due = normalizeDueDate(task.dueDate);
            if (due.reason) throw createAuthError(400, `Due date "${task.dueDate}" could not be understood. Use a date like 2026-10-24, or Today, Tomorrow, This week, Unscheduled.`);
            return due.date ? due.date.toISOString().slice(0, 10) : null;
          })(),
          sprintId: null,
          storyPoints: Number.isInteger(task.storyPoints) ? task.storyPoints : 0,
          comments: [],
          attachments: [],
          dependencies: []
        });
      },
      deleteBoardTasks: async (id) => {
        if (mongoReady) await Task.deleteMany({ boardId: id });
        else memoryTasks = memoryTasks.filter((task) => String(task.boardId) !== id);
      },
      deleteBoard: (id) => boardStore.remove(id)
    });

    res.status(201).json({
      board: { id: boardId(board), name: board.name, isOwner: true },
      tasksCreated: created.length,
      assignmentNotes,
      tasks: created.map((task) => ({
        key: task.key,
        title: task.title,
        status: task.status,
        priority: task.priority,
        assignee: task.assignee
      }))
    });
  } catch (error) { next(error); }
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: 'Attachment is invalid or too large.' });
  if (error?.type === 'entity.too.large') return res.status(413).json({ error: 'Request body is too large.' });
  if (isAuthError(error)) {
    // Machine-readable codes (for example AI_UNAVAILABLE) travel next to the
    // human message so clients can branch without parsing prose.
    return res.status(error.status).json({
      error: error.message,
      ...(typeof error.code === 'string' ? { code: error.code } : {})
    });
  }
  // A malformed id or badly typed field is the client's mistake, not a server fault.
  if (error?.name === 'CastError' || error?.name === 'ValidationError') {
    return res.status(400).json({ error: 'One or more fields contained an invalid value.' });
  }
  console.error('Request error:', error.message);
  res.status(500).json({ error: 'An unexpected server error occurred.' });
});

if (process.env.NODE_ENV === 'production') {
  const distDir = path.join(__dirname, '../../frontend/dist');
  app.use(express.static(distDir));
  // Express 5 rejects the bare "*" route (path-to-regexp throws at startup), so
  // the single-page fallback is a plain middleware instead.
  app.use((_req, res) => res.sendFile(path.join(distDir, 'index.html')));
}

// The in-process suite (eventsApi.test.js) awaits this to learn the ephemeral
// port it bound; running the server normally just awaits the same listen.
const serverStarted = connectMongo().then(() => new Promise((resolve, reject) => {
  const server = app.listen(port, () => {
    console.log(`LeadAI API listening on http://localhost:${port}`);
    resolve(server);
  });
  server.on('error', reject);
}));

export { app, connectMongo, memoryTasks, sessions, store, serverStarted };
serverStarted.catch((error) => {
  // A failed boot must terminate the process (a successful Mongo connection
  // would otherwise keep the event loop alive after a port clash).
  console.error(error.message);
  process.exit(1);
});
