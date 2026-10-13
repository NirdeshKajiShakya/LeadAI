import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import mongoose from 'mongoose';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { Task } from './models/Task.js';
import { User } from './models/User.js';
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

fs.mkdirSync(uploadsDir, { recursive: true });
app.use(express.json({ limit: '150kb' }));
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

const seedTasks = [
  ['KAN-101', 'API rate-limiting middleware', 'backlog', 'low', ['Backend', 'Security'], 'Sarah Chen'],
  ['KAN-102', 'Multi-tenant database shard migration', 'backlog', 'high', ['Database'], 'Sarah Chen'],
  ['KAN-103', 'OAuth2 token refresh caching', 'backlog', 'medium', ['Auth'], 'Unassigned'],
  ['KAN-104', 'Design vector search indexing pipeline', 'todo', 'urgent', ['AI Agent', 'Architecture'], 'Devin Vance'],
  ['KAN-105', 'Refactor WebSocket event listeners', 'todo', 'high', ['Frontend'], 'Sarah Chen'],
  ['KAN-108', 'Implement LLM tool-calling fallback', 'progress', 'urgent', ['AI Agent', 'Core'], 'Alex Rivera'],
  ['KAN-109', 'Dark mode high-contrast audit', 'progress', 'medium', ['Frontend', 'A11y'], 'Sarah Chen'],
  ['KAN-110', 'Payment webhook reconciliation suite', 'review', 'high', ['Backend', 'CI Passed'], 'Elena Rostova'],
  ['KAN-112', 'Telemetry span enrichment for gRPC', 'review', 'low', ['DevOps'], 'Elena Rostova'],
  ['KAN-089', 'Kubernetes cluster autoscaler fine-tuning', 'done', 'low', ['DevOps'], 'Marcus Brody'],
  ['KAN-092', 'Fix memory leak in SSE stream buffer', 'done', 'medium', ['Bugfix'], 'Alex Rivera']
].map(([key, title, status, priority, labels, assignee]) => ({
  key, title, description: '', status, priority, labels, assignee, dueDate: 'Unscheduled',
  ownerId: null, comments: [], attachments: [], dependencies: []
}));
let memoryTasks = seedTasks;

async function connectMongo() {
  if (!process.env.MONGODB_URI) return;
  try {
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 1500 });
    mongoReady = true;
    setDatabaseReady(true);
    if (await Task.countDocuments() === 0) await Task.insertMany(seedTasks);
    console.log('MongoDB connected');
  } catch (error) {
    console.warn(`MongoDB unavailable, using in-memory storage: ${error.message}`);
  }
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
  }
};

function userId(req) { return String(req.user._id); }
function canAccess(task, req) { return !task.ownerId || String(task.ownerId) === userId(req) || req.role === 'admin'; }
async function authorizedTask(req, res) {
  const task = await store.find(req.params.key);
  if (!task) { res.status(404).json({ error: 'Task not found.' }); return null; }
  if (!canAccess(task, req)) { res.status(403).json({ error: 'You do not have access to this task.' }); return null; }
  return task;
}
function validateTaskInput(body, partial = false) {
  if (!partial && (!body.title || typeof body.title !== 'string' || !body.title.trim())) throw createAuthError(400, 'A task title is required.');
  if (body.title !== undefined && (typeof body.title !== 'string' || body.title.trim().length > 180)) throw createAuthError(400, 'Task title must be 1-180 characters.');
  if (body.description !== undefined && typeof body.description !== 'string') throw createAuthError(400, 'Description must be text.');
  if (body.status !== undefined && !allowedStatuses.includes(body.status)) throw createAuthError(400, 'Invalid status.');
  if (body.priority !== undefined && !allowedPriorities.includes(body.priority)) throw createAuthError(400, 'Invalid priority.');
  if (body.labels !== undefined && (!Array.isArray(body.labels) || body.labels.some((label) => typeof label !== 'string' || !label.trim() || label.length > 40))) throw createAuthError(400, 'Labels must be non-empty text values.');
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
  try { res.status(201).json(await createUser(req.body || {})); } catch (error) { next(error); }
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

app.get('/api/tasks', requireAuth, async (_req, res, next) => {
  try { res.json(await store.list()); } catch (error) { next(error); }
});
app.post('/api/tasks', requireAuth, async (req, res, next) => {
  try {
    validateTaskInput(req.body || {});
    let key;
    do { key = `KAN-${crypto.randomInt(100, 1000)}`; } while (await store.find(key));
    const task = await store.create({
      key, ownerId: userId(req), title: req.body.title.trim(), description: (req.body.description || '').slice(0, 4000),
      status: req.body.status || 'backlog', priority: req.body.priority || 'medium',
      labels: [...new Set(req.body.labels || [])], assignee: String(req.body.assignee || 'Unassigned').slice(0, 120),
      dueDate: String(req.body.dueDate || '').slice(0, 40), comments: [], attachments: [], dependencies: []
    });
    res.status(201).json(task);
  } catch (error) { next(error); }
});
app.patch('/api/tasks/:key', requireAuth, async (req, res, next) => {
  try {
    const task = await authorizedTask(req, res);
    if (!task) return;
    validateTaskInput(req.body || {}, true);
    const updates = { ...req.body };
    delete updates.key; delete updates.ownerId; delete updates.comments; delete updates.attachments; delete updates.dependencies;
    if (updates.labels) updates.labels = [...new Set(updates.labels)];
    res.json(await store.update(task.key, updates));
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

export { app, connectMongo, memoryTasks, sessions };
connectMongo().then(() => app.listen(port, () => console.log(`LeadAI API listening on http://localhost:${port}`)));
