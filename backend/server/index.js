import express from 'express';
import mongoose from 'mongoose';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Task } from './models/Task.js';

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
let mongoReady = false;

async function connectMongo() {
  if (!process.env.MONGODB_URI) return;
  try {
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 1500 });
    mongoReady = true;
    if (await Task.countDocuments() === 0) await Task.insertMany(seedTasks);
    console.log('MongoDB connected');
  } catch (error) {
      console.warn(`MongoDB unavailable, using in-memory board: ${error.message}`);
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

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../../frontend/dist')));
  app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '../../frontend/dist/index.html')));
}

connectMongo().then(() => app.listen(port, () => console.log(`LeadAI API listening on http://localhost:${port}`)));
