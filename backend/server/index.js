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
import { addDays, endDateForStart, diffCalendarDays, summarizeTasks, computeSprintDay, validateSprintRange, todayIsoDate } from './lib/sprintDates.js';
import { sortBacklog } from './lib/backlogOrder.js';
import {
  BACKLOG_STATUS, SPRINT_ENTRY_STATUS, isPermittedSprintStatusChange,
  sprintAcceptsBacklogItem, statusLabel, taskCanReturnToBacklog
} from './lib/taskTransitions.js';
import { User, USERNAME_PATTERN } from './models/User.js';
import { connectDatabase, databaseStatus, reconnectDatabase } from './db.js';
import { Board } from './models/Board.js';
import { TaskHistory } from './models/TaskHistory.js';
import {
  createInAppNotification, listNotifications, countUnreadNotifications, findNotificationForRecipient,
  updateNotificationForRecipient, markAllNotificationsRead, deleteNotificationForRecipient,
  setNotificationDatabaseReady
} from './lib/notificationStore.js';
import {
  getAutomationRules, saveAutomationRules, validateAutomationRuleUpdates,
  setAutomationDatabaseReady
} from './lib/automationSettingsStore.js';
import {
  createAuthError, isAuthError, createUser, authenticateUser, createAuthSession,
  requireAuth, invalidateSession, revokeAllSessionsForUser, validatePassword,
  createResetToken, consumeResetToken, memoryUsers, hashPassword, setDatabaseReady,
  refreshSessionUser, serializeUser, sessions,
  findUserByEmail, findUserById
} from './auth.js';
import { chatWithContext, MAX_MESSAGE_LENGTH, findBestSkilledMember, pickRandomMember } from './ai.js';
import { aiStoryPoints, isValidStoryPoints } from './lib/storyPoints.js';
import {
  setOverride, removeOverride, clearOverrides, getAllEffective, getEffective,
  getOverride, markSetupComplete, isSetupComplete
} from './lib/envConfig.js';
import{
  BOARD_SUMMARY_LIMIT, PRIORITY_TASK_LIMIT, activeSprintsOf, isOpenTask, isOverdueTask,
  numberOf, orderDashboardTasks, stageCounts, taskBelongsTo
} from './lib/dashboard.js';
import {
  boardNameFromGoal, createBoardWithPlan, normalizeBoardGenerationRequest, planningMessage, tasksFromAiResult
} from './lib/aiBoardPlan.js';

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

fs.mkdirSync(uploadsDir, { recursive: true });
app.use(express.json({ limit: '150kb' }));
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
app.use((req, res, next) => {
  const key = `${req.ip}:${req.path}`;
  const now = Date.now();
  const windowStart = rateLimits.get(key) || { count: 0, startedAt: now };
  if (now - windowStart.startedAt > 60_000) {
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
  const today = todayIsoDate();
  return [
    { title: 'Welcome to your LeadAI board', status: 'done', priority: 'low', labels: ['Getting Started'], assignee: name, dueDate: today, description: 'This board belongs to you. Create, organize, and move tasks however you like.' },
    { title: 'Create your first task', status: 'todo', priority: 'high', labels: ['Getting Started'], assignee: name, dueDate: today, description: 'Click "Add Task" to capture something you are working on. Try adding a label and a due date.' },
    { title: 'Drag a card between columns', status: 'todo', priority: 'low', labels: ['Getting Started'], assignee: name, dueDate: null, description: 'Move this card from To Do into In Progress to watch the board update instantly.' },
    { title: 'Agree on a definition of done', status: 'review', priority: 'medium', labels: ['Process'], assignee: name, dueDate: addDays(today, 7), description: 'A clear definition of done keeps completed work consistent across your board.' },
    { title: 'Invite a teammate to collaborate', status: 'backlog', priority: 'medium', labels: ['Team'], assignee: 'Unassigned', dueDate: null, description: 'Share your workspace so others can comment on and track shared work.' }
  ];
}
let memoryTasks = [];
const memoryAutomationHistory = [];
const sprintId = (sprint) => String(sprint._id ?? sprint.id);
const boardId = (board) => String(board._id ?? board.id);
let memorySprintCounter = 0;
function withSprintId(sprint) {
  return sprint._id ? sprint : { ...sprint, _id: `mem-sprint-${Date.now()}-${++memorySprintCounter}` };
}
async function seedStarterTasks(user, board) {
  for (const template of starterTasksFor(user)) {
    let key;
    do { key = `KAN-${crypto.randomInt(100, 1000)}`; } while (await store.find(key));
    await store.create({ key, ownerId: String(user._id), boardId: boardId(board), ...template, comments: [], attachments: [], dependencies: [] });
  }
}

async function connectMongo() {
  const status = await connectDatabase();
  updateDatabaseReadiness(status);
  return status;
}

function updateDatabaseReadiness(status = databaseStatus()) {
  mongoReady = status.mode === 'mongodb' && status.ready;
  setDatabaseReady(mongoReady);
  setNotificationDatabaseReady(mongoReady);
  setAutomationDatabaseReady(mongoReady);
}

const store = {
  list: () => mongoReady ? Task.find().sort({ createdAt: 1 }).lean() : Promise.resolve(memoryTasks),
  listOverdue: () => {
    if (!mongoReady) return Promise.resolve(memoryTasks.filter((task) => taskIsOverdue(task)));
    return Task.find({
      status: { $ne: 'done' },
      dueDate: { $lt: new Date() },
      'automationFlags.overdueEscalated': { $ne: true }
    }).sort({ dueDate: 1 }).limit(500).lean();
  },
  find: (key) => mongoReady ? Task.findOne({ key }) : Promise.resolve(memoryTasks.find((task) => task.key === key)),
  create: async (data) => {
    const taskData = { ...data, storyPoints: data.storyPoints ?? 0 };
    if (mongoReady) return new Task(taskData).save();
    const task = { ...taskData, _id: crypto.randomUUID(), createdAt: new Date(), updatedAt: new Date() };
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
  listBySprint: (id, boardId) => {
    if (!mongoReady) return Promise.resolve(memoryTasks.filter((task) =>
      String(task.sprintId) === String(id)
      && (!boardId || String(task.boardId || '') === String(boardId))
    ));
    const filter = { sprintId: id };
    if (boardId) filter.boardId = boardId;
    return Task.find(filter).sort({ createdAt: 1 }).lean();
  },
  // Board and profile queries are owner-scoped in the database; a shared database must
  // never require loading every developer's tasks to show one person's board.
  listByOwner: (ownerId) => mongoReady ? Task.find({ ownerId }).sort({ createdAt: 1 }).lean() : Promise.resolve(memoryTasks.filter((task) => String(task.ownerId) === String(ownerId))),
  listWithoutSprint: (ownerId, boardId) => {
    if (!mongoReady) return Promise.resolve(memoryTasks.filter((task) =>
      !task.sprintId
      && (!ownerId || String(task.ownerId) === String(ownerId))
      && (!boardId || String(task.boardId || '') === String(boardId))
    ));
    const filter = { sprintId: null };
    if (ownerId) filter.ownerId = ownerId;
    if (boardId) filter.boardId = boardId;
    return Task.find(filter).sort({ createdAt: 1 }).lean();
  }
};

const sprintStore = {
  list: (ownerId, boardId) => {
    if (!mongoReady) return Promise.resolve(memorySprints.filter((sprint) =>
      String(sprint.ownerId) === String(ownerId)
      && (!boardId || String(sprint.boardId || '') === String(boardId))
    ));
    const filter = { ownerId };
    if (boardId) filter.boardId = boardId;
    return Sprint.find(filter).sort({ createdAt: 1 }).lean();
  },
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
  },
  remove: async (id, ownerId) => {
    if (mongoReady) return Sprint.deleteOne({ _id: id, ownerId });
    const before = memorySprints.length;
    memorySprints = memorySprints.filter((sprint) => sprintId(sprint) !== String(id) || String(sprint.ownerId) !== String(ownerId));
    return { deletedCount: before - memorySprints.length };
  }
};

const boardStore = {
  list: (userId) => mongoReady
    ? Board.find({ $or: [{ ownerId: userId }, { memberIds: userId }] }).sort({ createdAt: 1 }).lean()
    : Promise.resolve(memoryBoards.filter((board) => String(board.ownerId) === String(userId) || (board.memberIds || []).includes(String(userId)))),
  find: (id) => mongoReady ? Board.findById(id).lean() : Promise.resolve(memoryBoards.find((board) => boardId(board) === String(id))),
  create: async (data) => {
    if (mongoReady) return new Board(data).save();
    const board = { ...data, _id: `mem-board-${Date.now()}-${crypto.randomUUID()}`, createdAt: new Date() };
    memoryBoards = [...memoryBoards, board];
    return board;
  },
  update: async (id, data) => {
    if (mongoReady) return Board.findByIdAndUpdate(id, { $set: data }, { new: true, runValidators: true }).lean();
    const current = await boardStore.find(id);
    if (!current) return null;
    memoryBoards = memoryBoards.map((board) => boardId(board) === String(id) ? { ...board, ...data } : board);
    return boardStore.find(id);
  },
  remove: async (id) => {
    if (mongoReady) return Board.deleteOne({ _id: id });
    const before = memoryBoards.length;
    memoryBoards = memoryBoards.filter((board) => boardId(board) !== String(id));
    return { deletedCount: before - memoryBoards.length };
  }
};

async function createDefaultBoard(user) {
  return boardStore.create({ ownerId: String(user._id), memberIds: [String(user._id)], name: `${user.name || 'My'}'s board` });
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

function sprintView(sprint, tasks = []) {
  const progress = summarizeTasks(tasks);
  const current = computeSprintDay(sprint.startDate, sprint.endDate);
  return { ...sprint, id: sprintId(sprint), durationDays: diffCalendarDays(sprint.startDate, sprint.endDate) + 1, progress, current };
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
  if (req.query.boardId && String(req.query.boardId) !== String(sprint.boardId || '')) {
    res.status(404).json({ error: 'Sprint not found on this board.' });
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
      // dueDate is stored as a Date. Comparing it directly excludes null values
      // and avoids applying string operators to MongoDB date fields.
      Task.countDocuments({ ...openQuery, dueDate: { $lt: today } })
    ]);
    return { open, overdue };
  }
  const mine = memoryTasks.filter((task) => accessibleIds.includes(String(task.boardId || '')) && names.includes(String(task.assignee || '')) && isOpenTask(task));
  return { open: mine.length, overdue: mine.filter((task) => isOverdueTask(task, today)).length };
}

async function buildDashboard(req, requestedBoardId = null) {
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
  const allActiveSprints = activeSprintsOf(sprints, today);
  const activeSprints = requestedBoardId === null
    ? allActiveSprints
    : allActiveSprints.filter((sprint) => String(sprint.boardId || '') === String(requestedBoardId));
  const active = activeSprints[0] || null;
  let activeSprint = null;
  if (active) {
    const sprintTasks = await store.listBySprint(sprintId(active), active.boardId);
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
      const linkedSprint = allActiveSprints.find((sprint) => String(sprint.boardId || '') === id)
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
      dueDate: String(task.dueDate || ''),
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
    ai: { configured: Boolean(getEffective('OPENROUTER_API_KEY')?.trim()) }
  };
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
async function dispatchAutomation(boardIdValue, ruleName, operation) {
  try {
    const rules = await getAutomationRules(String(boardIdValue));
    if (!rules[ruleName]) return;
    return await operation();
  } catch (error) {
    console.error(`[automation] ${ruleName} dispatch failed:`, error);
  }
}
async function notifySafely(notification) {
  try {
    await createInAppNotification(notification);
    return true;
  } catch (error) {
    console.error('[notification] In-app dispatch failed:', error);
    return false;
  }
}
async function writeAutomationHistory({ task, actorId, from = task.status, to = task.status, note }) {
  const at = new Date();
  if (mongoReady && task._id) {
    return TaskHistory.create({
      taskId: task._id,
      teamId: task.sprintId || null,
      from,
      to,
      actorId,
      source: 'automation',
      note,
      at
    });
  }
  const entry = {
    id: crypto.randomUUID(),
    taskKey: String(task.key),
    teamId: task.sprintId || null,
    from,
    to,
    actorId: String(actorId),
    source: 'automation',
    note,
    at
  };
  memoryAutomationHistory.push(entry);
  return entry;
}
async function resolveTaskAssignee(task, board) {
  const members = await boardMembers(board);
  const assigned = members.find((member) => String(member.id) === String(task.assigneeId))
    || members.find((member) => member.name.toLowerCase() === String(task.assignee || '').toLowerCase()
      || member.email.toLowerCase() === String(task.assignee || '').toLowerCase());
  return assigned || null;
}
function calendarDay(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}
function taskIsOverdue(task, now = new Date()) {
  return task.status !== 'done' && Boolean(task.dueDate)
    && calendarDay(task.dueDate) < now.toISOString().slice(0, 10);
}
async function escalateOverdueTask(task, board, now = new Date()) {
  const current = await store.find(task.key);
  if (!current || !taskIsOverdue(current, now) || current.automationFlags?.overdueEscalated) return;
  const updated = await store.update(current.key, {
    priority: current.priority === 'urgent' ? 'urgent' : 'high',
    automationFlags: { ...(current.automationFlags || {}), overdueEscalated: true, overdueNotifiedAt: now }
  });
  if (!updated) return;
  const recipient = await resolveTaskAssignee(updated, board);
  if (recipient) {
    await notifySafely({
      recipient: recipient.id,
      type: 'system',
      title: 'Overdue task escalated',
      message: `${updated.key}: ${updated.title} is overdue and was raised to High priority.`,
      relatedId: updated._id || updated.key,
      metadata: { boardId: boardId(board), taskKey: updated.key, priority: 'high' }
    });
  }
}
async function scanOverdueTasks() {
  try {
    const tasks = await store.listOverdue();
    for (const task of tasks) {
      try {
        if (!task.boardId || !taskIsOverdue(task) || task.automationFlags?.overdueEscalated) continue;
        const board = await boardStore.find(task.boardId);
        if (!board) continue;
        await dispatchAutomation(boardId(board), 'overduePriorityEscalation', () => escalateOverdueTask(task, board));
      } catch (error) {
        console.error('[automation] overdue task scan failed for task:', task?.key, error);
      }
    }
  } catch (error) {
    console.error('[automation] overdue task scan failed:', error);
  }
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
  if (body.assigneeId !== undefined && body.assigneeId !== null
    && (typeof body.assigneeId !== 'string' || !/^[a-zA-Z0-9_-]{8,64}$/.test(body.assigneeId))) {
    throw createAuthError(400, 'Invalid assignee id.');
  }
  if (body.checklist !== undefined && (!Array.isArray(body.checklist) || body.checklist.length > 50
    || body.checklist.some((item) => !item || typeof item !== 'object' || Array.isArray(item)
      || typeof item.text !== 'string' || !item.text.trim() || item.text.trim().length > 240
      || (item.completed !== undefined && typeof item.completed !== 'boolean')))) {
    throw createAuthError(400, 'Checklist items must have text up to 240 characters and an optional completed boolean.');
  }
  if (body.dueDate !== undefined && (typeof body.dueDate !== 'string' || body.dueDate.length > 40)) throw createAuthError(400, 'Due date must be text up to 40 characters.');
  if (body.sprintId !== undefined && (body.sprintId !== null && (typeof body.sprintId !== 'string' || !/^[a-zA-Z0-9_-]{8,}$/.test(body.sprintId)))) throw createAuthError(400, 'Invalid sprint id.');
  if (body.storyPoints !== undefined && !isValidStoryPoints(body.storyPoints)) {
    throw createAuthError(400, 'Story points must be an integer from 0 to 100.');
  }
}
function validTaskKey(key) { return typeof key === 'string' && /^KAN-[A-Z0-9]+$/i.test(key); }
function taskUpdates(body) {
  return Object.fromEntries(['title', 'description', 'status', 'priority', 'labels', 'assignee', 'assigneeId', 'dueDate', 'sprintId', 'storyPoints', 'checklist'].filter((field) => body[field] !== undefined).map((field) => [field, body[field]]));
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
    if (updates.username && !USERNAME_PATTERN.test(updates.username)) {
      throw createAuthError(400, 'Username must be 3-30 characters: lowercase letters, numbers, or hyphens, and cannot start or end with a hyphen.');
    }
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
app.get('/api/system/status', (_req, res) => {
  const database = databaseStatus();
  const mongodbUri = String(getEffective('MONGODB_URI')).trim();
  const usingLocalDefault = !mongodbUri || mongodbUri === 'mongodb://localhost:27017/leadai';
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    mongodb: {
      configured: Boolean(mongodbUri),
      usingLocalDefault,
      connected: database.mode === 'mongodb' && database.ready,
      mode: database.mode
    },
    openrouter: {
      configured: Boolean(String(getEffective('OPENROUTER_API_KEY')).trim()),
      modelConfigured: Boolean(String(getEffective('OPENROUTER_MODEL')).trim())
    },
    setupRequired: !isSetupComplete()
  });
});

app.post('/api/system/configure', requireAuth, async (req, res) => {
  const { databaseMode, mongodbUri, openrouterApiKey, skipAI } = req.body || {};
  if (!['local', 'cloud'].includes(databaseMode)) {
    return res.status(400).json({ error: 'Choose either the local default or a cloud MongoDB URI.' });
  }
  if (skipAI !== true && (typeof openrouterApiKey !== 'string' || !openrouterApiKey.trim())) {
    return res.status(400).json({ error: 'Provide an OpenRouter API key or choose demo mode.' });
  }

  const nextMongoUri = databaseMode === 'local'
    ? 'mongodb://localhost:27017/leadai'
    : String(mongodbUri || '').trim();
  if (!/^mongodb(?:\+srv)?:\/\//.test(nextMongoUri)) {
    return res.status(400).json({ error: 'The MongoDB URI must start with mongodb:// or mongodb+srv://.' });
  }
  const databaseName = /^mongodb(?:\+srv)?:\/\/[^/]*\/([^?]+)/.exec(nextMongoUri);
  if (!databaseName?.[1]) {
    return res.status(400).json({ error: 'The MongoDB URI must include a database name.' });
  }

  const previousMongoOverride = getOverride('MONGODB_URI');
  const previousOpenrouterOverride = getOverride('OPENROUTER_API_KEY');
  const previousMongoUri = String(getEffective('MONGODB_URI') || '').trim() || 'mongodb://localhost:27017/leadai';
  const uriChanged = nextMongoUri !== previousMongoUri;

  try {
    setOverride('MONGODB_URI', nextMongoUri);
    if (!skipAI) setOverride('OPENROUTER_API_KEY', openrouterApiKey.trim());
    if (uriChanged) {
      try {
        const status = await reconnectDatabase();
        updateDatabaseReadiness(status);
      } catch {
        if (previousMongoOverride === undefined) removeOverride('MONGODB_URI');
        else setOverride('MONGODB_URI', previousMongoOverride);
        if (previousOpenrouterOverride === undefined) removeOverride('OPENROUTER_API_KEY');
        else setOverride('OPENROUTER_API_KEY', previousOpenrouterOverride);
        try {
          const restoredStatus = await reconnectDatabase();
          updateDatabaseReadiness(restoredStatus);
        } catch {
          updateDatabaseReadiness();
          return res.status(503).json({
            error: 'Could not connect to the selected database, and the previous database connection could not be restored.'
          });
        }
        return res.status(400).json({ error: 'Could not connect to the selected MongoDB database. Previous settings were restored.' });
      }
    }
    markSetupComplete();
    console.info('[system] Initial setup completed.');
    res.json({ saved: true, setupRequired: false });
  } catch (error) {
    console.error('[system] Could not apply initial setup:', error.message);
    res.status(500).json({ error: 'Could not save the setup configuration.' });
  }
});
app.get('/api/dashboard/summary', requireAuth, async (req, res, next) => {
  try {
    const hasBoardFilter = Object.hasOwn(req.query, 'boardId');
    const requestedBoardId = hasBoardFilter ? String(req.query.boardId || '').trim() : null;
    if (requestedBoardId && !await authorizedBoard({ ...req, params: { id: requestedBoardId } }, res)) return;
    res.json(await buildDashboard(req, requestedBoardId));
  } catch (error) { next(error); }
});

app.get('/api/settings/env', requireAuth, (_req, res) => {
  const effective = getAllEffective();
  res.json({
    mongodbUri: effective.MONGODB_URI,
    openrouterApiKey: effective.OPENROUTER_API_KEY,
    openrouterModel: effective.OPENROUTER_MODEL,
  });
});

app.post('/api/settings/env', requireAuth, async (req, res, next) => {
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
        await reconnectDatabase();
      } catch (error) {
        removeOverride('MONGODB_URI');
        return res.status(400).json({ error: `Could not connect to MongoDB: ${error.message}. Override reverted.` });
      }
    }

    const effective = getAllEffective();
    res.json({
      saved: true,
      mongodbUri: effective.MONGODB_URI,
      openrouterApiKey: effective.OPENROUTER_API_KEY,
      openrouterModel: effective.OPENROUTER_MODEL,
    });
  } catch (error) { next(error); }
});

app.post('/api/auth/signup', async (req, res, next) => {
  try {
    const user = await createUser(req.body || {});
    const board = await createDefaultBoard(user);
    await seedStarterTasks(user, board);
    res.status(201).json(user);
  } catch (error) { next(error); }
});
app.post('/api/auth/signin', async (req, res, next) => {
  try {
    const user = await authenticateUser(req.body || {});
    const session = createAuthSession(user);
    if (mongoReady) await User.updateOne({ _id: user._id }, { $addToSet: { authSessions: session.token } });
    res.json(session);
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
app.get('/api/notifications', requireAuth, async (req, res, next) => {
  try {
    const [notifications, unreadCount] = await Promise.all([
      listNotifications(userId(req)),
      countUnreadNotifications(userId(req))
    ]);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ notifications, unreadCount, total: unreadCount });
  } catch (error) { next(error); }
});
app.patch('/api/notifications/:id/read', requireAuth, async (req, res, next) => {
  try {
    const notification = await updateNotificationForRecipient(req.params.id, userId(req), { status: 'read' });
    if (!notification) return res.status(404).json({ error: 'Notification not found.' });
    res.json(notification);
  } catch (error) { next(error); }
});
app.patch('/api/notifications/read-all', requireAuth, async (req, res, next) => {
  try {
    const updated = await markAllNotificationsRead(userId(req));
    res.json({ ok: true, updated });
  } catch (error) { next(error); }
});
app.delete('/api/notifications/:id', requireAuth, async (req, res, next) => {
  try {
    const deleted = await deleteNotificationForRecipient(req.params.id, userId(req));
    if (!deleted) return res.status(404).json({ error: 'Notification not found.' });
    res.json({ ok: true });
  } catch (error) { next(error); }
});
app.get('/api/automations', requireAuth, async (req, res, next) => {
  try {
    const requestedBoardId = String(req.query.boardId || '');
    if (!requestedBoardId) return res.status(400).json({ error: 'A board is required.' });
    const board = await authorizedBoard({ ...req, params: { id: requestedBoardId } }, res);
    if (!board) return;
    res.json({ boardId: boardId(board), rules: await getAutomationRules(boardId(board)) });
  } catch (error) { next(error); }
});
app.patch('/api/automations', requireAuth, async (req, res, next) => {
  try {
    const requestedBoardId = String(req.body?.boardId || '');
    if (!requestedBoardId) return res.status(400).json({ error: 'A board is required.' });
    const board = await authorizedBoard({ ...req, params: { id: requestedBoardId } }, res, { ownerOnly: true });
    if (!board) return;
    const updates = validateAutomationRuleUpdates(req.body?.rules);
    if (!updates) return res.status(400).json({ error: 'Provide one or more valid automation rule toggles.' });
    res.json({ boardId: boardId(board), rules: await saveAutomationRules(boardId(board), updates) });
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
    if (memberId === userId(req) || (board.memberIds || []).map(String).includes(memberId)) {
      return res.status(409).json({ error: 'That user already has access to this board.' });
    }
    const current = await listNotifications(memberId, 100);
    const alreadyPending = current.some((notification) =>
      notification.type === 'board_invite'
      && String(notification.metadata?.boardId) === boardId(board)
      && notification.metadata?.inviteStatus === 'pending'
    );
    if (alreadyPending) return res.status(409).json({ error: 'A pending invitation already exists for that user.' });
    const notificationCreated = await notifySafely({
      recipient: memberId,
      sender: userId(req),
      type: 'board_invite',
      title: 'Board invitation',
      message: `${req.user.name || req.user.email} invited you to join "${board.name}".`,
      relatedId: boardId(board),
      metadata: {
        boardId: boardId(board),
        boardName: board.name,
        inviterName: req.user.name || req.user.email,
        inviteStatus: 'pending',
        role: String(req.body?.role || 'Member')
      }
    });
    if (!notificationCreated) return res.status(503).json({ error: 'The invitation notification could not be created. Please retry.' });
    res.status(201).json({ ok: true, pending: true, boardId: boardId(board), invitedUserId: memberId });
  } catch (error) { next(error); }
});
app.post('/api/boards/invite/respond', requireAuth, async (req, res, next) => {
  try {
    const notificationId = String(req.body?.notificationId || '');
    const action = req.body?.action;
    if (!notificationId || !['accept', 'decline'].includes(action)) {
      return res.status(400).json({ error: 'A notificationId and accept/decline action are required.' });
    }
    const notification = await findNotificationForRecipient(notificationId, userId(req));
    if (!notification || notification.type !== 'board_invite' || notification.metadata?.inviteStatus !== 'pending') {
      return res.status(404).json({ error: 'Pending board invitation not found.' });
    }
    const invitedBoardId = String(notification.metadata.boardId || '');
    const board = await boardStore.find(invitedBoardId);
    if (!board) {
      await updateNotificationForRecipient(notificationId, userId(req), {
        status: 'actioned',
        metadata: { ...notification.metadata, inviteStatus: 'expired' }
      });
      return res.status(404).json({ error: 'The invited board no longer exists.' });
    }
    if (action === 'accept') {
      const memberIds = [...new Set([...(board.memberIds || []).map(String), userId(req)])];
      await boardStore.update(boardId(board), { memberIds });
    }
    const updated = await updateNotificationForRecipient(notificationId, userId(req), {
      status: 'actioned',
      metadata: { ...notification.metadata, inviteStatus: action === 'accept' ? 'accepted' : 'declined' }
    });
    res.json({ ok: true, action, notification: updated, boardId: boardId(board) });
  } catch (error) { next(error); }
});
app.delete('/api/boards/:id/members/:memberId', requireAuth, async (req, res, next) => {
  try {
    const board = await authorizedBoard(req, res);
    if (!board) return;
    const removingSelf = String(req.params.memberId) === userId(req);
    const isOwner = String(board.ownerId) === userId(req);
    if (!isOwner && !removingSelf) return res.status(403).json({ error: 'Only the board owner may remove another member.' });
    if (String(req.params.memberId) === String(board.ownerId)) return res.status(400).json({ error: 'The board owner cannot be removed.' });
    if (!(board.memberIds || []).map(String).includes(String(req.params.memberId))) {
      return res.status(404).json({ error: 'Board member not found.' });
    }
    const removedMember = await findUserById(req.params.memberId);
    const updated = await boardStore.update(boardId(board), { memberIds: (board.memberIds || []).map(String).filter((id) => id !== String(req.params.memberId)) });
    if (updated && removedMember) {
      dispatchAutomation(boardId(updated), 'smartMemberReassignment', async () => {
        const activeMembers = await boardMembers(updated);
        const loads = new Map(activeMembers.map((member) => [member.id, 0]));
        const openTasks = (await store.list()).filter((task) =>
          String(task.boardId || '') === boardId(updated)
          && task.status !== 'done'
          && (String(task.assigneeId || '') === String(removedMember._id)
            || String(task.assignee || '').toLowerCase() === String(removedMember.name || removedMember.email).toLowerCase())
        );
        for (const task of openTasks) {
          if (!activeMembers.length) break;
          try {
            const best = findBestSkilledMember(task, activeMembers);
            const nextMember = best || [...activeMembers].sort((a, b) =>
              (loads.get(a.id) || 0) - (loads.get(b.id) || 0)
            )[0];
            if (!nextMember) continue;
            const reassigned = await store.update(task.key, { assigneeId: nextMember.id, assignee: nextMember.name });
            if (!reassigned) continue;
            loads.set(nextMember.id, (loads.get(nextMember.id) || 0) + 1);
            try {
              await writeAutomationHistory({
                task,
                actorId: userId(req),
                note: `AI reassigned this task from ${removedMember.name || removedMember.email} to ${nextMember.name} after their departure.`
              });
            } catch (historyError) {
              console.error(`[automation] could not write reassignment audit note for ${task.key}:`, historyError);
            }
          } catch (reassignmentError) {
            console.error(`[automation] could not reassign ${task.key} after member departure:`, reassignmentError);
          }
        }
      });
    }
    res.json({ ...updated, id: boardId(updated), isOwner });
  } catch (error) { next(error); }
});
app.post('/api/auth/reset-password/request', async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const user = memoryUsers.get(email) || (mongoReady && await User.findOne({ email }));
    const response = { ok: true, message: 'If an account exists, reset instructions have been sent.' };
    if (user) {
      const token = createResetToken(user._id);
      if (process.env.NODE_ENV === 'test') response.resetToken = token;
    }
    res.json(response);
  } catch (error) { next(error); }
});
app.post('/api/auth/reset-password', async (req, res, next) => {
  try {
    const { token, password } = req.body || {};
    validatePassword(password);
    const record = consumeResetToken(token);
    if (!record) return res.status(400).json({ error: 'The reset token is invalid or expired.' });
    let user = [...memoryUsers.values()].find((item) => String(item._id) === record.userId);
    if (!user && mongoReady) user = await User.findById(record.userId).select('+passwordHash');
    if (!user) return res.status(400).json({ error: 'The reset token is invalid or expired.' });
    user.passwordHash = await hashPassword(password);
    if (memoryUsers.has(user.email)) memoryUsers.set(user.email, user);
    else await User.updateOne({ _id: user._id }, { $set: { passwordHash: user.passwordHash, authSessions: [] } });
    await revokeAllSessionsForUser(user._id);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.get('/api/sprints', requireAuth, async (req, res, next) => {
  try {
    const requestedBoardId = req.query.boardId ? String(req.query.boardId) : null;
    if (requestedBoardId && !await authorizedBoard({ ...req, params: { id: requestedBoardId } }, res)) return;
    const sprints = await sprintStore.list(userId(req), requestedBoardId);
    res.json(await Promise.all(sprints.map(async (sprint) => sprintView(sprint, await store.listBySprint(sprintId(sprint), sprint.boardId)))));
  } catch (error) { next(error); }
});
app.post('/api/sprints', requireAuth, async (req, res, next) => {
  let createdSprint = null;
  const movedTasks = [];
  try {
    const name = String(req.body?.name || '').trim();
    const goal = String(req.body?.goal || '').trim();
    const startDate = String(req.body?.startDate || todayIsoDate());
    if (!name || name.length > 120) return res.status(400).json({ error: 'Sprint name must be between 1 and 120 characters.' });
    if (goal.length > 1000) return res.status(400).json({ error: 'Sprint goal must be 1000 characters or fewer.' });
    const endDate = String(req.body?.endDate || endDateForStart(startDate));
    const dateValidation = validateSprintRange(startDate, endDate);
    if (!dateValidation.ok) return res.status(400).json({ error: dateValidation.error });
    if (!req.body?.boardId) return res.status(400).json({ error: 'A board is required to create a sprint.' });
    const board = await authorizedBoard({ ...req, params: { id: String(req.body.boardId) } }, res);
    if (!board) return;
    const taskKeys = req.body?.taskKeys ?? [];
    if (!Array.isArray(taskKeys) || taskKeys.length > 100 || taskKeys.some((key) => typeof key !== 'string') || new Set(taskKeys).size !== taskKeys.length) {
      return res.status(400).json({ error: 'Select up to 100 unique Product Backlog tasks.' });
    }
    const pendingTasks = [];
    for (const key of taskKeys) {
      const task = await store.find(key);
      if (!task || !await canAccess(task, req)) return res.status(404).json({ error: `Task ${key} was not found.` });
      if (String(task.boardId || '') !== boardId(board)) {
        return res.status(409).json({ error: `Task ${key} belongs to a different board.` });
      }
      pendingTasks.push(task);
    }
    const candidateSprint = { ownerId: userId(req), boardId: boardId(board), startDate, endDate, sprintId: null };
    for (const task of pendingTasks) {
      const blocked = sprintAcceptsBacklogItem(candidateSprint, task);
      if (blocked) return res.status(409).json({ error: blocked });
    }
    createdSprint = await sprintStore.create({
      ownerId: userId(req), name, goal, startDate, endDate, boardId: boardId(board)
    });
    const sprintTasks = [];
    for (const task of pendingTasks) {
      const updated = await store.update(task.key, { sprintId: sprintId(createdSprint), status: SPRINT_ENTRY_STATUS });
      if (!updated) throw new Error(`Task ${task.key} could not be added to the sprint.`);
      movedTasks.push({ key: task.key, status: task.status });
      sprintTasks.push(updated);
    }
    dispatchAutomation(boardId(board), 'sprintKickoffBroadcast', async () => {
      const recipients = new Set((board.memberIds || []).map(String));
      recipients.add(String(board.ownerId));
      for (const recipient of recipients) {
        await notifySafely({
          recipient,
          sender: userId(req),
          type: 'sprint_started',
          title: `Sprint started: ${createdSprint.name}`,
          message: `${createdSprint.goal ? `Goal: ${createdSprint.goal}. ` : ''}Timeline: ${createdSprint.startDate} to ${createdSprint.endDate}.`,
          relatedId: sprintId(createdSprint),
          metadata: { boardId: boardId(board), sprintId: sprintId(createdSprint), startDate: createdSprint.startDate, endDate: createdSprint.endDate }
        });
      }
    });
    res.status(201).json(sprintView(createdSprint, sprintTasks));
  } catch (error) {
    for (const task of movedTasks) await store.update(task.key, { sprintId: null, status: task.status }).catch(() => {});
    if (createdSprint) await sprintStore.remove(sprintId(createdSprint), userId(req)).catch(() => {});
    next(error);
  }
});
app.get('/api/sprints/:id', requireAuth, async (req, res, next) => {
  try {
    const sprint = await authorizedSprint(req, res);
    if (!sprint) return;
    res.json(sprintView(sprint, await store.listBySprint(sprintId(sprint), sprint.boardId)));
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
    res.json(sprintView(updated, await store.listBySprint(sprintId(updated), updated.boardId)));
  } catch (error) { next(error); }
});
app.get('/api/sprints/:id/tasks', requireAuth, async (req, res, next) => {
  try {
    const sprint = await authorizedSprint(req, res);
    if (!sprint) return;
    const tasks = await store.listBySprint(sprintId(sprint), sprint.boardId);
    res.json((await Promise.all(tasks.map(async (task) => (await canAccess(task, req)) ? task : null))).filter(Boolean));
  } catch (error) { next(error); }
});
app.get('/api/backlog', requireAuth, async (req, res, next) => {
  try {
    // Sprints are owner-scoped, so an owner-scoped query is what keeps the Product
    // Backlog consistent with the sprint list (and avoids loading other developers' rows).
    const requestedBoardId = req.query.boardId ? String(req.query.boardId) : null;
    if (requestedBoardId && !await authorizedBoard({ ...req, params: { id: requestedBoardId } }, res)) return;
    const tasks = await store.listWithoutSprint(userId(req), requestedBoardId);
    const accessible = (await Promise.all(tasks.map(async (task) => (await canAccess(task, req)) ? task : null))).filter(Boolean);
    res.json(sortBacklog(accessible));
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
    res.status(201).json(updated);
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
    const tasks = await store.list();
    const board = req.query.boardId ? await authorizedBoard({ ...req, params: { id: req.query.boardId } }, res) : await defaultBoardFor(req);
    if (!board) return res.json([]);
    res.json((await Promise.all(tasks.map(async (task) => String(task.boardId || '') === boardId(board) && (await canAccess(task, req)) ? task : null))).filter(Boolean));
  } catch (error) { next(error); }
});
app.get('/api/tasks/:key/history', requireAuth, async (req, res, next) => {
  try {
    const task = await authorizedTask(req, res);
    if (!task) return;
    const history = mongoReady && task._id
      ? await TaskHistory.find({ taskId: task._id }).sort({ at: 1 }).lean()
      : memoryAutomationHistory.filter((entry) => entry.taskKey === String(task.key)).sort((a, b) => new Date(a.at) - new Date(b.at));
    res.json(history.map((entry) => ({
      id: String(entry._id || entry.id),
      taskId: String(entry.taskId || task._id || ''),
      taskKey: String(task.key),
      teamId: entry.teamId ? String(entry.teamId) : null,
      from: entry.from ?? null,
      to: entry.to,
      actorId: String(entry.actorId || ''),
      source: entry.source || 'status_change',
      note: entry.note || '',
      at: entry.at
    })));
  } catch (error) { next(error); }
});
app.post('/api/tasks', requireAuth, async (req, res, next) => {
  try {
    validateTaskInput(req.body || {});
    const board = req.body.boardId ? await authorizedBoard({ ...req, params: { id: req.body.boardId } }, res) : await defaultBoardFor(req);
    if (!board) return res.status(404).json({ error: 'Create a board before adding tasks.' });
    let sprint = null;
    if (req.body.sprintId) {
      sprint = await sprintStore.find(req.body.sprintId, userId(req));
      if (!sprint) return res.status(404).json({ error: 'Sprint not found.' });
      const blocked = sprintAcceptsBacklogItem(sprint, { sprintId: null, ownerId: userId(req), boardId: boardId(board) });
      if (blocked) return res.status(409).json({ error: blocked });
    }
    let key;
    do { key = `KAN-${crypto.randomInt(100, 1000)}`; } while (await store.find(key));
    const members = await boardMembers(board);
    const requestedAssignee = String(req.body.assignee || 'Unassigned').trim();
    let assigneeMember = req.body.assigneeId
      ? members.find((member) => String(member.id) === String(req.body.assigneeId))
      : members.find((member) => member.name.toLowerCase() === requestedAssignee.toLowerCase()
        || member.email.toLowerCase() === requestedAssignee.toLowerCase());
    if (req.body.assigneeId && !assigneeMember) return res.status(400).json({ error: 'Assignee must be a member of this board.' });
    const assigneeName = assigneeMember?.name
      || (requestedAssignee.toLowerCase() === 'unassigned' ? 'Unassigned' : requestedAssignee);
    const task = await store.create({
      key, ownerId: userId(req), boardId: boardId(board), title: req.body.title.trim(), description: (req.body.description || '').slice(0, 4000),
      status: sprint ? SPRINT_ENTRY_STATUS : req.body.status || BACKLOG_STATUS, priority: req.body.priority || 'medium',
      labels: [...new Set(req.body.labels || [])], assignee: assigneeName,
      assigneeId: assigneeMember?.id || null,
      dueDate: String(req.body.dueDate || '').slice(0, 40), sprintId: sprint ? sprintId(sprint) : null, storyPoints: req.body.storyPoints || 0,
      comments: [], attachments: [], dependencies: [],
      checklist: (req.body.checklist || []).map((item) => ({ text: item.text.trim(), completed: Boolean(item.completed) }))
    });
    const taskAssigneeId = task.assigneeId || (assigneeMember?.id ?? null);
    if (taskAssigneeId && taskAssigneeId !== userId(req)) {
      dispatchAutomation(boardId(board), 'taskAssignmentNotification', () => notifySafely({
        recipient: taskAssigneeId,
        sender: userId(req),
        type: 'task_assigned',
        title: 'Task assigned to you',
        message: `${task.key}: ${task.title}`,
        relatedId: task._id || task.key,
        metadata: { boardId: boardId(board), taskKey: task.key }
      }));
    }
    dispatchAutomation(boardId(board), 'overduePriorityEscalation', () => escalateOverdueTask(task, board));
    res.status(201).json(task);
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
    if (updates.status !== undefined && task.sprintId && !isPermittedSprintStatusChange(task.status, updates.status)) {
      return res.status(409).json({
        error: `A sprint task cannot move directly from ${statusLabel(task.status)} to ${statusLabel(updates.status)}.`
      });
    }
    if (updates.title !== undefined) updates.title = updates.title.trim();
    if (updates.assignee !== undefined) updates.assignee = updates.assignee.trim() || 'Unassigned';
    if (updates.labels) updates.labels = [...new Set(updates.labels)];
    if (req.body.assignee !== undefined || req.body.assigneeId !== undefined) {
      const board = task.boardId ? await boardStore.find(task.boardId) : null;
      const members = board ? await boardMembers(board) : [];
      const requestedAssigneeId = req.body.assigneeId;
      const requestedAssignee = String(req.body.assignee ?? task.assignee ?? 'Unassigned').trim();
      if (requestedAssigneeId === null && req.body.assignee === undefined) {
        updates.assignee = 'Unassigned';
        updates.assigneeId = null;
      } else {
        let assigneeMember = requestedAssigneeId
          ? members.find((member) => String(member.id) === String(requestedAssigneeId))
          : members.find((member) => member.name.toLowerCase() === requestedAssignee.toLowerCase()
            || member.email.toLowerCase() === requestedAssignee.toLowerCase());
        if (requestedAssigneeId && !assigneeMember) return res.status(400).json({ error: 'Assignee must be a member of this board.' });
        updates.assignee = assigneeMember?.name
          || (requestedAssignee.toLowerCase() === 'unassigned' ? 'Unassigned' : requestedAssignee);
        updates.assigneeId = assigneeMember?.id || null;
      }
    }
    if (updates.checklist) {
      updates.checklist = updates.checklist.map((item) => ({ text: item.text.trim(), completed: Boolean(item.completed) }));
    }
    let updatedTask = await store.update(task.key, updates);
    if (!updatedTask) return res.status(404).json({ error: 'Task not found.' });
    const board = updatedTask.boardId ? await boardStore.find(updatedTask.boardId) : null;
    if (board && updates.checklist?.length && updates.checklist.every((item) => item.completed)
      && task.status !== 'done'
      && (!task.sprintId || isPermittedSprintStatusChange(task.status, 'done'))) {
      const completed = await dispatchAutomation(boardId(board), 'autoCompleteSubtasks', async () => {
        const result = await store.update(task.key, { status: 'done' });
        if (result) {
          try {
            await writeAutomationHistory({
              task: result,
              actorId: userId(req),
              from: task.status,
              to: 'done',
              note: 'Task was automatically completed because every checklist item was checked off.',
            });
          } catch (historyError) {
            console.error(`[automation] could not write completion audit note for ${task.key}:`, historyError);
          }
        }
        return result;
      });
      if (completed) updatedTask = completed;
    }
    if (board && String(updatedTask.assigneeId || '') !== String(task.assigneeId || '')
      && updatedTask.assigneeId && String(updatedTask.assigneeId) !== userId(req)) {
      dispatchAutomation(boardId(board), 'taskAssignmentNotification', () => notifySafely({
        recipient: updatedTask.assigneeId,
        sender: userId(req),
        type: 'task_assigned',
        title: 'Task assigned to you',
        message: `${updatedTask.key}: ${updatedTask.title}`,
        relatedId: updatedTask._id || updatedTask.key,
        metadata: { boardId: boardId(board), taskKey: updatedTask.key }
      }));
    }
    if (board && task.status !== 'review' && updatedTask.status === 'review') {
      dispatchAutomation(boardId(board), 'taskReviewAlert', async () => {
        const recipients = new Set([String(board.ownerId), String(updatedTask.ownerId || '')]);
        recipients.delete(userId(req));
        for (const recipient of recipients) {
          if (!recipient) continue;
          await notifySafely({
            recipient,
            sender: userId(req),
            type: 'task_review',
            title: 'Task ready for review',
            message: `${updatedTask.key}: ${updatedTask.title} moved to In Review / QA.`,
            relatedId: updatedTask._id || updatedTask.key,
            metadata: { boardId: boardId(board), taskKey: updatedTask.key, status: 'review' }
          });
        }
      });
    }
    if (board) dispatchAutomation(boardId(board), 'overduePriorityEscalation', () => escalateOverdueTask(updatedTask, board));
    res.json(updatedTask);
  } catch (error) { next(error); }
});
app.delete('/api/tasks/:key', requireAuth, async (req, res, next) => {
  try {
    if (!await authorizedTask(req, res)) return;
    const result = await store.remove(req.params.key);
    res.json({ ok: result.deletedCount === 1 });
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

    const result = await chatWithContext(message, boardTasks, columns, members);
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
        let key;
        do { key = `KAN-${crypto.randomInt(100, 1000)}`; } while (await store.find(key));
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
          dueDate: item.dueDate || '',
          sprintId: null,
          storyPoints: item.storyPoints,
          aiSuggested: true,
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

    if (!getEffective('OPENROUTER_API_KEY')?.trim()) {
      return res.status(503).json({
        error: 'AI board generation is not configured. Add your OpenRouter API key in Settings or backend/.env, or create a board manually.',
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
    const result = await chatWithContext(planningMessage(input.goal, input.name), [], BOARD_COLUMNS, members);
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
        let key;
        do { key = `KAN-${crypto.randomInt(100, 1000)}`; } while (await store.find(key));
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
          dueDate: String(task.dueDate || '').slice(0, 40),
          sprintId: null,
          storyPoints: aiStoryPoints(task.storyPoints, task),
          aiSuggested: true,
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

app.post('/api/ai/sprints', requireAuth, async (req, res, next) => {
  let createdSprint = null;
  const createdTaskKeys = [];
  try {
    const goal = typeof req.body?.goal === 'string' ? req.body.goal.trim() : '';
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (goal.length < 10 || goal.length > 2000) {
      return res.status(400).json({ error: 'Sprint brief must be between 10 and 2000 characters.' });
    }
    if (name.length > 120) return res.status(400).json({ error: 'Sprint name must be 120 characters or fewer.' });
    if (!getEffective('OPENROUTER_API_KEY')?.trim()) {
      return res.status(503).json({
        error: 'AI sprint generation is not configured. Add your OpenRouter API key in Settings or backend/.env, or create the sprint manually.',
        code: 'AI_NOT_CONFIGURED'
      });
    }

    if (!req.body?.boardId) return res.status(400).json({ error: 'Select a board before generating a sprint.' });
    const board = await authorizedBoard({ ...req, params: { id: String(req.body.boardId) } }, res);
    if (!board) return;

    const members = await boardMembers(board);
    const planMessage = `Plan a prioritized 14-day engineering sprint${name ? ` named "${name}"` : ''} for this goal: ${goal}. `
      + 'Return a concise sprintGoal summarizing the milestone. Create up to 20 implementation-sized sprint tasks, each with a concrete description, risk-based priority, labels, and an estimated Fibonacci storyPoints integer (1, 2, 3, 5, 8, or 13). '
      + 'Put every task in To Do. Assign each task only to a listed team member whose skills match the task; otherwise leave it Unassigned. '
      + 'Return a create_many action with sprintGoal, not a conversational answer.';
    const result = await chatWithContext(planMessage, [], BOARD_COLUMNS, members);
    const plannedTasks = tasksFromAiResult(result);
    if (!plannedTasks.length) {
      return res.status(422).json({
        error: 'The AI planner could not create a sprint plan. Refine the brief or create the sprint manually.',
        code: 'AI_NO_PLAN'
      });
    }
    for (const task of plannedTasks) validateTaskInput(task, false);

    const startDate = todayIsoDate();
    const endDate = endDateForStart(startDate);
    createdSprint = await sprintStore.create({
      ownerId: userId(req),
      name: name || `${board.name} Sprint`,
      goal: result.action.sprintGoal || goal,
      startDate,
      endDate,
      boardId: boardId(board)
    });

    const createdTasks = [];
    for (const task of plannedTasks) {
      let assignee = String(task.assignee || 'Unassigned').trim();
      if (!assignee || assignee.toLowerCase() === 'unassigned') {
        const skilled = findBestSkilledMember(task, members);
        const fallback = skilled || pickRandomMember(members);
        assignee = fallback?.name || 'Unassigned';
      } else {
        assignee = resolveBoardAssignee(assignee, members);
      }
      let key;
      do { key = `KAN-${crypto.randomInt(100, 1000)}`; } while (await store.find(key));
      const created = await store.create({
        key,
        ownerId: userId(req),
        boardId: boardId(board),
        title: task.title.trim(),
        description: task.description || '',
        status: SPRINT_ENTRY_STATUS,
        priority: task.priority,
        labels: [...new Set(task.labels || [])],
        assignee,
        dueDate: task.dueDate || '',
        sprintId: sprintId(createdSprint),
        storyPoints: aiStoryPoints(task.storyPoints, task),
        aiSuggested: true,
        comments: [],
        attachments: [],
        dependencies: []
      });
      createdTaskKeys.push(key);
      createdTasks.push(created);
    }
    res.status(201).json({
      sprint: sprintView(createdSprint, createdTasks),
      tasksCreated: createdTasks.length
    });
  } catch (error) {
    for (const key of createdTaskKeys) await store.remove(key).catch(() => {});
    if (createdSprint) await sprintStore.remove(sprintId(createdSprint), userId(req)).catch(() => {});
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: 'Attachment is invalid or too large.' });
  if (error?.type === 'entity.too.large') return res.status(413).json({ error: 'Request body is too large.' });
  if (isAuthError(error)) return res.status(error.status).json({ error: error.message });
  console.error('Request error:', error.message);
  res.status(500).json({ error: 'An unexpected server error occurred.' });
});

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../../frontend/dist')));
  app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '../../frontend/dist/index.html')));
}

export { app, connectMongo, memoryTasks, sessions };
export const serverStarted = connectMongo()
  .then(() => {
    void scanOverdueTasks();
    const overdueScan = setInterval(() => { void scanOverdueTasks(); }, 60_000);
    overdueScan.unref();
    return app.listen(port, () => console.log(`LeadAI API listening on http://localhost:${port}`));
  })
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
    return null;
  });
