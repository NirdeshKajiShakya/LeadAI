import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import mongoose from 'mongoose';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { Task } from './models/Task.js';
import { TaskHistory } from './models/TaskHistory.js';
import { Sprint } from './models/Sprint.js';
import { Team } from './models/Team.js';
import { Notification } from './models/Notification.js';
import { endDateForStart, summarizeTasks, computeSprintDay, validateSprintRange, todayIsoDate } from './lib/sprintDates.js';
import { User, USERNAME_PATTERN } from './models/User.js';
import { connectDatabase, databaseStatus } from './db.js';
import { Board } from './models/Board.js';
import { updateTaskStatus, createTaskWithHistory, applyStatusLifecycle, emitTaskCreated, emitTaskStatusChanged, emitTaskAssigned } from './lib/taskService.js';
import { convertDueDate, migrateLegacyFields, assertMappedStatus } from './lib/taskMigration.js';
import {
  addTeamMember, removeTeamMember, listTeamMembers, updateMemberRole,
  setDatabaseReady as setTeamDatabaseReady,
  findTeamForMembership
} from './lib/teamService.js';
import {
  createAuthError, isAuthError, createUser, authenticateUser, createAuthSession,
  requireAuth, invalidateSession, revokeAllSessionsForUser, validatePassword,
  createResetToken, consumeResetToken, memoryUsers, hashPassword, setDatabaseReady,
  refreshSessionUser, serializeUser, sessions,
  findUserByEmail, findUserById
} from './auth.js';
import { chatWithContext, MAX_MESSAGE_LENGTH } from './ai.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const app = express();
const port = Number(process.env.PORT || 4000);
const uploadsDir = path.join(__dirname, '../uploads');
const allowedStatuses = ['backlog', 'todo', 'progress', 'review', 'done'];
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
  return [
    { title: 'Welcome to your LeadAI board', status: 'done', priority: 'low', labels: ['Getting Started'], assignee: name, dueDate: 'Today', description: 'This board belongs to you. Create, organize, and move tasks however you like.' },
    { title: 'Create your first task', status: 'todo', priority: 'high', labels: ['Getting Started'], assignee: name, dueDate: 'Today', description: 'Click "Add Task" to capture something you are working on. Try adding a label and a due date.' },
    { title: 'Drag a card between columns', status: 'todo', priority: 'low', labels: ['Getting Started'], assignee: name, dueDate: 'Unscheduled', description: 'Move this card from To Do into In Progress to watch the board update instantly.' },
    { title: 'Agree on a definition of done', status: 'review', priority: 'medium', labels: ['Process'], assignee: name, dueDate: 'This week', description: 'A clear definition of done keeps completed work consistent across your board.' },
    { title: 'Invite a teammate to collaborate', status: 'backlog', priority: 'medium', labels: ['Team'], assignee: 'Unassigned', dueDate: 'Unscheduled', description: 'Share your workspace so others can comment on and track shared work.' }
  ];
}
let memoryTasks = [];
let memoryHistory = [];
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
    let key;
    do { key = `KAN-${crypto.randomInt(100, 1000)}`; } while (await store.find(key));
    const assignedToSelf = template.assignee !== 'Unassigned';
    const { date } = convertDueDate(template.dueDate, todayIsoDate());
    await store.create({
      key,
      ownerId: String(user._id),
      boardId: boardId(board),
      ...template,
      assigneeId: assignedToSelf ? String(user._id) : null,
      dueDate: date,
      estimateHours: 0,
      comments: [], attachments: [], dependencies: []
    }, String(user._id), null);
  }
}

async function connectMongo() {
  const status = await connectDatabase();
  mongoReady = status.mode === 'mongodb';
  setDatabaseReady(mongoReady);
  setTeamDatabaseReady(mongoReady);
  return status;
}

const store = {
  list: () => mongoReady ? Task.find().sort({ createdAt: 1 }).lean() : Promise.resolve(memoryTasks),
  find: (key) => mongoReady ? Task.findOne({ key }) : Promise.resolve(memoryTasks.find((task) => task.key === key)),
  create: async (data, actorId = null, teamId = null) => {
    if (mongoReady) {
      // createTaskWithHistory emits task.created itself, after persistence.
      const { task } = await createTaskWithHistory({ data, actorId, teamId: teamId ?? data.sprintId ?? null });
      return task;
    }
    const now = new Date();
    const task = { ...data, _id: crypto.randomUUID(), createdAt: now, updatedAt: now };
    applyStatusLifecycle(task, task.status || 'backlog', now);
    memoryTasks = [...memoryTasks, task];
    if (actorId) {
      memoryHistory.push({ _id: crypto.randomUUID(), taskId: task._id, teamId: teamId ?? task.sprintId ?? null, from: null, to: task.status, actorId, at: now });
    }
    // Emitted only after the task is committed to the in-memory store.
    emitTaskCreated({ task, actorId, teamId: teamId ?? task.sprintId ?? null, at: task.createdAt });
    return task;
  },
  update: async (key, data, actorId = null, teamId = null, requesterRole = 'member') => {
    if (mongoReady) {
      const existing = await Task.findOne({ key });
      if (!existing) return null;
      const previousAssigneeId = existing.assigneeId ?? null;
      const { status: newStatus, ...rest } = data;
      if (Object.keys(rest).length) await Task.updateOne({ key }, { $set: rest }, { runValidators: true });
      if (newStatus !== undefined) {
        // All status mutations are funneled through the centralized service,
        // which emits task.status_changed after the transition commits.
        await updateTaskStatus({
          taskId: existing._id,
          teamId: teamId ?? rest.sprintId ?? existing.sprintId ?? null,
          newStatus,
          actorId,
          userId: actorId,
          requesterRole
        });
      }
      const updated = await Task.findOne({ key });
      // Assignment event is derived from the persisted result and only fires
      // when the assignee reference actually changed (see emitTaskAssigned).
      emitTaskAssigned({ task: updated, previousAssigneeId, actorId, at: updated.updatedAt });
      return updated;
    }
    const current = memoryTasks.find((task) => task.key === key);
    if (!current) return null;
    const now = new Date();
    const previousAssigneeId = current.assigneeId ?? null;
    const { status: newStatus, ...rest } = data;
    const next = { ...current, ...rest, updatedAt: now };
    const statusChanged = newStatus !== undefined && newStatus !== current.status;
    if (statusChanged) {
      assertMappedStatus(newStatus);
      applyStatusLifecycle(next, newStatus, now);
      if (actorId) {
        memoryHistory.push({ _id: crypto.randomUUID(), taskId: next._id, teamId: teamId ?? next.sprintId ?? null, from: current.status, to: newStatus, actorId, at: now });
      }
    }
    memoryTasks = memoryTasks.map((task) => task.key === key ? next : task);
    // Events are emitted only after the write above committed.
    if (statusChanged) {
      emitTaskStatusChanged({ task: next, from: current.status, to: newStatus, actorId, teamId: teamId ?? next.sprintId ?? null, at: now });
    }
    emitTaskAssigned({ task: next, previousAssigneeId, actorId, at: now });
    return next;
  },
  remove: async (key) => {
    if (mongoReady) return Task.deleteOne({ key });
    const before = memoryTasks.length;
    memoryTasks = memoryTasks.filter((task) => task.key !== key);
    return { deletedCount: before - memoryTasks.length };
  },
  listBySprint: (id) => mongoReady ? Task.find({ sprintId: id }).sort({ createdAt: 1 }).lean() : Promise.resolve(memoryTasks.filter((task) => String(task.sprintId) === String(id))),
  // Board and profile queries are owner-scoped in the database; a shared database must
  // never require loading every developer's tasks to show one person's board.
  listByOwner: (ownerId) => mongoReady ? Task.find({ ownerId }).sort({ createdAt: 1 }).lean() : Promise.resolve(memoryTasks.filter((task) => String(task.ownerId) === String(ownerId))),
  listWithoutSprint: (ownerId) => {
    if (!mongoReady) return Promise.resolve(memoryTasks.filter((task) => !task.sprintId && (!ownerId || String(task.ownerId) === String(ownerId))));
    return Task.find(ownerId ? { sprintId: null, ownerId } : { sprintId: null }).sort({ createdAt: 1 }).lean();
  }
};

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

function userId(req) { return String(req.user._id); }
async function boardMembers(board) {
  const members = await Promise.all((board.memberIds || []).map((id) => findUserById(id)));
  return members.filter(Boolean).map((member) => ({
    id: String(member._id),
    name: String(member.name || member.email),
    email: String(member.email)
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
  if (body.assignee !== undefined && body.assignee !== null && (typeof body.assignee !== 'string' || body.assignee.trim().length > 120)) throw createAuthError(400, 'Assignee must be text up to 120 characters.');
  if (body.assigneeId !== undefined && body.assigneeId !== null && (typeof body.assigneeId !== 'string' || !/^[a-zA-Z0-9_-]{8,64}$/.test(body.assigneeId))) throw createAuthError(400, 'Invalid assignee id.');
  if (body.dueDate !== undefined && body.dueDate !== null && (typeof body.dueDate !== 'string' || body.dueDate.length > 40)) throw createAuthError(400, 'Due date must be text up to 40 characters.');
  if (body.estimateHours !== undefined && body.estimateHours !== null && (typeof body.estimateHours !== 'number' || !Number.isFinite(body.estimateHours) || body.estimateHours < 0 || body.estimateHours > 1000)) throw createAuthError(400, 'Estimate must be a number of hours from 0 to 1000.');
  if (body.sprintId !== undefined && (body.sprintId !== null && (typeof body.sprintId !== 'string' || !/^[a-zA-Z0-9_-]{8,}$/.test(body.sprintId)))) throw createAuthError(400, 'Invalid sprint id.');
    if (body.teamId !== undefined && (body.teamId !== null && (typeof body.teamId !== 'string' || !/^[a-zA-Z0-9_-]{8,}$/.test(body.teamId)))) throw createAuthError(400, 'Invalid team id.');
  if (body.storyPoints !== undefined && (!Number.isInteger(body.storyPoints) || body.storyPoints < 0 || body.storyPoints > 100)) throw createAuthError(400, 'Story points must be an integer from 0 to 100.');
}
function validTaskKey(key) { return typeof key === 'string' && /^KAN-[A-Z0-9]+$/i.test(key); }
function taskUpdates(body) {
  return Object.fromEntries(['title', 'description', 'status', 'priority', 'labels', 'assignee', 'assigneeId', 'dueDate', 'estimateHours', 'sprintId', 'storyPoints', 'teamId'].filter((field) => body[field] !== undefined).map((field) => [field, body[field]]));
}

// Resolves an incoming assignee reference to the persisted pair
// { assigneeId, assignee } (id + display name). Returns null when the
// provided assigneeId does not correspond to a real user (HTTP 400 path).
// Legacy clients may send only the display name; that keeps assigneeId null.
async function resolveAssigneeFields(req, rawAssigneeId, legacyAssignee) {
  if (rawAssigneeId !== undefined && rawAssigneeId !== null && rawAssigneeId !== '') {
    const id = String(rawAssigneeId);
    if (!mongoReady) {
      // Without Mongo the signed-in user is the only known account.
      if (id !== userId(req)) return null;
      return { assigneeId: id, assignee: String(req.user.name || legacyAssignee || 'Unassigned').slice(0, 120) };
    }
    const user = await User.findById(id);
    if (!user) return null;
    return { assigneeId: user._id.toString(), assignee: String(user.name || 'Unassigned').slice(0, 120) };
  }
  return { assigneeId: null, assignee: String(legacyAssignee || 'Unassigned').slice(0, 120) };
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
    const teamId = req.body?.teamId ? String(req.body.teamId) : null;
    if (teamId && !/^[a-zA-Z0-9_-]{8,}$/.test(teamId)) return res.status(400).json({ error: 'Invalid team id.' });
    const sprintData = { ownerId: userId(req), name, goal, startDate, endDate };
    if (teamId) sprintData.teamId = teamId;
    res.status(201).json(sprintView(await sprintStore.create(sprintData), []));
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
    const tasks = await store.listBySprint(sprintId(sprint));
    res.json((await Promise.all(tasks.map(async (task) => (await canAccess(task, req)) ? task : null))).filter(Boolean));
  } catch (error) { next(error); }
});
app.get('/api/backlog', requireAuth, async (req, res, next) => {
  try {
    const tasks = await store.listWithoutSprint();
    res.json((await Promise.all(tasks.map(async (task) => (await canAccess(task, req)) ? task : null))).filter(Boolean));
  } catch (error) { next(error); }
});
app.post('/api/sprints/:id/tasks', requireAuth, async (req, res, next) => {
  try {
    const sprint = await authorizedSprint(req, res);
    if (!sprint) return;
    const key = String(req.body?.key || '');
    const task = await store.find(key);
    if (!task || !(await canAccess(task, req))) return res.status(404).json({ error: 'Task not found.' });
    const updated = await store.update(key, { sprintId: sprintId(sprint) }, userId(req), sprintId(sprint), req.role);
    res.status(201).json(updated);
  } catch (error) { next(error); }
});
app.delete('/api/sprints/:id/tasks/:key', requireAuth, async (req, res, next) => {
  try {
    const sprint = await authorizedSprint(req, res);
    if (!sprint) return;
    const task = await store.find(req.params.key);
    if (!task || !(await canAccess(task, req)) || String(task.sprintId) !== sprintId(sprint)) return res.status(404).json({ error: 'Task not found in sprint.' });
    await store.update(task.key, { sprintId: null }, userId(req), null, req.role);
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
app.post('/api/tasks', requireAuth, async (req, res, next) => {
  try {
    validateTaskInput(req.body || {});
    const board = req.body.boardId ? await authorizedBoard({ ...req, params: { id: req.body.boardId } }, res) : await defaultBoardFor(req);
    if (!board) return res.status(404).json({ error: 'Create a board before adding tasks.' });
    if (req.body.sprintId && !await sprintStore.find(req.body.sprintId, userId(req))) return res.status(404).json({ error: 'Sprint not found.' });
    const teamId = req.body?.teamId ? String(req.body.teamId) : null;
    if (teamId && !/^[a-zA-Z0-9_-]{8,}$/.test(teamId)) return res.status(400).json({ error: 'Invalid team id.' });
    const assigneeFields = await resolveAssigneeFields(req, req.body.assigneeId, req.body.assignee);
    if (!assigneeFields) return res.status(400).json({ error: 'Invalid assignee id.' });
    const due = convertDueDate(req.body.dueDate ?? '', todayIsoDate());
    if (due.reason) return res.status(400).json({ error: `Due date could not be parsed: ${due.reason.replace('cannot parse: ', '')}.` });
    let key;
    do { key = `KAN-${crypto.randomInt(100, 1000)}`; } while (await store.find(key));
    const task = await store.create({
      key, ownerId: userId(req), boardId: boardId(board), title: req.body.title.trim(), description: (req.body.description || '').slice(0, 4000),
      status: req.body.status || 'backlog', priority: req.body.priority || 'medium',
      labels: [...new Set(req.body.labels || [])],
      assignee: assigneeFields.assignee, assigneeId: assigneeFields.assigneeId,
      dueDate: due.date, estimateHours: Number.isFinite(req.body.estimateHours) ? req.body.estimateHours : 0,
      sprintId: req.body.sprintId || null, storyPoints: req.body.storyPoints || 0,
      comments: [], attachments: [], dependencies: []
    }, userId(req), teamId);
    res.status(201).json(task);
  } catch (error) { next(error); }
});
app.patch('/api/tasks/:key', requireAuth, async (req, res, next) => {
  try {
    const task = await authorizedTask(req, res);
    if (!task) return;
    validateTaskInput(req.body || {}, true);
    if (req.body.sprintId && !await sprintStore.find(req.body.sprintId, userId(req))) return res.status(404).json({ error: 'Sprint not found.' });
    const updates = taskUpdates(req.body);
    if (updates.title !== undefined) updates.title = updates.title.trim();
    if (updates.labels) updates.labels = [...new Set(updates.labels)];
    if (updates.assigneeId !== undefined || updates.assignee !== undefined) {
      const assigneeFields = await resolveAssigneeFields(req, updates.assigneeId, updates.assignee);
      if (!assigneeFields) return res.status(400).json({ error: 'Invalid assignee id.' });
      updates.assigneeId = assigneeFields.assigneeId;
      updates.assignee = assigneeFields.assignee;
    }
    if (updates.dueDate !== undefined) {
      const due = convertDueDate(updates.dueDate, todayIsoDate());
      if (due.reason) return res.status(400).json({ error: `Due date could not be parsed: ${due.reason.replace('cannot parse: ', '')}.` });
      updates.dueDate = due.date;
    }
    if (updates.estimateHours !== undefined && updates.estimateHours !== null) updates.estimateHours = Number(updates.estimateHours);
    // Status changes (and only status changes) flow through the centralized
    // service inside store.update; everything else is a plain field update.
    const updated = await store.update(task.key, updates, userId(req), updates.teamId ? String(updates.teamId) : (task.sprintId ? String(task.sprintId) : null), req.role);
    if (!updated) return res.status(404).json({ error: 'Task not found.' });
    res.json(updated);
  } catch (error) { next(error); }
});
app.delete('/api/tasks/:key', requireAuth, async (req, res, next) => {
  try {
    if (!await authorizedTask(req, res)) return;
    const result = await store.remove(req.params.key);
    res.json({ ok: result.deletedCount === 1 });
  } catch (error) { next(error); }
});

const historyChronological = (a, b) => new Date(a.at).getTime() - new Date(b.at).getTime();

// J1: per-task status history (creation entry + every transition).
app.get('/api/tasks/:key/history', requireAuth, async (req, res, next) => {
  try {
    const task = await authorizedTask(req, res);
    if (!task) return;
    if (mongoReady) {
      return res.json(await TaskHistory.find({ taskId: task._id }).sort({ at: 1 }).lean());
    }
    res.json(memoryHistory
      .filter((entry) => String(entry.taskId) === String(task._id))
      .sort(historyChronological));
  } catch (error) { next(error); }
});

// J1: team-wide history. "Team" maps to a sprint in this codebase, so the
// id is validated and ownership is enforced through the sprint store.
app.get('/api/teams/:teamId/history', requireAuth, async (req, res, next) => {
  try {
    const teamId = String(req.params.teamId || '');
    if (!/^[a-zA-Z0-9_-]{8,}$/.test(teamId)) return res.status(400).json({ error: 'Invalid team id.' });
    const sprint = await sprintStore.find(teamId, userId(req));
    if (!sprint) return res.status(404).json({ error: 'Team not found.' });
    if (mongoReady) {
      return res.json(await TaskHistory.find({ teamId: sprint._id }).sort({ at: 1 }).lean());
    }
    const memberTaskIds = new Set((await store.listBySprint(sprintId(sprint))).map((task) => String(task._id)));
    res.json(memoryHistory
      .filter((entry) => String(entry.teamId) === String(teamId) || memberTaskIds.has(String(entry.taskId)))
      .sort(historyChronological));
  } catch (error) { next(error); }
});

// Team management. A "team" is an enduring workspace — distinct from a sprint
// lib/teamService.js, which emits member.joined / member.left only after the
// write commits. Authorization: team owners and admins manage membership;
// members may always remove themselves (leave a team).
const validMemberId = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{8,64}$/.test(value);

function isTeamOwnerOrAdmin(team, req) {
  return String(team.ownerId) === userId(req) || req.role === 'admin';
}

function canManageTeam(team, req) {
  return isTeamOwnerOrAdmin(team, req);
}

// ---- List teams the current user belongs to (as owner or member) ---------
app.get('/api/teams', requireAuth, async (req, res, next) => {
  try {
    let teams;
    if (mongoReady) {
      const owned = await Team.find({ ownerId: userId(req) }).lean();
      const memberships = await TeamMember.find({ userId: userId(req) }).lean();
      const memberTeamIds = new Set(memberships.map((m) => String(m.teamId)));
      const fullTeams = await Promise.all(
        [...memberTeamIds].map((id) => Team.findById(id).lean())
      );
      teams = [...owned, ...fullTeams.filter((t) => t && !owned.some((o) => String(o._id) === String(t._id)))];
    } else {
      const ownedSprints = memorySprints.filter((s) => String(s.ownerId) === userId(req));
      const ownedTeams = ownedSprints.map((s) => ({ _id: sprintId(s), name: s.name, ownerId: s.ownerId }));
      const memberships = memoryTeamMembers.filter((m) => String(m.userId) === userId(req));
      const memberTeamIds = new Set(memberships.map((m) => String(m.teamId)));
      const memberTeams = [];
      for (const teamId of memberTeamIds) {
        const sprint = memorySprints.find((s) => sprintId(s) === teamId);
        if (sprint) memberTeams.push({ _id: teamId, name: sprint.name, ownerId: sprint.ownerId });
      }
      teams = [...ownedTeams, ...memberTeams];
    }
    res.json(teams);
  } catch (error) { next(error); }
});

// ---- Create a team -------------------------------------------------------
app.post('/api/teams', requireAuth, async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name || name.length > 120) return res.status(400).json({ error: 'Team name must be between 1 and 120 characters.' });
    const actorId = userId(req);
    let team;
    if (mongoReady) {
      team = await Team.create({ name, ownerId: actorId });
    } else {
      team = { _id: `mem-team-${Date.now()}-${crypto.randomInt(100, 999)}`, name, ownerId: actorId, createdAt: new Date() };
      if (!globalThis.__memoryTeams) globalThis.__memoryTeams = [];
      globalThis.__memoryTeams.push(team);
    }
    res.status(201).json({ _id: String(team._id), name: team.name, ownerId: String(team.ownerId), role: 'owner' });
  } catch (error) { next(error); }
});

app.post('/api/teams/:teamId/members', requireAuth, async (req, res, next) => {
  try {
    const teamId = String(req.params.teamId || '');
    if (!/^[a-zA-Z0-9_-]{8,}$/.test(teamId)) return res.status(400).json({ error: 'Invalid team id.' });
    const userIdParam = String(req.body?.userId || '');
    if (!validMemberId(userIdParam)) return res.status(400).json({ error: 'Invalid user id.' });
    const team = await findTeamForMembership(teamId);
    // Teams stay invisible to non-members: unknown and unauthorized share 404.
    if (!team) return res.status(404).json({ error: 'Team not found.' });
    if (!canManageTeam(team, req)) return res.status(404).json({ error: 'Team not found.' });
    if (String(team.ownerId) === userIdParam) return res.status(409).json({ error: 'The team owner is already part of the team.' });
    if (!await findUserById(userIdParam)) return res.status(404).json({ error: 'User not found.' });
    const { created, membership } = await addTeamMember({ teamId, userId: userIdParam, actorId: userId(req) });
    // Adding an existing member is a no-op (no duplicate join event).
    if (!created) return res.status(409).json({ error: 'User is already part of this team.' });
    res.status(201).json({ teamId: String(membership.teamId), userId: String(membership.userId), role: membership.role, joinedAt: membership.joinedAt });
  } catch (error) { next(error); }
});

app.delete('/api/teams/:teamId/members/:userId', requireAuth, async (req, res, next) => {
  try {
    const teamId = String(req.params.teamId || '');
    if (!/^[a-zA-Z0-9_-]{8,}$/.test(teamId)) return res.status(400).json({ error: 'Invalid team id.' });
    const userIdParam = String(req.params.userId || '');
    if (!validMemberId(userIdParam)) return res.status(400).json({ error: 'Invalid user id.' });
    const team = await findTeamForMembership(teamId);
    if (!team) return res.status(404).json({ error: 'Team not found.' });
    // Members may always leave; removing anyone else needs owner or admin.
    const isSelf = userIdParam === userId(req);
    if (!isSelf && !canManageTeam(team, req)) return res.status(404).json({ error: 'Team not found.' });
    if (String(team.ownerId) === userIdParam) return res.status(403).json({ error: 'The team owner cannot be removed from the team.' });
    const { removed } = await removeTeamMember({ teamId, userId: userIdParam, actorId: userId(req) });
    // Removing a membership that does not exist is a no-op (no false leave event).
    if (!removed) return res.status(404).json({ error: 'Membership not found.' });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

// ---- Get team details + members ------------------------------------------
app.get('/api/teams/:teamId', requireAuth, async (req, res, next) => {
  try {
    const teamId = String(req.params.teamId || '');
    if (!/^[a-zA-Z0-9_-]{8,}$/.test(teamId)) return res.status(400).json({ error: 'Invalid team id.' });
    const team = await findTeamForMembership(teamId);
    if (!team) return res.status(404).json({ error: 'Team not found.' });
    const isOwner = String(team.ownerId) === userId(req);
    if (!isOwner && req.role !== 'admin') {
      const memberships = await listTeamMembers(teamId);
      if (!memberships.some((m) => String(m.userId) === userId(req))) return res.status(404).json({ error: 'Team not found.' });
    }
    const memberships = await listTeamMembers(teamId);
    res.json({
      _id: String(team._id),
      name: team.name,
      ownerId: String(team.ownerId),
      isOwner,
      members: memberships.map((m) => ({ userId: String(m.userId), role: m.role, addedBy: String(m.addedBy), joinedAt: m.joinedAt }))
    });
  } catch (error) { next(error); }
});

// ---- Update team name (owner/admin only) ---------------------------------
app.patch('/api/teams/:teamId', requireAuth, async (req, res, next) => {
  try {
    const teamId = String(req.params.teamId || '');
    if (!/^[a-zA-Z0-9_-]{8,}$/.test(teamId)) return res.status(400).json({ error: 'Invalid team id.' });
    const team = await findTeamForMembership(teamId);
    if (!team) return res.status(404).json({ error: 'Team not found.' });
    if (!canManageTeam(team, req)) return res.status(403).json({ error: 'You do not have permission to update this team.' });
    const name = String(req.body?.name || '').trim();
    if (!name || name.length > 120) return res.status(400).json({ error: 'Team name must be between 1 and 120 characters.' });
    if (mongoReady) {
      const updated = await Team.findByIdAndUpdate(teamId, { $set: { name } }, { new: true }).lean();
      res.json({ _id: String(updated._id), name: updated.name, ownerId: String(updated.ownerId) });
    } else {
      if (globalThis.__memoryTeams) {
        const t = globalThis.__memoryTeams.find((t) => String(t._id) === teamId);
        if (t) t.name = name;
      }
      res.json({ _id: teamId, name, ownerId: String(team.ownerId) });
    }
  } catch (error) { next(error); }
});

// ---- Delete a team (owner only) ------------------------------------------
app.delete('/api/teams/:teamId', requireAuth, async (req, res, next) => {
  try {
    const teamId = String(req.params.teamId || '');
    if (!/^[a-zA-Z0-9_-]{8,}$/.test(teamId)) return res.status(400).json({ error: 'Invalid team id.' });
    const team = await findTeamForMembership(teamId);
    if (!team) return res.status(404).json({ error: 'Team not found.' });
    if (String(team.ownerId) !== userId(req) && req.role !== 'admin') {
      return res.status(403).json({ error: 'Only the team owner or an admin may delete a team.' });
    }
    if (mongoReady) {
      await TeamMember.deleteMany({ teamId });
      await Team.deleteOne({ _id: teamId });
      await Task.updateMany({ teamId }, { $set: { teamId: null } });
      await Sprint.updateMany({ teamId }, { $set: { teamId: null } });
    } else {
      if (globalThis.__memoryTeams) {
        globalThis.__memoryTeams = globalThis.__memoryTeams.filter((t) => String(t._id) !== teamId);
      }
      memoryTeamMembers = memoryTeamMembers.filter((m) => String(m.teamId) !== teamId);
      memoryTasks = memoryTasks.map((t) => String(t.teamId) === teamId ? { ...t, teamId: null } : t);
      memorySprints = memorySprints.map((s) => String(s.teamId) === teamId ? { ...s, teamId: null } : s);
    }
    res.json({ ok: true });
  } catch (error) { next(error); }
});

// ---- List team members ---------------------------------------------------
app.get('/api/teams/:teamId/members', requireAuth, async (req, res, next) => {
  try {
    const teamId = String(req.params.teamId || '');
    if (!/^[a-zA-Z0-9_-]{8,}$/.test(teamId)) return res.status(400).json({ error: 'Invalid team id.' });
    const team = await findTeamForMembership(teamId);
    if (!team) return res.status(404).json({ error: 'Team not found.' });
    const isOwner = String(team.ownerId) === userId(req);
    if (!isOwner && req.role !== 'admin') {
      const memberships = await listTeamMembers(teamId);
      if (!memberships.some((m) => String(m.userId) === userId(req))) return res.status(404).json({ error: 'Team not found.' });
    }
    const memberships = await listTeamMembers(teamId);
    res.json(memberships.map((m) => ({
      userId: String(m.userId),
      role: m.role,
      addedBy: String(m.addedBy),
      joinedAt: m.joinedAt
    })));
  } catch (error) { next(error); }
});

// ---- Update a member's role (owner/admin only) ---------------------------
app.patch('/api/teams/:teamId/members/:userId/role', requireAuth, async (req, res, next) => {
  try {
    const teamId = String(req.params.teamId || '');
    if (!/^[a-zA-Z0-9_-]{8,}$/.test(teamId)) return res.status(400).json({ error: 'Invalid team id.' });
    const userIdParam = String(req.params.userId || '');
    if (!validMemberId(userIdParam)) return res.status(400).json({ error: 'Invalid user id.' });
    const team = await findTeamForMembership(teamId);
    if (!team) return res.status(404).json({ error: 'Team not found.' });
    if (!canManageTeam(team, req)) return res.status(404).json({ error: 'Team not found.' });
    if (String(team.ownerId) === userIdParam) return res.status(403).json({ error: 'The team owner role cannot be changed.' });
    const role = String(req.body?.role || '');
    if (!['admin', 'member'].includes(role)) return res.status(400).json({ error: 'Role must be "admin" or "member".' });
    const { updated } = await updateMemberRole({ teamId, userId: userIdParam, actorId: userId(req), role });
    if (!updated) return res.status(404).json({ error: 'Membership not found.' });
    res.json({ ok: true, userId: userIdParam, role });
  } catch (error) { next(error); }
});

// History is an audit trail: only admins may clear it.
app.delete('/api/tasks/:key/history', requireAuth, async (req, res, next) => {
  try {
    const task = await authorizedTask(req, res);
    if (!task) return;
    if (req.role !== 'admin') return res.status(403).json({ error: 'Only admins may clear task history.' });
    if (mongoReady) {
      await TaskHistory.deleteMany({ taskId: task._id });
    } else {
      memoryHistory = memoryHistory.filter((entry) => String(entry.taskId) !== String(task._id));
    }
    res.json({ ok: true });
  } catch (error) { next(error); }
});

// J2 maintenance endpoint: converts legacy assignee/due-date values in place.
// Idempotent, so it is safe to run repeatedly (e.g. after restores).
app.post('/api/admin/migrate-tasks', requireAuth, async (req, res, next) => {
  try {
    if (req.role !== 'admin') return res.status(403).json({ error: 'Only admins may run maintenance migrations.' });
    if (!mongoReady) return res.status(503).json({ error: 'Migration requires a MongoDB connection.' });
    res.json(await migrateLegacyFields());
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

    const columns = [
      { id: 'backlog', label: 'Backlog', color: 'slate', hint: 'Shape the next move' },
      { id: 'todo', label: 'To Do', color: 'cyan', hint: 'Ready to pick up' },
      { id: 'progress', label: 'In Progress', color: 'violet', hint: 'Active execution' },
      { id: 'review', label: 'In Review / QA', color: 'blue', hint: 'Validate and ship' },
      { id: 'done', label: 'Done', color: 'green', hint: 'Verified outcomes' },
    ];

    const result = await chatWithContext(message, boardTasks, columns, members);
    if (result.action?.type === 'create' || result.action?.type === 'create_many') {
      const requestedTasks = result.action.type === 'create' ? [result.action] : result.action.tasks;
      requestedTasks.forEach((item) => {
        validateTaskInput(item, false);
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
          storyPoints: 0,
          comments: [],
          attachments: [],
          dependencies: []
        }));
      }
      result.action = { type: 'created_many', keys: created.map((item) => item.key) };
      result.matchedTask = created.length === 1 ? { key: created[0].key, title: created[0].title, columnName: columns.find((column) => column.id === created[0].status).label } : null;
      result.reply = `Created ${created.length} tasks on the board: ${created.map((item) => `#${item.key} “${item.title}”`).join(', ')}.`;
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

// `store` and `serverStarted` are exported for tests: the service-level
// store lets tests exercise assignment/status paths directly, and awaiting
// `serverStarted` gives tests a handle to close instead of killing a child
// process.
export { app, connectMongo, memoryTasks, memoryHistory, sessions, store, findTeamForMembership };
const serverStarted = connectMongo()
  .then(() => app.listen(port, () => console.log(`LeadAI API listening on http://localhost:${port}`)))
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
export { serverStarted };
//
// Notification API Routes
//

app.get('/api/notifications/unread', requireAuth, async (req, res, next) => {
  try {
    const userId = userId(req);
    const { page = 1, limit = 20 } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const [notifications, total] = await Promise.all([
      Notification.find({ userId, read: false })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      Notification.countDocuments({ userId, read: false })
    ]);

    res.json({
      notifications,
      total,
      page: Number(page),
      pages: Math.ceil(total / Number(limit))
    });
  } catch (error) { next(error); }
});

app.get('/api/notifications', requireAuth, async (req, res, next) => {
  try {
    const userId = userId(req);
    const { page = 1, limit = 20, read } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const filter = {};
    if (read !== undefined) filter.read = read === 'true';
    if (read === undefined) filter.read = false;

    const [notifications, total] = await Promise.all([
      Notification.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      Notification.countDocuments(filter)
    ]);

    res.json({
      notifications,
      total,
      page: Number(page),
      pages: Math.ceil(total / Number(limit))
    });
  } catch (error) { next(error); }
});

app.patch('/api/notifications/:id/read', requireAuth, async (req, res, next) => {
  try {
    const userId = userId(req);
    const { id } = req.params;

    const notification = await Notification.findOneAndUpdate(
      { _id: id, userId },
      { read: true, readAt: new Date() },
      { new: true, runValidators: true }
    );

    if (!notification) return res.status(404).json({ error: 'Notification not found.' });

    res.json({ notification });
  } catch (error) { next(error); }
});

app.patch('/api/notifications/read-all', requireAuth, async (req, res, next) => {
  try {
    const userId = userId(req);
    await Notification.updateMany({ userId, read: false }, { read: true, readAt: new Date() });
    res.json({ ok: true });
  } catch (error) { next(error); }
});
