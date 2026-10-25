import mongoose from 'mongoose';
import { getEffective } from './lib/envConfig.js';

// Only an explicit opt-in (or the unit-test script) may use RAM storage.
// Silent fallback is what made every developer's data differ and vanish.
const memoryAllowed = () => ['true', '1'].includes(process.env.ALLOW_MEMORY_DB) || process.env.NODE_ENV === 'test';
let mode = 'unconfigured';
let lastError = null;

export function databaseStatus() {
  const connection = mongoose.connection;
  return {
    mode,
    ready: mode === 'mongodb' ? connection.readyState === 1 : mode === 'memory',
    name: mode === 'mongodb' ? connection.name : null,
    host: mode === 'mongodb' ? connection.host : null,
    error: lastError
  };
}

export function normalizeMongoUri(uri, defaultDatabase = 'leadai_dev') {
  const value = String(uri).trim();
  const match = /^(mongodb(?:\+srv)?:\/\/[^/?]+)(\/[^?]*)?(\?.*)?$/i.exec(value);
  if (!match) return value;
  const [, authority, path = '', query = ''] = match;
  if (path && path !== '/') return value;
  return `${authority}/${defaultDatabase}${query}`;
}

export function parseDatabaseName(uri) {
  const normalizedUri = normalizeMongoUri(uri);
  const match = /^mongodb(?:\+srv)?:\/\/[^/?#]+\/([^/?#]+)(?:\?.*)?$/i.exec(normalizedUri);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export async function connectDatabase() {
  if (memoryAllowed()) {
    mode = 'memory';
    lastError = null;
    return databaseStatus();
  }

  // Tiered fallback hierarchy for MONGODB_URI:
  //   Tier 1: User Settings override (via /api/settings/env)  -> getEffective
  //   Tier 2: Environment variable (backend/.env)            -> process.env
  //   Tier 3: Local default fallback                         -> mongodb://localhost:27017/leadai
  const overrideUri = String(getEffective('MONGODB_URI')).trim();
  const envUri = String(process.env.MONGODB_URI || '').trim();
  const configuredUri = overrideUri || envUri || 'mongodb://localhost:27017/leadai';
  const uri = normalizeMongoUri(configuredUri);

  let source = 'local default';
  if (overrideUri) source = 'user settings override';
  else if (envUri) source = 'environment variable';

  if (!/^mongodb(\+srv)?:\/\//i.test(uri)) {
    throw new Error('MONGODB_URI must start with mongodb:// or mongodb+srv://.');
  }
  const name = parseDatabaseName(uri);
  if (!name) {
    throw new Error('MONGODB_URI must name a database, e.g. mongodb://127.0.0.1:27017/leadai.');
  }
  mongoose.connection.on('disconnected', () => console.warn('[db] MongoDB disconnected; requests fail until the driver reconnects.'));
  mongoose.connection.on('reconnected', () => console.log('[db] MongoDB reconnected.'));
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000, connectTimeoutMS: 10_000 });
  } catch (error) {
    lastError = error.message;
    throw new Error('Could not connect to MongoDB database "' + name + '": ' + error.message);
  }
  mode = 'mongodb';
  lastError = null;
  console.log('[db] Connected successfully using ' + source + ' (' + name + ') on ' + mongoose.connection.host);
  return databaseStatus();
}
export async function disconnectDatabase() {
  await mongoose.disconnect();
}

export async function reconnectDatabase() {
  await disconnectDatabase();
  return connectDatabase();
}
