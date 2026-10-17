import mongoose from 'mongoose';

export const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/;

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, trim: true, lowercase: true },
  passwordHash: { type: String, required: true, select: false },
  name: { type: String, trim: true, default: '', maxlength: 80 },
  // Optional public handle. Sparse + unique so accounts without one never collide.
  username: { type: String, trim: true, lowercase: true, unique: true, sparse: true, minlength: 3, maxlength: 30, match: USERNAME_PATTERN },
  bio: { type: String, default: '', maxlength: 300 },
  location: { type: String, default: '', maxlength: 80 },
  website: { type: String, default: '', maxlength: 200 },
  // Small inline image (data URL, <= 80 KB decoded). Avoids a public upload directory
  // and keeps avatars in the shared database instead of one developer's disk.
  avatar: { type: String, default: '', maxlength: 110_000 },
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
