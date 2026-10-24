import crypto from 'node:crypto';
import { EmailVerificationToken } from '../models/EmailVerificationToken.js';
import { createAuthError, isDatabaseReady } from '../auth.js';

export const VERIFICATION_TTL_MS = 30 * 60 * 1000;
export const RESEND_COOLDOWN_MS = 60 * 1000;

// In-memory parity with the rest of the app (ALLOW_MEMORY_DB). Tokens live for
// the process only, which is enough for a single-node development server.
const memoryTokens = new Map();

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();
const createdAtMs = (record) => new Date(record.createdAt).getTime();
export const hashVerificationToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

function sweepMemory(now) {
  for (const [tokenHash, record] of memoryTokens) {
    if (new Date(record.expiresAt).getTime() + VERIFICATION_TTL_MS < now) memoryTokens.delete(tokenHash);
  }
}

async function latestToken(email) {
  if (isDatabaseReady()) {
    return EmailVerificationToken.findOne({ email }).sort({ createdAt: -1 }).lean();
  }
  let latest = null;
  for (const record of memoryTokens.values()) {
    if (record.email === email && (!latest || createdAtMs(record) > createdAtMs(latest))) latest = record;
  }
  return latest;
}

// Invalidating older tokens keeps only the newest link usable, so a resend
// cannot leave several working links in a mailbox.
export async function clearVerificationTokens(email) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return;
  if (isDatabaseReady()) {
    await EmailVerificationToken.deleteMany({ email: normalizedEmail });
    return;
  }
  for (const [tokenHash, record] of memoryTokens) {
    if (record.email === normalizedEmail) memoryTokens.delete(tokenHash);
  }
}

/**
 * Issues a single-use verification token for an email address.
 *
 * The raw token is returned once so it can be placed in the link; only its
 * hash is stored. Asking again within the cooldown is either rejected (signup)
 * or reported as throttled (resend, which must not reveal account existence).
 */
export async function issueVerificationToken({ email, userId, now = Date.now(), enforceCooldown = true }) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) throw createAuthError(400, 'An email address is required.');
  if (!userId) throw createAuthError(400, 'A user is required.');

  const previous = await latestToken(normalizedEmail);
  if (previous) {
    const elapsed = now - createdAtMs(previous);
    if (elapsed < RESEND_COOLDOWN_MS) {
      const retryAfter = Math.ceil((RESEND_COOLDOWN_MS - elapsed) / 1000);
      if (enforceCooldown) {
        throw createAuthError(429, `A verification email was just sent. Try again in ${retryAfter} second${retryAfter === 1 ? '' : 's'}.`);
      }
      return { throttled: true, retryAfter };
    }
  }

  await clearVerificationTokens(normalizedEmail);

  const token = crypto.randomBytes(32).toString('hex');
  const record = {
    email: normalizedEmail,
    userId: String(userId),
    tokenHash: hashVerificationToken(token),
    createdAt: new Date(now),
    expiresAt: new Date(now + VERIFICATION_TTL_MS)
  };

  if (isDatabaseReady()) {
    await EmailVerificationToken.create(record);
  } else {
    sweepMemory(now);
    memoryTokens.set(record.tokenHash, record);
  }

  return {
    token,
    expiresAt: record.expiresAt,
    throttled: false,
    retryAfter: Math.ceil(RESEND_COOLDOWN_MS / 1000)
  };
}

/**
 * Consumes a verification token. The token is deleted atomically before the
 * expiry check, so a replay or two concurrent requests can never both succeed.
 */
export async function consumeVerificationToken({ token, now = Date.now() }) {
  const raw = String(token || '').trim();
  if (!/^[a-f0-9]{64}$/i.test(raw)) {
    throw createAuthError(400, 'This verification link is invalid or has expired. Request a new one.');
  }
  const tokenHash = hashVerificationToken(raw);

  let record;
  if (isDatabaseReady()) {
    record = await EmailVerificationToken.findOneAndDelete({ tokenHash }).lean();
  } else {
    record = memoryTokens.get(tokenHash) || null;
    if (record) memoryTokens.delete(tokenHash);
  }

  if (!record) {
    throw createAuthError(400, 'This verification link is invalid or has expired. Request a new one.');
  }
  if (new Date(record.expiresAt).getTime() <= now) {
    throw createAuthError(400, 'This verification link has expired. Request a new one.');
  }

  // Any other outstanding link for this address is no longer useful. Cleanup
  // is best-effort: the token was already consumed, so a transient database
  // error here must not turn a successful verification into a failure.
  await clearVerificationTokens(record.email).catch(() => {});
  return { email: record.email, userId: record.userId };
}
