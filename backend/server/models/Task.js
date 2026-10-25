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

const checklistItemSchema = new mongoose.Schema({
  text: { type: String, required: true, trim: true, maxlength: 240 },
  completed: { type: Boolean, default: false }
}, { _id: true });

const taskSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, index: true },
  ownerId: { type: String, default: null, index: true },
  boardId: { type: String, default: null, index: true },
  title: { type: String, required: true, trim: true, maxlength: 180 },
  description: { type: String, default: '', maxlength: 4000 },
  status: { type: String, enum: ['backlog', 'todo', 'progress', 'review', 'done'], default: 'backlog' },
  priority: { type: String, enum: ['urgent', 'high', 'medium', 'low'], default: 'medium' },
  labels: { type: [String], default: [] },
  assignee: { type: String, default: 'Unassigned', maxlength: 120 },
  assigneeId: { type: String, default: null, index: true },
  // Legacy free-text values ("Unscheduled", "Today", "Oct 18", ...) are
  // converted to a real date by lib/taskMigration.convertDueDate; null means
  // the task is unscheduled.
  dueDate: { type: Date, default: null },
  estimateHours: { type: Number, default: 0, min: 0, max: 1000 },
  aiSuggested: { type: Boolean, default: false },
  sprintId: { type: mongoose.Schema.Types.ObjectId, ref: 'Sprint', default: null },
  // The team this task belongs to. Tasks created outside a team have null.
  teamId: { type: mongoose.Schema.Types.ObjectId, ref: 'Team', default: null, index: true },
  storyPoints: { type: Number, default: 0, min: 0, max: 100 },
  startedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  comments: { type: [commentSchema], default: [] },
  attachments: { type: [attachmentSchema], default: [] },
  dependencies: { type: [dependencySchema], default: [] },
  checklist: { type: [checklistItemSchema], default: [] },
  automationFlags: {
    overdueEscalated: { type: Boolean, default: false },
    overdueNotifiedAt: { type: Date, default: null }
  }
}, { timestamps: true });

// Shared databases serve every developer, so the board and sprint queries must hit indexes.
taskSchema.index({ ownerId: 1, createdAt: 1 });
taskSchema.index({ sprintId: 1 });
taskSchema.index({ status: 1, dueDate: 1 });

export const Task = mongoose.model('Task', taskSchema);
