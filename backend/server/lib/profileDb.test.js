// Real-MongoDB checks against a disposable leadai_test_* database.
// Verifies the connection targets the configured database, profile edits survive a server
// restart, seed commands are idempotent, and the shared indexes exist.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import mongoose from 'mongoose';
import { User } from '../models/User.js';
import { Task } from '../models/Task.js';
import { Sprint } from '../models/Sprint.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(here, '../..');
const dbName = `leadai_test_${process.pid}_${Date.now()}`;
if (!dbName.startsWith('leadai_test_')) throw new Error('refusing to run against a non-test database');
const base = (process.env.TEST_MONGODB_BASE || 'mongodb://127.0.0.1:27017').replace(/\/$/, '');
const uri = `${base}/${dbName}`;
const PORT = process.env.TEST_DB_PROFILE_PORT || 4102;
const BASE = `http://127.0.0.1:${PORT}/api`;
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let passed = 0;
async function check(label, fn) {
  await fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

async function api(path, { token, ...options } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers }
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

function serverProcess() {
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: backendRoot,
    env: { ...process.env, PORT: String(PORT), MONGODB_URI: uri, ALLOW_MEMORY_DB: 'false', NODE_ENV: 'test', AUTH_OTP_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  return { child, output: () => output };
}

async function waitForApi(server) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch { /* not up yet */ }
    await sleep(150);
  }
  throw new Error(`server did not start:\n${server.output()}`);
}

async function stop(server) {
  if (!server?.child || server.child.exitCode !== null) return;
  server.child.kill();
  await new Promise((resolve) => server.child.once('exit', resolve));
}

function dbScript(...args) {
  return execFileSync(process.execPath, ['scripts/db.js', ...args], {
    cwd: backendRoot,
    env: { ...process.env, MONGODB_URI: uri, NODE_ENV: 'development', ALLOW_MEMORY_DB: 'false' },
    encoding: 'utf8'
  });
}

let server;
let reachable = false;
try {
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 1500 });
    reachable = true;
  } catch {
    console.log('SKIP: MongoDB is not reachable at 127.0.0.1:27017; set TEST_MONGODB_BASE to run database checks.');
  }
  await mongoose.disconnect().catch(() => {});

  if (reachable) {
    console.log(`profile + database checks, MongoDB scratch database "${dbName}"\n`);

    const firstSetup = dbScript('setup');
    const secondSetup = dbScript('setup');
    await check('db:setup is idempotent', () => {
      assert.match(firstSetup, /Indexes ensured/);
      assert.match(secondSetup, /Indexes ensured/);
    });

    server = serverProcess();
    await waitForApi(server);

    const health = await (await fetch(`${BASE}/health`)).json();
    await check('health reports the configured MongoDB database', () => {
      assert.equal(health.database, 'mongodb');
      assert.equal(health.db, dbName);
    });

    const stamp = Date.now();
    const email = `db-profile-${stamp}@example.com`;
    await api('/auth/signup', { method: 'POST', body: JSON.stringify({ name: 'DB Profile', username: `db-seed-${stamp}`, email, password: 'Password123!' }) });
    const signedIn = await api('/auth/signin', { method: 'POST', body: JSON.stringify({ email, password: 'Password123!' }) });
    const token = signedIn.body.token;
    await check('sign-in works against the shared database', () => assert.ok(token));

    const patched = await api('/profile', {
      token,
      method: 'PATCH',
      body: JSON.stringify({ name: 'DB Profile Updated', username: `db-profile-${stamp}`, bio: 'Persisted in MongoDB', location: 'Pokhara', website: 'https://example.com/db', avatar: TINY_PNG })
    });
    await check('profile update is written to MongoDB', () => {
      assert.equal(patched.status, 200);
      assert.equal(patched.body.profile.username, `db-profile-${stamp}`);
    });

    await stop(server);
    server = serverProcess();
    await waitForApi(server);
    const reloaded = await api('/profile', { token });
    await check('profile and session survive a server restart', () => {
      assert.equal(reloaded.status, 200);
      assert.equal(reloaded.body.profile.name, 'DB Profile Updated');
      assert.equal(reloaded.body.profile.bio, 'Persisted in MongoDB');
      assert.equal(reloaded.body.profile.location, 'Pokhara');
      assert.equal(reloaded.body.profile.avatar, TINY_PNG);
    });

    dbScript('seed', `--email=${email}`);
    dbScript('seed', `--email=${email}`);
    const seeded = await api('/profile', { token });
    await check('db:seed is idempotent and adds real sprint progress', () => {
      assert.equal(seeded.body.stats.totalTasks, 8);
      assert.equal(seeded.body.stats.sprints, 1);
      assert.equal(seeded.body.sprint.progress.totalStoryPoints, 4);
      assert.equal(seeded.body.sprint.progress.progressPercent, 50);
    });

    const otherEmail = `db-other-${stamp}@example.com`;
    await api('/auth/signup', { method: 'POST', body: JSON.stringify({ name: 'Other Dev', username: `db-other-${stamp}`, email: otherEmail, password: 'Password123!' }) });
    const otherSignIn = await api('/auth/signin', { method: 'POST', body: JSON.stringify({ email: otherEmail, password: 'Password123!' }) });
    await api('/profile', { token: otherSignIn.body.token, method: 'PATCH', body: JSON.stringify({ username: `taken-${stamp}` }) });
    const duplicate = await api('/profile', { token, method: 'PATCH', body: JSON.stringify({ username: `taken-${stamp}` }) });
    const otherTasks = await api('/tasks', { token });
    await check('unique usernames and owner-scoped board queries hold on a shared database', () => {
      assert.equal(duplicate.status, 409);
      assert.equal(otherTasks.body.length, 8);
      assert.equal(otherTasks.body.every((task) => task.ownerId === reloaded.body.profile._id), true);
    });

    const otherProfile = await api('/profile', { token: otherSignIn.body.token });
    await check('each account only sees its own profile and tasks', () => {
      assert.equal(otherProfile.body.profile.email, otherEmail);
      assert.equal(otherProfile.body.stats.totalTasks, 5);
      assert.equal(otherProfile.body.sprint, null);
    });

    await stop(server);
    server = null;

    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
    const userIndexes = await User.collection.indexes();
    const taskIndexes = await Task.collection.indexes();
    const sprintIndexes = await Sprint.collection.indexes();
    await check('required indexes exist with uniqueness and sparse options', () => {
      const username = userIndexes.find((index) => index.key.username === 1);
      assert.equal(username.unique, true);
      assert.equal(username.sparse, true);
      assert.equal(userIndexes.find((index) => index.key.email === 1).unique, true);
      assert.equal(taskIndexes.find((index) => index.key.key === 1).unique, true);
      assert.ok(taskIndexes.some((index) => index.key.ownerId === 1 && index.key.createdAt === 1));
      assert.ok(taskIndexes.some((index) => index.key.sprintId === 1));
      assert.ok(sprintIndexes.some((index) => index.key.ownerId === 1 && index.key.createdAt === 1));
    });
    await check('document counts match the seeded run', async () => {
      assert.equal(await User.countDocuments(), 2);
      assert.equal(await Task.countDocuments(), 13);
      assert.equal(await Sprint.countDocuments(), 1);
    });

    await mongoose.connection.dropDatabase();
    console.log(`\n${passed} database/profile checks passed.`);
  }
} finally {
  await stop(server);
  if (reachable) {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 }).catch(() => {});
    await mongoose.connection.dropDatabase().catch(() => {});
    await mongoose.disconnect().catch(() => {});
  }
}
