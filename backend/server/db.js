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

// The database name is part of the connection string; refusing a URI without one
// keeps the API from silently writing into whatever database the driver picks.
export function parseDatabaseName(uri) {
  const match = /^mongodb(?:\+srv)?:\/\/[^/]*\/([^?]+)/.exec(String(uri));
  return match ? decodeURIComponent(match[1]) : null;
}

export async function connectDatabase() {
  const uri = String(getEffective('MONGODB_URI')).trim();
  if (!uri) {
    if (memoryAllowed()) {
      mode = 'memory';
      return databaseStatus();
    }
    throw new Error('MONGODB_URI is not set. Add the shared development URI to backend/.env (see backend/.env.example), or set ALLOW_MEMORY_DB=true for throwaway demo data.');
  }
  if (!/^mongodb(\+srv)?:\/\//.test(uri)) {
    throw new Error('MONGODB_URI must start with mongodb:// or mongodb+srv://.');
  }
  const name = parseDatabaseName(uri);
  if (!name) {
    throw new Error('MONGODB_URI must name a database, e.g. mongodb://127.0.0.1:27017/leadai_dev.');
  }
  mongoose.connection.on('disconnected', () => console.warn('[db] MongoDB disconnected; requests fail until the driver reconnects.'));
  mongoose.connection.on('reconnected', () => console.log('[db] MongoDB reconnected.'));
  try {
    // Atlas clusters can take several seconds to answer the first handshake.
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000, connectTimeoutMS: 10_000 });
  } catch (error) {
    lastError = error.message;
    throw new Error(`Could not connect to MongoDB database "${name}": ${error.message}`);
  }
  mode = 'mongodb';
  lastError = null;
  console.log(`[db] Connected to MongoDB database "${name}" on ${mongoose.connection.host}`);
  return databaseStatus();
}

export async function disconnectDatabase() {
  await mongoose.disconnect();
}

export async function reconnectDatabase() {
  await disconnectDatabase();
  return connectDatabase();
}
