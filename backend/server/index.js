import express from 'express';
import mongoose from 'mongoose';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Task } from './models/Task.js';
import { Sprint } from './models/Sprint.js';
import { endDateForStart, summarizeTasks, computeSprintDay, validateSprintRange, todayIsoDate } from './lib/sprintDates.js';

const app = express();
const port = process.env.PORT || 4000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.json());

const seedTasks = [
  { key: 'KAN-101', title: 'API rate-limiting middleware', description: 'Token bucket enforcement in the Go router layer to isolate external LLM request spikes.', status: 'backlog', priority: 'low', labels: ['Backend', 'Security'], assignee: 'Sarah Chen', dueDate: 'Sep 28' },
  { key: 'KAN-102', title: 'Multi-tenant database shard migration', description: 'Isolate read replicas across US-East regions for tier-1 tenant isolation.', status: 'backlog', priority: 'high', labels: ['Database'], assignee: 'Sarah Chen', dueDate: 'Oct 04', aiSuggested: true },
  { key: 'KAN-103', title: 'OAuth2 token refresh caching', description: 'Mitigate duplicate identity verification roundtrips via a low-latency Redis ring.', status: 'backlog', priority: 'medium', labels: ['Auth'], assignee: 'Unassigned', dueDate: 'Unscheduled' },
  { key: 'KAN-104', title: 'Design vector search indexing pipeline', description: 'Qdrant cluster sync with Postgres embeddings generated via batch pipeline.', status: 'todo', priority: 'urgent', labels: ['AI Agent', 'Architecture'], assignee: 'Devin Vance', aiSuggested: true },
  { key: 'KAN-105', title: 'Refactor WebSocket event listeners', description: 'Prevent zombie subscriptions during unmounting of real-time card lanes.', status: 'todo', priority: 'high', labels: ['Frontend'], assignee: 'Sarah Chen', aiSuggested: true },
  { key: 'KAN-108', title: 'Implement LLM tool-calling fallback', description: 'Graceful multi-provider cascade across OpenAI, Anthropic, and self-hosted Llama3.', status: 'progress', priority: 'urgent', labels: ['AI Agent', 'Core'], assignee: 'Alex Rivera', aiSuggested: true },
  { key: 'KAN-109', title: 'Dark mode high-contrast audit', description: 'WCAG 2.1 AAA luminance check across status badges and interactive cards.', status: 'progress', priority: 'medium', labels: ['Frontend', 'A11y'], assignee: 'Sarah Chen' },
  { key: 'KAN-110', title: 'Payment webhook reconciliation suite', description: 'Idempotent retry scheduler for Stripe checkout completion events with DLQ.', status: 'review', priority: 'high', labels: ['Backend', 'CI Passed'], assignee: 'Elena Rostova' },
  { key: 'KAN-112', title: 'Telemetry span enrichment for gRPC', description: 'Inject tenant and trace context into distributed OpenTelemetry tracers.', status: 'review', priority: 'low', labels: ['DevOps'], assignee: 'Elena Rostova' },
  { key: 'KAN-089', title: 'Kubernetes cluster autoscaler fine-tuning', description: 'Tune scale-up windows for predictable deployment capacity.', status: 'done', priority: 'low', labels: ['DevOps'], assignee: 'Marcus Brody' },
  { key: 'KAN-092', title: 'Fix memory leak in SSE stream buffer', description: 'Release detached stream buffers after client disconnects.', status: 'done', priority: 'medium', labels: ['Bugfix'], assignee: 'Alex Rivera' }
];
let memoryTasks = seedTasks;
let memorySprints = [];
let mongoReady = false;

// Sprints start on today's day 4 so the demo board shows a mid-sprint "Day 4 of 14".
function seedSprint() {
  const startDate = todayIsoDate();
  const start = new Date(`${startDate}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 3);
  const seededStart = start.toISOString().slice(0, 10);
  return {
    name: 'Q3 Product Engineering Sprint 14',
    goal: 'Ship the core orchestration engine v2.4 with a working LLM fallback matrix.',
    startDate: seededStart,
    endDate: endDateForStart(seededStart),
    createdAt: new Date()
  };
}

async function connectMongo() {
  if (!process.env.MONGODB_URI) {
    memorySprints = [withId(seedSprint())];
    return;
  }
  try {
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 1500 });
    mongoReady = true;
    if (await Task.countDocuments() === 0) await Task.insertMany(seedTasks);
    if (await Sprint.countDocuments() === 0) await Sprint.create(seedSprint());
    console.log('MongoDB connected');
  } catch (error) {
      console.warn(`MongoDB unavailable, using in-memory board: ${error.message}`);
      memorySprints = [withId(seedSprint())];
  }
}

const store = {
  list: () => mongoReady ? Task.find().sort({ createdAt: 1 }) : Promise.resolve(memoryTasks),
  create: async (data) => {
    if (mongoReady) return Task.create(data);
    const task = { ...data, key: data.key || `KAN-${Math.floor(200 + Math.random() * 700)}`, createdAt: new Date() };
    memoryTasks = [...memoryTasks, task];
    return task;
  },
  update: async (key, data) => {
    if (mongoReady) return Task.findOneAndUpdate({ key }, data, { new: true });
    memoryTasks = memoryTasks.map((task) => task.key === key ? { ...task, ...data } : task);
    return memoryTasks.find((task) => task.key === key);
  }
};

const idOf = (sprint) => String(sprint._id ?? sprint.id ?? sprint);

// Memory sprints need an identifier up front; Mongo assigns one on save.
let memoryIdCounter = 0;
const withId = (sprint) => (sprint._id ? sprint : { ...sprint, _id: `mem-${Date.now()}-${memoryIdCounter += 1}` });

const sprintStore = {
  list: () => (mongoReady ? Sprint.find().sort({ startDate: -1 }) : Promise.resolve(memorySprints)),
  // findById throws a CastError for non-ObjectId strings, which is just a miss here.
  get: async (id) => {
    if (mongoReady) {
      try { return await Sprint.findById(id); } catch { return null; }
    }
    return memorySprints.find((sprint) => idOf(sprint) === String(id)) ?? null;
  },
  create: async (data) => {
    if (mongoReady) return Sprint.create(data);
    const sprint = withId({ ...data, createdAt: new Date() });
    memorySprints = [...memorySprints, sprint];
    return sprint;
  },
  update: async (id, data) => {
    if (mongoReady) return Sprint.findByIdAndUpdate(id, data, { new: true });
    memorySprints = memorySprints.map((sprint) => idOf(sprint) === String(id) ? { ...sprint, ...data } : sprint);
    return memorySprints.find((sprint) => idOf(sprint) === String(id)) ?? null;
  }
};

const taskStore = {
  list: () => (mongoReady ? Task.find().sort({ createdAt: 1 }) : Promise.resolve(memoryTasks)),
  listBySprint: (id) => (mongoReady ? Task.find({ sprintId: id }) : Promise.resolve(memoryTasks.filter((task) => String(task.sprintId) === String(id)))),
  listWithoutSprint: () => (mongoReady ? Task.find({ sprintId: null }) : Promise.resolve(memoryTasks.filter((task) => !task.sprintId)))
};

// Decorates a sprint with computed day/state and progress so the client never recalculates them.
async function decorateSprint(sprint) {
  if (!sprint) return null;
  // Spreading a Mongoose document skips schema fields, so normalise first.
  const plain = typeof sprint.toObject === 'function' ? sprint.toObject() : { ...sprint };
  const tasks = await taskStore.listBySprint(idOf(plain));
  return {
    ...plain,
    id: String(idOf(plain)),
    durationDays: validateSprintRange(plain.startDate, plain.endDate).durationDays ?? null,
    progress: summarizeTasks(tasks),
    current: computeSprintDay(plain.startDate, plain.endDate)
  };
}

app.get('/api/health', (_req, res) => res.json({ ok: true, database: mongoReady ? 'mongodb' : 'memory' }));
app.get('/api/tasks', async (_req, res) => res.json(await store.list()));
app.post('/api/tasks', async (req, res) => {
  if (!req.body.title?.trim()) return res.status(400).json({ error: 'A task title is required.' });
  res.status(201).json(await store.create({ ...req.body, title: req.body.title.trim() }));
});
app.patch('/api/tasks/:key', async (req, res) => {
  const task = await store.update(req.params.key, req.body);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  res.json(task);
});

app.get('/api/sprints', async (_req, res) => {
  const sprints = await sprintStore.list();
  res.json(await Promise.all(sprints.map(decorateSprint)));
});

app.post('/api/sprints', async (req, res) => {
  const name = req.body.name?.trim();
  if (!name) return res.status(400).json({ error: 'A sprint name is required.' });
  const startDate = req.body.startDate;
  const range = validateSprintRange(startDate, req.body.endDate || undefined);
  if (!range.ok) return res.status(400).json({ error: range.error });
  const sprint = await sprintStore.create({ name, goal: req.body.goal?.trim() || '', startDate, endDate: req.body.endDate || endDateForStart(startDate) });
  res.status(201).json(await decorateSprint(sprint));
});

app.get('/api/sprints/:id', async (req, res) => {
  const sprint = await sprintStore.get(req.params.id);
  if (!sprint) return res.status(404).json({ error: 'Sprint not found.' });
  res.json(await decorateSprint(sprint));
});

app.patch('/api/sprints/:id', async (req, res) => {
  const existing = await sprintStore.get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Sprint not found.' });
  const startDate = req.body.startDate ?? existing.startDate;
  const range = validateSprintRange(startDate, req.body.endDate ?? existing.endDate);
  if (!range.ok) return res.status(400).json({ error: range.error });
  const data = {};
  if (req.body.name !== undefined) {
    if (!req.body.name?.trim()) return res.status(400).json({ error: 'A sprint name is required.' });
    data.name = req.body.name.trim();
  }
  if (req.body.goal !== undefined) data.goal = req.body.goal.trim();
  if (req.body.startDate !== undefined) data.startDate = req.body.startDate;
  if (req.body.endDate !== undefined) data.endDate = req.body.endDate;
  res.json(await decorateSprint(await sprintStore.update(req.params.id, data)));
});

app.get('/api/sprints/:id/tasks', async (req, res) => {
  const sprint = await sprintStore.get(req.params.id);
  if (!sprint) return res.status(404).json({ error: 'Sprint not found.' });
  res.json(await taskStore.listBySprint(req.params.id));
});

// Product backlog: every task that is not committed to a sprint.
app.get('/api/backlog', async (_req, res) => res.json(await taskStore.listWithoutSprint()));

app.post('/api/sprints/:id/tasks', async (req, res) => {
  const sprint = await sprintStore.get(req.params.id);
  if (!sprint) return res.status(404).json({ error: 'Sprint not found.' });
  const task = await store.update(req.body.key, { sprintId: sprint._id });
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  res.status(201).json(task);
});

// Removing a task returns it to the product backlog by clearing its sprint reference.
app.delete('/api/sprints/:id/tasks/:key', async (req, res) => {
  const task = await store.update(req.params.key, { sprintId: null });
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  res.json(task);
});

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../../frontend/dist')));
  app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '../../frontend/dist/index.html')));
}

connectMongo().then(() => app.listen(port, () => console.log(`LeadAI API listening on http://localhost:${port}`)));