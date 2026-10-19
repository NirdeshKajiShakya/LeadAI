import mongoose from 'mongoose';

const boardSchema = new mongoose.Schema({
  ownerId: { type: String, required: true, index: true },
  memberIds: { type: [String], default: [] },
  name: { type: String, required: true, trim: true, maxlength: 120 },
  createdAt: { type: Date, default: Date.now }
}, { timestamps: true });

export const Board = mongoose.model('Board', boardSchema);
