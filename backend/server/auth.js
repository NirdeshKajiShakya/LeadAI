import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { User } from './models/User.js';

export const BCRYPT_ROUNDS = 12;
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

export const sessions = new Map();
export const resetTokens = new Map();
export const memoryUsers = new Map();
let databaseReady = false;

export function setDatabaseReady(value) {
  databaseReady = value;
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

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
    throw createAuthError(400, 'Password must be between 8 and 128 characters.');
  }
}

export function serializeUser(user) {
  const value = user?.toObject ? user.toObject() : { ...user };
  delete value.passwordHash;
  delete value.resetToken;
  delete value.resetTokenExpiresAt;
  delete value.authSessions;
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

export async function createUser({ email, password, name, role = 'member' }) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    throw createAuthError(400, 'A valid email address is required.');
  }
  validatePassword(password);
  const passwordHash = await hashPassword(password);
  if (!passwordHash) throw createAuthError(500, 'Could not create account.');
  const data = {
    email: normalizedEmail,
    passwordHash,
    name: String(name || '').trim().slice(0, 80) || normalizedEmail,
    role: role === 'admin' ? 'member' : role,
    skills: []
  };
  if (!databaseReady) {
    if (memoryUsers.has(normalizedEmail)) throw createAuthError(409, 'An account with this email already exists.');
    const user = { ...data, _id: crypto.randomUUID() };
    memoryUsers.set(normalizedEmail, user);
    return serializeUser(user);
  }
  const user = new User(data);
  try {
    await user.save();
  } catch (error) {
    if (error.code === 11000) throw createAuthError(409, 'An account with this email already exists.');
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

export function createResetToken(userId) {
  const token = randomToken();
  resetTokens.set(token, { userId: String(userId), expiresAt: Date.now() + RESET_TOKEN_TTL_MS });
  return token;
}

export function consumeResetToken(token) {
  const record = resetTokens.get(token);
  resetTokens.delete(token);
  if (!record || record.expiresAt <= Date.now()) return null;
  return record;
}
