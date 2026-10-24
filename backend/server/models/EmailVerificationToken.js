import mongoose from 'mongoose';

// Signup verification links are stored as a SHA-256 hash, never as the raw
// token. A token is deleted as soon as it is used, and the TTL index removes
// unused tokens after they expire.
const emailVerificationTokenSchema = new mongoose.Schema({
  email: { type: String, required: true, lowercase: true, trim: true, index: true },
  userId: { type: String, required: true, index: true },
  tokenHash: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true },
  createdAt: { type: Date, default: Date.now }
});

emailVerificationTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const EmailVerificationToken = mongoose.model('EmailVerificationToken', emailVerificationTokenSchema);
