import mongoose from 'mongoose';

const taskHistorySchema = new mongoose.Schema(
  {
    taskId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Task',
      required: true,
      index: true
    },
    teamId: {
      // Team == sprint in this codebase; tasks outside a sprint have none.
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Sprint',
      default: null,
      index: true
    },
    from: {
      type: String,
      enum: ['backlog', 'todo', 'progress', 'review', 'done'],
      index: true
    },
    to: {
      type: String,
      enum: ['backlog', 'todo', 'progress', 'review', 'done'],
      required: true,
      index: true
    },
    actorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    at: {
      type: Date,
      required: true,
      default: Date.now
    }
  },
  { timestamps: true }
);

// Chronological history per task.
taskHistorySchema.index({ taskId: 1, at: 1 });
// Team filter + chronological trim window.
taskHistorySchema.index({ teamId: 1, at: -1 });

export const TaskHistory = mongoose.model('TaskHistory', taskHistorySchema);
