import mongoose from 'mongoose';

const commentSchema = new mongoose.Schema({
  body: { type: String, required: true, maxlength: 2000 },
  authorId: { type: String, required: true },
  authorName: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, { _id: true });

const attachmentSchema = new mongoose.Schema({
  storageName: { type: String, required: true },
  originalName: { type: String, required: true, maxlength: 255 },
  size: { type: Number, required: true, max: 10 * 1024 * 1024 },
  mimetype: { type: String, required: true },
  uploadedBy: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
}, { _id: true });

const dependencySchema = new mongoose.Schema({
  fromTask: { type: String, required: true },
  toTask: { type: String, required: true }
}, { _id: true });

const taskSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, index: true },
  ownerId: { type: String, default: null, index: true },
  title: { type: String, required: true, trim: true, maxlength: 180 },
  description: { type: String, default: '', maxlength: 4000 },
  status: { type: String, enum: ['backlog', 'todo', 'progress', 'review', 'done'], default: 'backlog' },
  priority: { type: String, enum: ['urgent', 'high', 'medium', 'low'], default: 'medium' },
  labels: { type: [String], default: [] },
  assignee: { type: String, default: 'Unassigned', maxlength: 120 },
  dueDate: { type: String, default: '', maxlength: 40 },
  aiSuggested: { type: Boolean, default: false },
  comments: { type: [commentSchema], default: [] },
  attachments: { type: [attachmentSchema], default: [] },
  dependencies: { type: [dependencySchema], default: [] }
}, { timestamps: true });

export const Task = mongoose.model('Task', taskSchema);
