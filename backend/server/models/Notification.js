import mongoose from 'mongoose';

const notificationSchema = new mongoose.Schema({
  recipient: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true
  },
  sender: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  message: {
    type: String,
    trim: true,
    maxlength: 2000
  },
  relatedId: {
    type: mongoose.Schema.Types.ObjectId,
    default: null
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  status: {
    type: String,
    enum: ['unread', 'read', 'actioned'],
    default: 'unread',
    index: true
  },
  userId: {
    type: String,
    default: null,
    index: true
  },
  type: {
    type: String,
    required: true,
    enum: [
      'task_assigned',
      'task_status_changed',
      'task_review',
      'sprint_started',
      'board_invite',
      'system',
      'member_joined',
      'member_left',
      'task_due_soon'
    ]
  },
  title: {
    type: String,
    required: true,
    trim: true
  },
  body: {
    type: String,
    required: true,
    trim: true
  },
  link: {
    type: String,
    default: null,
    trim: true
  },
  read: {
    type: Boolean,
    default: false
  },
  readAt: {
    type: Date,
    default: null
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  meta: {
    type: Object,
    default: {}
  }
}, { timestamps: true });

// Compound index for efficient unread queries per user
notificationSchema.index({ userId: 1, read: 1, createdAt: -1 });
notificationSchema.index({ recipient: 1, status: 1, createdAt: -1 });

export const Notification = mongoose.model('Notification', notificationSchema);