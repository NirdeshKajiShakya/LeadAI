import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, trim: true, lowercase: true },
  passwordHash: { type: String, required: true, select: false },
  name: { type: String, trim: true, default: '' },
  role: {
    type: String,
    enum: ['admin', 'member'],
    default: 'member'
  },
  authSessions: [{ type: String }],
  resetToken: { type: String },
  resetTokenExpiresAt: { type: Date }
}, { timestamps: true });

export const User = mongoose.model('User', userSchema);
