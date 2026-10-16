import mongoose from 'mongoose';
import { SPRINT_DURATION_DAYS, isValidIsoDate } from '../lib/sprintDates.js';

const sprintSchema = new mongoose.Schema({
  ownerId: { type: String, required: true, index: true },
  boardId: { type: String, default: null, index: true },
  name: { type: String, required: true, trim: true },
  goal: { type: String, default: '' },
  // Stored as calendar-day strings so sprint days never shift with the server timezone.
  startDate: { type: String, required: true, validate: isValidIsoDate },
  endDate: { type: String, required: true, validate: isValidIsoDate },
  createdAt: { type: Date, default: Date.now }
});

sprintSchema.virtual('durationDays').get(() => SPRINT_DURATION_DAYS);

export const Sprint = mongoose.model('Sprint', sprintSchema);