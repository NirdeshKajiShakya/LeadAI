import express from 'express';
import mongoose from 'mongoose';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Task } from './models/Task.js';

const app = express();
const port = process.env.PORT || 4000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.json());

const seedTasks = [];
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
  },
  remove: async (key) => {
    if (mongoReady) return Task.findOneAndDelete({ key });
    const task = memoryTasks.find((item) => item.key === key);
    memoryTasks = memoryTasks.filter((item) => item.key !== key);
    return task;
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
app.delete('/api/tasks/:key', async (req, res) => {
  const task = await store.remove(req.params.key);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  res.status(204).end();
});

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../../frontend/dist')));
  app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '../../frontend/dist/index.html')));
}

connectMongo().then(() => app.listen(port, () => console.log(`LeadAI API listening on http://localhost:${port}`)));
