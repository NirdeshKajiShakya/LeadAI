import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.SYSTEM_SETUP_TEST_PORT || 4138);
const BASE = `http://127.0.0.1:${PORT}/api`;
const child = spawn(process.execPath, [fileURLToPath(new URL('../index.js', import.meta.url))], {
  env: {
    ...process.env,
    PORT: String(PORT),
    MONGODB_URI: '',
    OPENROUTER_API_KEY: 'test-secret-not-for-status',
    ALLOW_MEMORY_DB: '1'
  },
  stdio: 'ignore'
});

async function waitForApi() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch { /* the child process is still starting */ }
    await sleep(100);
  }
  throw new Error('system setup test server did not start');
}

async function api(path, token, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {})
    }
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

try {
  await waitForApi();
  const initialStatus = await api('/system/status');
  assert.equal(initialStatus.status, 200);
  assert.equal(initialStatus.body.setupRequired, true);
  assert.equal(initialStatus.body.mongodb.usingLocalDefault, true);
  assert.equal(initialStatus.body.mongodb.configured, false);
  assert.equal(initialStatus.body.openrouter.configured, true);
  assert.equal(JSON.stringify(initialStatus.body).includes('test-secret-not-for-status'), false);
  assert.equal(JSON.stringify(initialStatus.body).includes('mongodb://'), false);

  const configured = await api('/system/configure', null, {
    method: 'POST',
    body: JSON.stringify({ databaseMode: 'local', skipAI: true })
  });
  assert.equal(configured.status, 200);
  assert.deepEqual(configured.body, { saved: true, setupRequired: false });

  const unauthorized = await api('/system/configure', null, {
    method: 'POST',
    body: JSON.stringify({ databaseMode: 'local', skipAI: true })
  });
  assert.equal(unauthorized.status, 401);

  const suffix = Date.now();
  await api('/auth/signup', null, {
    method: 'POST',
    body: JSON.stringify({ name: 'Setup Test', email: `setup-${suffix}@example.com`, password: 'Password123!' })
  });
  const signedIn = await api('/auth/signin', null, {
    method: 'POST',
    body: JSON.stringify({ email: `setup-${suffix}@example.com`, password: 'Password123!' })
  });
  const token = signedIn.body.token;

  const invalid = await api('/system/configure', token, {
    method: 'POST',
    body: JSON.stringify({ databaseMode: 'cloud', mongodbUri: 'https://example.com', skipAI: true })
  });
  assert.equal(invalid.status, 400);

  const configuredCloud = await api('/system/configure', token, {
    method: 'POST',
    body: JSON.stringify({
      databaseMode: 'cloud',
      mongodbUri: 'mongodb+srv://cluster.example?retryWrites=true',
      openrouterApiKey: 'test-cloud-setup-key'
    })
  });
  assert.equal(configuredCloud.status, 200);
  assert.deepEqual(configuredCloud.body, { saved: true, setupRequired: false });

  const finalStatus = await api('/system/status');
  assert.equal(finalStatus.body.setupRequired, false);
  assert.equal(finalStatus.body.mongodb.configured, true);
  assert.equal(finalStatus.body.mongodb.usingLocalDefault, false);
  assert.equal(finalStatus.body.mongodb.connected, false);
  assert.equal(finalStatus.body.openrouter.configured, true);
  assert.equal(JSON.stringify(finalStatus.body).includes('mongodb://'), false);
  console.log('System setup API tests passed.');
} finally {
  child.kill('SIGTERM');
}
