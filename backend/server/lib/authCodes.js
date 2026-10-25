import crypto from 'node:crypto';
import { EmailCode } from '../models/EmailCode.js';
import { createAuthError, isDatabaseReady } from '../auth.js';

export const CODE_TTL_MS = 10 * 60 * 1000;
export const RESEND_COOLDOWN_MS = 60 * 1000;
export const MAX_CODE_ATTEMPTS = 5;

export const CODE_PURPOSES = Object.freeze(['signup', 'login', 'reset']);

// In-memory parity with the rest of the app (ALLOW_MEMORY_DB): codes survive
// only for the life of the process, which is enough for a single-node dev server.
const memoryCodes = new Map();

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();
const hashCode = (code) => crypto.createHash('sha256').update(String(code)).digest();
const sameHash = (code, storedHex) => {
  const stored = Buffer.from(String(storedHex || ''), 'hex');
  const actual = hashCode(code);
  return stored.length === actual.length && crypto.timingSafeEqual(stored, actual);
};
const nowMs = (record) => new Date(record.createdAt).getTime();

function sweepMemory(now) {
  for (const [challengeId, record] of memoryCodes) {
    if (nowMs(record) + CODE_TTL_MS * 6 < now) memoryCodes.delete(challengeId);
  }
}

async function latestCode(email, purpose) {
  if (isDatabaseReady()) {
    return EmailCode.findOne({ email, purpose }).sort({ createdAt: -1 }).lean();
  }
  let latest = null;
  for (const record of memoryCodes.values()) {
    if (record.email === email && record.purpose === purpose && (!latest || nowMs(record) > nowMs(latest))) latest = record;
  }
  return latest;
}

// Returns the newest still-valid challenge for an email and purpose, if any.
// Sign-in uses it to reuse a code that was just sent instead of hitting the
// resend cooldown, which would otherwise lock a user out for up to a minute
// right after signing up.
export async function findActiveChallenge({ email, purpose, now = Date.now() }) {
  const record = await latestCode(normalizeEmail(email), purpose);
  if (!record || new Date(record.expiresAt).getTime() <= now) return null;
  // A challenge that has spent its attempts must not be handed back to a
  // sign-in attempt: the user would be stuck until the code expires.
  if (record.attempts >= MAX_CODE_ATTEMPTS) return null;
  return { challengeId: record.challengeId, email: record.email, createdAt: record.createdAt };
}

// Only the newest code for an address and purpose may be valid. This is what
// makes "resend" safe: an older message cannot still be used afterwards.
async function clearCodes(email, purpose) {
  if (isDatabaseReady()) {
    await EmailCode.deleteMany({ email, purpose });
    return;
  }
  for (const [challengeId, record] of memoryCodes) {
    if (record.email === email && record.purpose === purpose) memoryCodes.delete(challengeId);
  }
}

export async function findCodeByChallenge(challengeId) {
  const id = String(challengeId || '').trim();
  if (!id) return null;
  if (isDatabaseReady()) return EmailCode.findOne({ challengeId: id }).lean();
  return memoryCodes.get(id) || null;
}

export async function discardCode(challengeId) {
  const id = String(challengeId || '').trim();
  if (!id) return;
  if (isDatabaseReady()) await EmailCode.deleteOne({ challengeId: id });
  else memoryCodes.delete(id);
}

/**
 * Issues a fresh 6-digit code for an email address.
 *
 * Only one request per address and purpose is allowed per minute; asking
 * again sooner is rejected so the endpoint cannot be used to flood a mailbox.
 */
export async function issueCode({ email, purpose, now = Date.now() }) {
  if (!CODE_PURPOSES.includes(purpose)) throw createAuthError(400, 'Unknown verification purpose.');
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) throw createAuthError(400, 'An email address is required.');

  const previous = await latestCode(normalizedEmail, purpose);
  if (previous) {
    const elapsed = now - nowMs(previous);
    if (elapsed < RESEND_COOLDOWN_MS) {
      const wait = Math.ceil((RESEND_COOLDOWN_MS - elapsed) / 1000);
      throw createAuthError(429, `A code was just sent. Try again in ${wait} second${wait === 1 ? '' : 's'}.`);
    }
  }

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  // Previous codes are removed before the new one is stored, so a resend
  // cannot leave two working codes in the same inbox.
  await clearCodes(normalizedEmail, purpose);
  const record = {
    challengeId: crypto.randomUUID(),
    email: normalizedEmail,
    purpose,
    codeHash: hashCode(code).toString('hex'),
    attempts: 0,
    createdAt: new Date(now),
    expiresAt: new Date(now + CODE_TTL_MS)
  };

  if (isDatabaseReady()) {
    await EmailCode.create(record);
  } else {
    sweepMemory(now);
    memoryCodes.set(record.challengeId, record);
  }
  return { challengeId: record.challengeId, code, expiresAt: record.expiresAt };
}

/**
 * Checks a code and consumes it on success. Wrong guesses are counted; a code
 * is destroyed after MAX_CODE_ATTEMPTS failures or once it expires.
 */
export async function verifyCode({ challengeId, code, purposes, now = Date.now() }) {
  if (!/^\d{6}$/.test(String(code || '').trim())) {
    throw createAuthError(400, 'Enter the 6-digit code from the email.');
  }
  const record = await findCodeByChallenge(challengeId);
  if (!record) throw createAuthError(400, 'This code is invalid or has expired. Request a new one.');
  // Checked before the code is consumed so a code cannot be burned on the
  // wrong form (sign-in code pasted into the reset form, or vice versa).
  if (purposes && !purposes.includes(record.purpose)) {
    throw createAuthError(400, `That code is for a different step. Request a new ${record.purpose === 'reset' ? 'reset' : 'sign-in'} code.`);
  }

  if (new Date(record.expiresAt).getTime() <= now) {
    await discardCode(record.challengeId);
    throw createAuthError(400, 'This code has expired. Request a new one.');
  }
  if (record.attempts >= MAX_CODE_ATTEMPTS) {
    throw createAuthError(429, 'Too many incorrect attempts. Request a new code.');
  }

  if (!sameHash(String(code).trim(), record.codeHash)) {
    const attempts = record.attempts + 1;
    if (isDatabaseReady()) await EmailCode.updateOne({ challengeId: record.challengeId }, { $set: { attempts } });
    else memoryCodes.set(record.challengeId, { ...record, attempts });
    const left = MAX_CODE_ATTEMPTS - attempts;
    if (left <= 0) {
      // Keep the exhausted record so "resend" can still find this signup and
      // issue a replacement. It can never verify, and the TTL removes it.
      throw createAuthError(429, 'Too many incorrect attempts. Request a new code.');
    }
    throw createAuthError(400, `That code is not correct. ${left} attempt${left === 1 ? '' : 's'} left.`);
  }

  await discardCode(record.challengeId);
  return { email: record.email, purpose: record.purpose };
}
