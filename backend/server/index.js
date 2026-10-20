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
import { endDateForStart, summarizeTasks, computeSprintDay, validateSprintRange, todayIsoDate } from './lib/sprintDates.js';
import { User } from './models/User.js';
import { updateTaskStatus, createTaskWithHistory, applyStatusLifecycle, emitTaskCreated, emitTaskStatusChanged, emitTaskAssigned } from './lib/taskService.js';
import { convertDueDate, migrateLegacyFields, assertMappedStatus } from './lib/taskMigration.js';
import { addTeamMember, removeTeamMember, setDatabaseReady as setTeamDatabaseReady } from './lib/teamService.js';
import {
  createAuthError, isAuthError, createUser, authenticateUser, createAuthSession,
  requireAuth, invalidateSession, revokeAllSessionsForUser, validatePassword,
  createResetToken, consumeResetToken, memoryUsers, hashPassword, setDatabaseReady,
  sessions
} from './auth.js';

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
function seedSprint(ownerId) {
  const start = new Date(`${todayIsoDate()}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 3);
  const startDate = start.toISOString().slice(0, 10);
  return {
    name: 'Q3 Product Engineering Sprint 14',
    goal: 'Ship the core orchestration engine v2.4 with a working LLM fallback matrix.',
    startDate,
    endDate: endDateForStart(startDate),
    ownerId: String(ownerId),
    createdAt: new Date()
  };
}
const sprintId = (sprint) => String(sprint._id ?? sprint.id);
let memorySprintCounter = 0;
function withSprintId(sprint) {
  return sprint._id ? sprint : { ...sprint, _id: `mem-sprint-${Date.now()}-${++memorySprintCounter}` };
}
async function seedStarterTasks(user) {
  for (const template of starterTasksFor(user)) {
    let key;
    do { key = `KAN-${crypto.randomInt(100, 1000)}`; } while (await store.find(key));
    const assignedToSelf = template.assignee !== 'Unassigned';
    const { date } = convertDueDate(template.dueDate, todayIsoDate());
    await store.create({
      key,
      ownerId: String(user._id),
      ...template,
      assigneeId: assignedToSelf ? String(user._id) : null,
      dueDate: date,
      estimateHours: 0,
      comments: [], attachments: [], dependencies: []
    }, String(user._id), null);
  }
}

async function connectMongo() {
  if (!process.env.MONGODB_URI) {
    return;
  }
  try {
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 1500 });
    mongoReady = true;
    setDatabaseReady(true);
    setTeamDatabaseReady(true);
    console.log('MongoDB connected');
  } catch (error) {
    console.warn(`MongoDB unavailable, using in-memory storage: ${error.message}`);
  }
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
  listWithoutSprint: () => mongoReady ? Task.find({ sprintId: null }).sort({ createdAt: 1 }).lean() : Promise.resolve(memoryTasks.filter((task) => !task.sprintId))
};

const sprintStore = {
  list: (ownerId) => mongoReady ? Sprint.find({ ownerId }).sort({ createdAt: 1 }).lean() : Promise.resolve(memorySprints.filter((sprint) => String(sprint.ownerId) === String(ownerId))),
  find: (id, ownerId) => mongoReady ? Sprint.findOne({ _id: id, ownerId }).lean() : Promise.resolve(memorySprints.find((sprint) => sprintId(sprint) === String(id) && String(sprint.ownerId) === String(ownerId))),
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
function canAccess(task, req) { return String(task.ownerId) === userId(req) || req.role === 'admin'; }
async function authorizedTask(req, res) {
  if (!validTaskKey(req.params.key)) { res.status(400).json({ error: 'Invalid task key.' }); return null; }
  const task = await store.find(req.params.key);
  if (!task) { res.status(404).json({ error: 'Task not found.' }); return null; }
  if (!canAccess(task, req)) { res.status(403).json({ error: 'You do not have access to this task.' }); return null; }
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
  if (body.storyPoints !== undefined && (!Number.isInteger(body.storyPoints) || body.storyPoints < 0 || body.storyPoints > 100)) throw createAuthError(400, 'Story points must be an integer from 0 to 100.');
}
function validTaskKey(key) { return typeof key === 'string' && /^KAN-[A-Z0-9]+$/i.test(key); }
function taskUpdates(body) {
  return Object.fromEntries(['title', 'description', 'status', 'priority', 'labels', 'assignee', 'assigneeId', 'dueDate', 'estimateHours', 'sprintId', 'storyPoints'].filter((field) => body[field] !== undefined).map((field) => [field, body[field]]));
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

app.get('/api/health', (_req, res) => res.json({ ok: true, database: mongoReady ? 'mongodb' : 'memory' }));

app.post('/api/auth/signup', async (req, res, next) => {
  try {
    const user = await createUser(req.body || {});
    await seedStarterTasks(user);
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
    const tasks = await store.listBySprint(sprintId(sprint));
    res.json(tasks.filter((task) => canAccess(task, req)));
  } catch (error) { next(error); }
});
app.get('/api/backlog', requireAuth, async (req, res, next) => {
  try {
    const tasks = await store.listWithoutSprint();
    res.json(tasks.filter((task) => canAccess(task, req)));
  } catch (error) { next(error); }
});
app.post('/api/sprints/:id/tasks', requireAuth, async (req, res, next) => {
  try {
    const sprint = await authorizedSprint(req, res);
    if (!sprint) return;
    const key = String(req.body?.key || '');
    const task = await store.find(key);
    if (!task || !canAccess(task, req)) return res.status(404).json({ error: 'Task not found.' });
    const updated = await store.update(key, { sprintId: sprintId(sprint) }, userId(req), sprintId(sprint), req.role);
    res.status(201).json(updated);
  } catch (error) { next(error); }
});
app.delete('/api/sprints/:id/tasks/:key', requireAuth, async (req, res, next) => {
  try {
    const sprint = await authorizedSprint(req, res);
    if (!sprint) return;
    const task = await store.find(req.params.key);
    if (!task || !canAccess(task, req) || String(task.sprintId) !== sprintId(sprint)) return res.status(404).json({ error: 'Task not found in sprint.' });
    await store.update(task.key, { sprintId: null }, userId(req), null, req.role);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.get('/api/tasks', requireAuth, async (req, res, next) => {
  try {
    const tasks = await store.list();
    res.json(tasks.filter((task) => canAccess(task, req)));
  } catch (error) { next(error); }
});
app.post('/api/tasks', requireAuth, async (req, res, next) => {
  try {
    validateTaskInput(req.body || {});
    if (req.body.sprintId && !await sprintStore.find(req.body.sprintId, userId(req))) return res.status(404).json({ error: 'Sprint not found.' });
    const assigneeFields = await resolveAssigneeFields(req, req.body.assigneeId, req.body.assignee);
    if (!assigneeFields) return res.status(400).json({ error: 'Invalid assignee id.' });
    const due = convertDueDate(req.body.dueDate ?? '', todayIsoDate());
    if (due.reason) return res.status(400).json({ error: `Due date could not be parsed: ${due.reason.replace('cannot parse: ', '')}.` });
    let key;
    do { key = `KAN-${crypto.randomInt(100, 1000)}`; } while (await store.find(key));
    const task = await store.create({
      key, ownerId: userId(req), title: req.body.title.trim(), description: (req.body.description || '').slice(0, 4000),
      status: req.body.status || 'backlog', priority: req.body.priority || 'medium',
      labels: [...new Set(req.body.labels || [])],
      assignee: assigneeFields.assignee, assigneeId: assigneeFields.assigneeId,
      dueDate: due.date, estimateHours: Number.isFinite(req.body.estimateHours) ? req.body.estimateHours : 0,
      sprintId: req.body.sprintId || null, storyPoints: req.body.storyPoints || 0,
      comments: [], attachments: [], dependencies: []
    }, userId(req), req.body.sprintId || null);
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
    const updated = await store.update(task.key, updates, userId(req), task.sprintId ? String(task.sprintId) : null, req.role);
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

// Team membership ("team" == sprint). Membership writes live in
// lib/teamService.js, which emits member.joined / member.left only after the
// write commits. Authorization preserves the existing sprint model: team
// management is visible to the owner (and admins); members may always remove
// themselves (leave a team).
const validMemberId = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{8,64}$/.test(value);

async function findTeamForMembership(teamId) {
  if (mongoReady) return Sprint.findById(teamId).lean();
  return memorySprints.find((sprint) => sprintId(sprint) === teamId) || null;
}

async function userExists(memberId) {
  if (mongoReady) return Boolean(await User.findById(memberId));
  return [...memoryUsers.values()].some((user) => String(user._id) === String(memberId));
}

app.post('/api/teams/:teamId/members', requireAuth, async (req, res, next) => {
  try {
    const teamId = String(req.params.teamId || '');
    if (!/^[a-zA-Z0-9_-]{8,}$/.test(teamId)) return res.status(400).json({ error: 'Invalid team id.' });
    const memberId = String(req.body?.memberId || '');
    if (!validMemberId(memberId)) return res.status(400).json({ error: 'Invalid member id.' });
    const sprint = await findTeamForMembership(teamId);
    // Teams stay invisible to non-members: unknown and unauthorized share 404.
    if (!sprint) return res.status(404).json({ error: 'Team not found.' });
    const isOwner = String(sprint.ownerId) === userId(req);
    if (!isOwner && req.role !== 'admin') return res.status(404).json({ error: 'Team not found.' });
    if (String(sprint.ownerId) === memberId) return res.status(409).json({ error: 'The team owner is already part of the team.' });
    if (!await userExists(memberId)) return res.status(404).json({ error: 'Member not found.' });
    const { created, membership } = await addTeamMember({ teamId, memberId, actorId: userId(req) });
    // Adding an existing member is a no-op (no duplicate join event).
    if (!created) return res.status(409).json({ error: 'Member is already part of this team.' });
    res.status(201).json({ teamId: String(membership.teamId), memberId: String(membership.memberId), joinedAt: membership.joinedAt });
  } catch (error) { next(error); }
});

app.delete('/api/teams/:teamId/members/:memberId', requireAuth, async (req, res, next) => {
  try {
    const teamId = String(req.params.teamId || '');
    if (!/^[a-zA-Z0-9_-]{8,}$/.test(teamId)) return res.status(400).json({ error: 'Invalid team id.' });
    const memberId = String(req.params.memberId || '');
    if (!validMemberId(memberId)) return res.status(400).json({ error: 'Invalid member id.' });
    const sprint = await findTeamForMembership(teamId);
    if (!sprint) return res.status(404).json({ error: 'Team not found.' });
    // Members may always leave; removing anyone else needs owner or admin.
    const isSelf = memberId === userId(req);
    const isOwner = String(sprint.ownerId) === userId(req);
    if (!isSelf && !isOwner && req.role !== 'admin') return res.status(404).json({ error: 'Team not found.' });
    const { removed } = await removeTeamMember({ teamId, memberId, actorId: userId(req) });
    // Removing a membership that does not exist is a no-op (no false leave event).
    if (!removed) return res.status(404).json({ error: 'Membership not found.' });
    res.json({ ok: true });
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
    if (!canAccess(prerequisite, req)) return res.status(403).json({ error: 'You do not have access to the dependency task.' });
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

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: 'Attachment is invalid or too large.' });
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
export { app, connectMongo, memoryTasks, memoryHistory, sessions, store };
const serverStarted = connectMongo().then(() => app.listen(port, () => console.log(`LeadAI API listening on http://localhost:${port}`)));
export { serverStarted };
