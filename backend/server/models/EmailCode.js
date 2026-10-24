import mongoose from 'mongoose';

// One-time codes are stored hashed and removed on use. The TTL index is a
// safety net for codes nobody spends (Mongo's TTL monitor runs about once a
// minute), so the collection cannot grow without bound.
const emailCodeSchema = new mongoose.Schema({
  email: { type: String, required: true, lowercase: true, trim: true, index: true },
  purpose: { type: String, enum: ['signup', 'login', 'reset'], required: true },
  challengeId: { type: String, required: true, unique: true },
  codeHash: { type: String, required: true },
  attempts: { type: Number, default: 0 },
  expiresAt: { type: Date, required: true },
  createdAt: { type: Date, default: Date.now }
});

emailCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const EmailCode = mongoose.model('EmailCode', emailCodeSchema);
