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
  // Sprint planning: null keeps the task in the product backlog.
  sprintId: { type: mongoose.Schema.Types.ObjectId, ref: 'Sprint', default: null },
  storyPoints: { type: Number, default: 0, min: 0 },
  createdAt: { type: Date, default: Date.now }
});

export const Task = mongoose.model('Task', taskSchema);
