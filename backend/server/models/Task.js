import mongoose from 'mongoose';

const taskSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  title: { type: String, required: true },
  description: { type: String, default: '' },
  status: { type: String, enum: ['backlog', 'todo', 'progress', 'review', 'done'], default: 'backlog' },
  priority: { type: String, enum: ['urgent', 'high', 'medium', 'low'], default: 'medium' },
  labels: { type: [String], default: [] },
  assignee: { type: String, default: 'Unassigned' },
  dueDate: { type: String, default: '' },
  aiSuggested: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

export const Task = mongoose.model('Task', taskSchema);
