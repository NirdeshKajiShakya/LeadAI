// Personal AI key API checks in explicit in-memory mode (ALLOW_MEMORY_DB).
// Covers validation, authentication, hint-only responses and secret hygiene.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = process.env.TEST_USER_AI_KEY_PORT || 4111;
const BASE = `http://127.0.0.1:${PORT}/api`;
const SECRET = 'sk-or-v1-personal-key-for-tests';

const server = spawn(process.execPath, ['server/index.js'], {
  env: { ...process.env, PORT: String(PORT), MONGODB_URI: '', ALLOW_MEMORY_DB: '1', NODE_ENV: 'test', AUTH_OTP_DISABLED: '1', OPENROUTER_API_KEY: '' },
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

let passed = 0;
async function check(label, fn) {
  await fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

// A raw dump of every response body, so "the secret never appears" can be
// asserted globally instead of field by field.
const transcript = [];
async function tracked(path, options) {
  const result = await api(path, options);
  transcript.push(JSON.stringify(result.body || ''));
  return result;
}

try {
  await waitForApi();
  console.log(`user AI key checks, in-memory mode (port ${PORT})\n`);

  const email = `aikey-${Date.now()}@example.com`;
  await api('/auth/signup', { method: 'POST', body: JSON.stringify({ name: 'Key Holder', email, password: 'Password123!' }) });
  const signedIn = await api('/auth/signin', { method: 'POST', body: JSON.stringify({ email, password: 'Password123!' }) });
  const token = signedIn.body.token;
  assert.ok(token, 'expected a session token');

  await check('user-key endpoints require authentication', async () => {
    assert.equal((await api('/settings/user-key')).status, 401);
    assert.equal((await api('/settings/user-key', { method: 'PUT', body: JSON.stringify({ openrouterApiKey: SECRET }) })).status, 401);
  });

  await check('an unset key reports configured:false with no hint', async () => {
    const before = await tracked('/settings/user-key', { token });
    assert.equal(before.status, 200);
    assert.equal(before.body.configured, false);
    assert.equal(before.body.keyHint, '');
  });

  await check('saving a key returns only a hint', async () => {
    const saved = await tracked('/settings/user-key', { method: 'PUT', token, body: JSON.stringify({ openrouterApiKey: SECRET }) });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.saved, true);
    assert.equal(saved.body.configured, true);
    assert.equal(saved.body.keyHint, `••••${SECRET.slice(-4)}`);
    assert.ok(!JSON.stringify(saved.body).includes(SECRET), 'full key must not be returned');
  });

  await check('the stored key persists and is reported as a hint only', async () => {
    const again = await tracked('/settings/user-key', { token });
    assert.equal(again.body.configured, true);
    assert.equal(again.body.keyHint, `••••${SECRET.slice(-4)}`);
  });

  await check('settings/env reports personalKeyConfigured without exposing the key', async () => {
    const env = await tracked('/settings/env', { token });
    assert.equal(env.status, 200);
    assert.equal(env.body.personalKeyConfigured, true);
    // openrouterKeyHint is workspace-key detail and must stay empty for members.
    assert.equal(env.body.openrouterKeyHint, '');
  });

  await check('the key never leaks through the profile API', async () => {
    const profile = await tracked('/profile', { token });
    assert.equal(profile.status, 200);
    assert.ok(!('openrouterApiKey' in (profile.body.profile || {})), 'profile must not carry the key field');
  });

  await check('validation rejects non-strings and oversized keys', async () => {
    assert.equal((await api('/settings/user-key', { method: 'PUT', token, body: JSON.stringify({ openrouterApiKey: 42 }) })).status, 400);
    assert.equal((await api('/settings/user-key', { method: 'PUT', token, body: JSON.stringify({ openrouterApiKey: 'x'.repeat(300) }) })).status, 400);
  });

  await check('an empty value clears the stored key', async () => {
    const cleared = await tracked('/settings/user-key', { method: 'PUT', token, body: JSON.stringify({ openrouterApiKey: '' }) });
    assert.equal(cleared.body.configured, false);
    assert.equal(cleared.body.keyHint, '');
  });

  await check('the full secret never appeared in any response', () => {
    assert.ok(!transcript.some((entry) => entry.includes(SECRET)), 'secret leaked in an API response');
  });

  console.log(`\n${passed} user AI key checks passed.`);
} finally {
  server.kill('SIGTERM');
}
