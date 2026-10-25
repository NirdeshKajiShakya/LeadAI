import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.SYSTEM_SETUP_TEST_PORT || 4138);
const BASE = `http://127.0.0.1:${PORT}/api`;
const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'leadai-system-setup-'));
const testEnvPath = path.join(testDirectory, '.env');
const child = spawn(process.execPath, [fileURLToPath(new URL('../index.js', import.meta.url))], {
  env: {
    ...process.env,
    PORT: String(PORT),
    MONGODB_URI: '',
    OPENROUTER_API_KEY: 'test-secret-not-for-status',
    LEADAI_ENV_FILE: testEnvPath,
    ALLOW_MEMORY_DB: '1'
  },
  stdio: 'ignore'
});

async function waitForApi(base = BASE) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      if ((await fetch(`${base}/health`)).ok) return;
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
  const savedLocalConfig = dotenv.parse(fs.readFileSync(testEnvPath));
  assert.equal(savedLocalConfig.MONGODB_URI, 'mongodb://localhost:27017/leadai');
  assert.equal(savedLocalConfig.LEADAI_SETUP_COMPLETE, 'true');
  assert.equal(fs.statSync(testEnvPath).mode & 0o777, 0o600);

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
  const savedCloudConfig = dotenv.parse(fs.readFileSync(testEnvPath));
  assert.equal(savedCloudConfig.MONGODB_URI, 'mongodb+srv://cluster.example/leadai_dev?retryWrites=true');
  assert.equal(savedCloudConfig.OPENROUTER_API_KEY, 'test-cloud-setup-key');
  assert.equal(savedCloudConfig.LEADAI_SETUP_COMPLETE, 'true');

  const finalStatus = await api('/system/status');
  assert.equal(finalStatus.body.setupRequired, false);
  assert.equal(finalStatus.body.mongodb.configured, true);
  assert.equal(finalStatus.body.mongodb.usingLocalDefault, false);
  assert.equal(finalStatus.body.mongodb.connected, false);
  assert.equal(finalStatus.body.openrouter.configured, true);
  assert.equal(JSON.stringify(finalStatus.body).includes('mongodb://'), false);

  const restartPort = PORT + 1;
  const restartBase = `http://127.0.0.1:${restartPort}/api`;
  const restartEnv = { ...process.env };
  delete restartEnv.MONGODB_URI;
  delete restartEnv.OPENROUTER_API_KEY;
  delete restartEnv.LEADAI_SETUP_COMPLETE;
  const restartedChild = spawn(process.execPath, [fileURLToPath(new URL('../index.js', import.meta.url))], {
    env: {
      ...restartEnv,
      PORT: String(restartPort),
      LEADAI_ENV_FILE: testEnvPath,
      ALLOW_MEMORY_DB: '1'
    },
    stdio: 'ignore'
  });
  try {
    await waitForApi(restartBase);
    const restartedStatusResponse = await fetch(`${restartBase}/system/status`);
    const restartedStatus = await restartedStatusResponse.json();
    assert.equal(restartedStatus.setupRequired, false);
    assert.equal(restartedStatus.mongodb.configured, true);
    assert.equal(restartedStatus.openrouter.configured, true);
  } finally {
    restartedChild.kill('SIGTERM');
  }

  console.log('System setup API tests passed.');
} finally {
  child.kill('SIGTERM');
  fs.rmSync(testDirectory, { recursive: true, force: true });
}
