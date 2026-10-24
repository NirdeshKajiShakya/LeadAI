// Profile API checks in explicit in-memory mode (ALLOW_MEMORY_DB).
// Covers validation, authorization, protected fields and session refresh.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = process.env.TEST_PROFILE_PORT || 4103;
const BASE = `http://127.0.0.1:${PORT}/api`;
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const server = spawn(process.execPath, ['server/index.js'], {
  env: { ...process.env, PORT: String(PORT), MONGODB_URI: '', ALLOW_MEMORY_DB: '1', NODE_ENV: 'test', AUTH_OTP_DISABLED: '1' },
  stdio: 'ignore'
});

async function waitForApi() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch { /* not up yet */ }
    await sleep(150);
  }
  throw new Error('server did not start');
}

async function api(path, { token, ...options } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers }
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body, headers: response.headers };
}

async function signUpAndIn(name, email) {
  await api('/auth/signup', { method: 'POST', body: JSON.stringify({ name, email, password: 'Password123!' }) });
  const signedIn = await api('/auth/signin', { method: 'POST', body: JSON.stringify({ email, password: 'Password123!' }) });
  return signedIn.body.token;
}

let passed = 0;
async function check(label, fn) {
  await fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

try {
  await waitForApi();
  console.log(`profile API checks, in-memory mode (port ${PORT})\n`);

  const health = await api('/health');
  await check('health reports explicit in-memory mode', () => {
    assert.equal(health.body.ok, true);
    assert.equal(health.body.database, 'memory');
  });

  await check('profile requires authentication', async () => {
    assert.equal((await api('/profile')).status, 401);
    assert.equal((await api('/profile', { method: 'PATCH', body: JSON.stringify({ name: 'Nope' }) })).status, 401);
  });

  const stamp = Date.now();
  const aliceEmail = `profile-alice-${stamp}@example.com`;
  const bobEmail = `profile-bob-${stamp}@example.com`;
  const alice = await signUpAndIn('Profile Alice', aliceEmail);
  const bob = await signUpAndIn('Profile Bob', bobEmail);

  const initial = await api('/profile', { token: alice });
  await check('profile returns identity, real starter-task stats and no fake sprint', () => {
    assert.equal(initial.status, 200);
    assert.equal(initial.body.profile.email, aliceEmail);
    assert.equal(initial.body.profile.name, 'Profile Alice');
    assert.equal(initial.body.profile.username, '');
    assert.equal(initial.body.stats.totalTasks, 5);
    assert.equal(initial.body.stats.completedTasks, 1);
    assert.equal(initial.body.recentTasks.length, 5);
    assert.equal(initial.body.sprint, null);
  });
  await check('profile responses are private', () => {
    assert.equal(initial.headers.get('cache-control'), 'no-store');
    assert.equal('passwordHash' in initial.body.profile, false);
    assert.equal('authSessions' in initial.body.profile, false);
  });

  const patch = await api('/profile', {
    token: alice,
    method: 'PATCH',
    body: JSON.stringify({
      name: 'Alice Cooper',
      username: 'alice-cooper',
      bio: 'Backend and database work.',
      location: 'Kathmandu, Nepal',
      website: 'https://example.com/alice',
      avatar: TINY_PNG
    })
  });
  await check('valid profile update is accepted', () => {
    assert.equal(patch.status, 200);
    assert.equal(patch.body.profile.name, 'Alice Cooper');
    assert.equal(patch.body.profile.username, 'alice-cooper');
    assert.equal(patch.body.profile.website, 'https://example.com/alice');
    assert.equal(patch.body.profile.avatar, TINY_PNG);
  });

  const reread = await api('/profile', { token: alice });
  await check('profile changes persist and are returned on reload', () => {
    assert.equal(reread.body.profile.name, 'Alice Cooper');
    assert.equal(reread.body.profile.bio, 'Backend and database work.');
    assert.equal(reread.body.profile.location, 'Kathmandu, Nepal');
    assert.equal(reread.body.profile.avatar, TINY_PNG);
  });

  const current = await api('/auth/current', { token: alice });
  await check('session reflects the updated profile without re-login', () => {
    assert.equal(current.status, 200);
    assert.equal(current.body.name, 'Alice Cooper');
    assert.equal(current.body.username, 'alice-cooper');
  });

  const escalation = await api('/profile', {
    token: alice,
    method: 'PATCH',
    body: JSON.stringify({ role: 'admin', email: 'attacker@example.com', passwordHash: 'injected', authSessions: ['forged'], _id: 'forged-id' })
  });
  const afterEscalation = await api('/profile', { token: alice });
  await check('role, email and secrets cannot be changed through the profile endpoint', () => {
    assert.equal(escalation.status, 200);
    assert.equal(afterEscalation.body.profile.role, 'member');
    assert.equal(afterEscalation.body.profile.email, aliceEmail);
  });

  const bobOwn = await api('/profile', { token: bob, method: 'PATCH', body: JSON.stringify({ username: 'bob-profile', bio: 'Bob original bio' }) });
  const bobId = (await api('/profile', { token: bob })).body.profile._id;
  const idor = await api('/profile', { token: alice, method: 'PATCH', body: JSON.stringify({ _id: bobId, name: 'Changed Alice', bio: 'Changed' }) });
  const bobAfter = await api('/profile', { token: bob });
  const aliceAfter = await api('/profile', { token: alice });
  await check('another user cannot be edited by sending their id', () => {
    assert.equal(bobOwn.status, 200);
    assert.equal(idor.status, 200);
    assert.equal(bobAfter.body.profile.name, 'Profile Bob');
    assert.equal(bobAfter.body.profile.bio, 'Bob original bio');
    assert.equal(aliceAfter.body.profile.name, 'Changed Alice');
  });

  const conflict = await api('/profile', { token: bob, method: 'PATCH', body: JSON.stringify({ username: 'alice-cooper' }) });
  await check('duplicate username is rejected with 409', () => assert.equal(conflict.status, 409));

  const badUsername = await api('/profile', { token: alice, method: 'PATCH', body: JSON.stringify({ username: 'ab' }) });
  const badWebsite = await api('/profile', { token: alice, method: 'PATCH', body: JSON.stringify({ website: 'javascript:alert(1)' }) });
  const badBio = await api('/profile', { token: alice, method: 'PATCH', body: JSON.stringify({ bio: 'x'.repeat(301) }) });
  const badAvatarType = await api('/profile', { token: alice, method: 'PATCH', body: JSON.stringify({ avatar: 'data:text/html;base64,PHNjcmlwdD4=' }) });
  const bigAvatar = await api('/profile', { token: alice, method: 'PATCH', body: JSON.stringify({ avatar: `data:image/png;base64,${'A'.repeat(120_000)}` }) });
  await check('invalid username, website, bio and avatar are rejected', () => {
    assert.equal(badUsername.status, 400);
    assert.equal(badWebsite.status, 400);
    assert.equal(badBio.status, 400);
    assert.equal(badAvatarType.status, 400);
    assert.equal(bigAvatar.status, 400);
  });

  const cleared = await api('/profile', { token: bob, method: 'PATCH', body: JSON.stringify({ username: '', website: '' }) });
  await check('optional fields can be cleared', () => {
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.profile.username, '');
  });

  const tasks = await api('/tasks', { token: alice });
  const openTask = tasks.body.find((task) => task.status !== 'done');
  await api(`/tasks/${openTask.key}`, { token: alice, method: 'PATCH', body: JSON.stringify({ status: 'done' }) });
  const afterTask = await api('/profile', { token: alice });
  await check('activity stats reflect real board changes', () => {
    assert.equal(afterTask.body.stats.completedTasks, 2);
    assert.equal(afterTask.body.stats.openTasks, 3);
  });

  console.log(`\n${passed} profile API checks passed.`);
} finally {
  server.kill();
}
