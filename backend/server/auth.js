import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { User, USERNAME_PATTERN, USERNAME_MIN_LENGTH, USERNAME_MAX_LENGTH, normalizeUsername } from './models/User.js';

export const BCRYPT_ROUNDS = 12;
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const MAX_TRUSTED_DEVICES = 10;
export const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{16,80}$/;

export const sessions = new Map();
export const memoryUsers = new Map();
let databaseReady = false;

export function setDatabaseReady(value) {
  databaseReady = value;
}

export function isDatabaseReady() {
  return databaseReady;
}

export function createAuthError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function isAuthError(error) {
  return Number.isInteger(error?.status);
}

function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

export async function hashPassword(password) {
  return typeof password === 'string' && password ? bcrypt.hash(password, BCRYPT_ROUNDS) : null;
}

export async function verifyPassword(password, hash) {
  return Boolean(password && hash && await bcrypt.compare(password, hash));
}

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;
export const PASSWORD_RULES = Object.freeze([
  { id: 'length', label: `At least ${PASSWORD_MIN_LENGTH} characters` },
  { id: 'lowercase', label: 'One lowercase letter' },
  { id: 'uppercase', label: 'One uppercase letter' },
  { id: 'number', label: 'One number' },
  { id: 'special', label: 'One special character' }
]);

export const PASSWORD_CHECKS = Object.freeze({
  length: (value) => value.length >= PASSWORD_MIN_LENGTH && value.length <= PASSWORD_MAX_LENGTH,
  lowercase: (value) => /[a-z]/.test(value),
  uppercase: (value) => /[A-Z]/.test(value),
  number: (value) => /[0-9]/.test(value),
  special: (value) => /[^A-Za-z0-9]/.test(value)
});

// The same five checks run in the browser for the live checklist. This function
// stays authoritative: a request that bypasses the UI still fails here.
export function passwordViolations(password) {
  const value = typeof password === 'string' ? password : '';
  return PASSWORD_RULES
    .filter((rule) => !PASSWORD_CHECKS[rule.id](value))
    .map((rule) => rule.label);
}

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    throw createAuthError(400, `Password must be between ${PASSWORD_MIN_LENGTH} and ${PASSWORD_MAX_LENGTH} characters.`);
  }
  const violations = passwordViolations(password);
  if (violations.length) {
    throw createAuthError(400, `Password must include ${violations.join(', ').replace(/, ([^,]*)$/, ' and $1')}.`);
  }
}

export function normalizeAndValidateUsername(value) {
  const username = normalizeUsername(value);
  if (!username) throw createAuthError(400, 'A username is required.');
  if (username.length < USERNAME_MIN_LENGTH || username.length > USERNAME_MAX_LENGTH) {
    throw createAuthError(400, `Username must be between ${USERNAME_MIN_LENGTH} and ${USERNAME_MAX_LENGTH} characters.`);
  }
  if (!USERNAME_PATTERN.test(username)) {
    throw createAuthError(400, 'Username may use lowercase letters, numbers, and hyphens, and must start and end with a letter or number.');
  }
  return username;
}

export async function isUsernameTaken(username, excludeUserId = null) {
  const normalized = normalizeUsername(username);
  if (!normalized) return false;
  if (!databaseReady) {
    return [...memoryUsers.values()].some((user) => (
      user.username === normalized && String(user._id) !== String(excludeUserId)
    ));
  }
  const query = { username: normalized };
  if (excludeUserId) query._id = { $ne: excludeUserId };
  return Boolean(await User.exists(query));
}

export function serializeUser(user) {
  const value = user?.toObject ? user.toObject() : { ...user };
  delete value.passwordHash;
  delete value.authSessions;
  // Device hashes are as sensitive as a session token: a leaked one would let
  // someone skip the emailed sign-in code.
  delete value.trustedDevices;
  // Personal AI keys never leave the server, in any shape.
  delete value.openrouterApiKey;
  return value;
}

export function userId(req) {
  return req.user ? String(req.user._id) : null;
}

export async function findUserByEmail(email) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) return null;
  if (!databaseReady) {
    return memoryUsers.get(normalizedEmail) || null;
  }
  return User.findOne({ email: normalizedEmail }).select('+passwordHash');
}

export async function findUserById(id) {
  if (!id) return null;
  if (!databaseReady) return [...memoryUsers.values()].find((user) => String(user._id) === String(id)) || null;
  return User.findById(id);
}

export async function createUser({ email, password, name, username, role = 'member', emailVerified = true }) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    throw createAuthError(400, 'A valid email address is required.');
  }
  validatePassword(password);
  const normalizedUsername = normalizeAndValidateUsername(username);
  if (await isUsernameTaken(normalizedUsername)) {
    throw createAuthError(409, 'That username is already taken.');
  }
  const passwordHash = await hashPassword(password);
  if (!passwordHash) throw createAuthError(500, 'Could not create account.');
  const data = {
    email: normalizedEmail,
    passwordHash,
    name: String(name || '').trim().slice(0, 80) || normalizedEmail,
    username: normalizedUsername,
    role: role === 'admin' ? 'member' : role,
    emailVerified: emailVerified !== false,
    skills: []
  };
  if (!databaseReady) {
    if (memoryUsers.has(normalizedEmail)) throw createAuthError(409, 'An account with this email already exists.');
    // Synchronous re-check at the last possible moment: in-memory mode has no
    // unique index to arbitrate two signups that raced through the first check.
    if ([...memoryUsers.values()].some((user) => user.username === normalizedUsername)) {
      throw createAuthError(409, 'That username is already taken.');
    }
    const user = { ...data, _id: crypto.randomUUID() };
    memoryUsers.set(normalizedEmail, user);
    return serializeUser(user);
  }
  const user = new User(data);
  try {
    await user.save();
  } catch (error) {
    if (error.code === 11000) {
      // The unique indexes are the final authority when two requests race.
      if (error.keyPattern?.username || error.keyValue?.username) {
        throw createAuthError(409, 'That username is already taken.');
      }
      throw createAuthError(409, 'An account with this email already exists.');
    }
    throw error;
  }
  return serializeUser(user);
}

export async function authenticateUser({ email, password }) {
  const user = await findUserByEmail(email);
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    throw createAuthError(401, 'Invalid credentials.');
  }
  return user;
}

// Accounts created before email verification existed have no `emailVerified`
// field; Mongoose applies the schema default (true) when hydrating them, so
// only an explicit false means "not verified yet".
export function isEmailVerified(user) {
  return user?.emailVerified !== false;
}

export async function markEmailVerified(user) {
  user.emailVerified = true;
  if (databaseReady) {
    await User.updateOne({ _id: user._id }, { $set: { emailVerified: true } });
  } else if (memoryUsers.has(user.email)) {
    memoryUsers.set(user.email, { ...memoryUsers.get(user.email), emailVerified: true });
  }
}

export function normalizeDeviceId(value) {
  const id = String(value || '').trim();
  return DEVICE_ID_PATTERN.test(id) ? id : null;
}

function hashDeviceId(deviceId) {
  return crypto.createHash('sha256').update(String(deviceId)).digest('hex');
}

// Only a hash is stored, so reading the database does not hand out a way past
// the new-device check.
export function isTrustedDevice(user, deviceId) {
  const hash = hashDeviceId(deviceId);
  return (user?.trustedDevices || []).some((device) => device.deviceHash === hash);
}

export async function trustDevice(user, deviceId, label = '') {
  const now = new Date();
  const hash = hashDeviceId(deviceId);
  const devices = (user.trustedDevices || []).filter((device) => device.deviceHash !== hash);
  devices.push({
    deviceHash: hash,
    label: String(label || '').slice(0, 120),
    trustedAt: now,
    lastSeenAt: now
  });
  // Keep the most recent devices only; the oldest trust entries are dropped.
  const trimmed = devices.slice(-MAX_TRUSTED_DEVICES);
  user.trustedDevices = trimmed;
  if (databaseReady) {
    await User.updateOne({ _id: user._id }, { $set: { trustedDevices: trimmed } });
  } else if (memoryUsers.has(user.email)) {
    memoryUsers.set(user.email, { ...memoryUsers.get(user.email), trustedDevices: trimmed });
  }
}

// Profile edits must show up in the current tab (and any other signed-in tab) without a re-login.
export function refreshSessionUser(user) {
  const serialized = serializeUser(user);
  for (const session of sessions.values()) {
    if (String(session.user._id) === String(serialized._id)) session.user = serialized;
  }
}

export function createAuthSession(user) {
  const token = randomToken();
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const serialized = serializeUser(user);
  sessions.set(token, { user: serialized, expiresAt });
  return { token, user: serialized, expiresAt };
}

export function getBearerToken(req) {
  const authorization = req.get('authorization') || '';
  return authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : null;
}

export async function resolveSession(token) {
  const cachedSession = sessions.get(token);
  if (cachedSession) {
    if (cachedSession.expiresAt <= Date.now()) {
      sessions.delete(token);
      return null;
    }
    return cachedSession;
  }
  if (!databaseReady) return null;
  const user = await User.findOne({ authSessions: token });
  if (!user) return null;
  const session = { user: serializeUser(user), expiresAt: Date.now() + SESSION_TTL_MS };
  sessions.set(token, session);
  return session;
}

export async function requireAuth(req, res, next) {
  try {
    const token = getBearerToken(req);
    const session = token && await resolveSession(token);
    if (!session) return res.status(401).json({ error: 'Session expired or invalid.' });
    // Defence in depth: a session must never outrank an unverified account,
    // even if one was created before verification was introduced.
    if (session.user.emailVerified === false) {
      return res.status(403).json({
        code: 'EMAIL_NOT_VERIFIED',
        error: 'Verify your email address before continuing.'
      });
    }
    req.authToken = token;
    req.user = session.user;
    req.role = session.user.role;
    next();
  } catch (error) {
    next(error);
  }
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
    if (!roles.includes(req.role)) return res.status(403).json({ error: 'You do not have permission to perform this action.' });
    next();
  };
}

export async function invalidateSession(token) {
  if (!token) return;
  sessions.delete(token);
  if (databaseReady) await User.updateOne({ authSessions: token }, { $pull: { authSessions: token } });
}

export async function revokeAllSessionsForUser(userId) {
  sessions.forEach((session, token) => {
    if (String(session.user._id) === String(userId)) sessions.delete(token);
  });
  if (databaseReady) await User.updateOne({ _id: userId }, { $set: { authSessions: [] } });
}

// Personal AI keys are stored per user and never leave the server in any
// shape. The field is select:false, so reads must ask for it explicitly.
export async function findUserAiKey(id) {
  if (!id) return '';
  if (!databaseReady) {
    const user = [...memoryUsers.values()].find((item) => String(item._id) === String(id));
    return String(user?.openrouterApiKey || '').trim();
  }
  const user = await User.findById(id).select('+openrouterApiKey');
  return String(user?.openrouterApiKey || '').trim();
}

export async function updateUserAiKey(id, key) {
  const value = String(key || '').trim();
  if (!databaseReady) {
    const user = [...memoryUsers.values()].find((item) => String(item._id) === String(id));
    if (user) user.openrouterApiKey = value;
    return;
  }
  await User.updateOne({ _id: id }, { $set: { openrouterApiKey: value } });
}
