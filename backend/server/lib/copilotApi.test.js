import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = process.env.TEST_COPILOT_PORT || 4105;
const BASE = `http://127.0.0.1:${PORT}/api`;
const server = spawn(process.execPath, ['server/index.js'], {
  env: {
    ...process.env,
    PORT: String(PORT),
    MONGODB_URI: '',
    ALLOW_MEMORY_DB: '1',
    NODE_ENV: 'test',
    OPENROUTER_API_KEY: ''
  },
  stdio: 'ignore'
});

async function waitForApi() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch { /* server is still starting */ }
    await sleep(150);
  }
  throw new Error('Copilot API server did not start.');
}

async function api(path, options = {}, token = '') {
  const response = await fetch(`${BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    ...options
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

async function signup(label) {
  const email = `copilot-${label}-${Date.now()}@example.com`;
  const name = `Copilot ${label}`;
  const created = await api('/auth/signup', {
    method: 'POST',
    body: JSON.stringify({ name, email, password: 'Password123!' })
  });
  assert.equal(created.status, 201, `signup failed for ${label}`);
  const signedIn = await api('/auth/signin', {
    method: 'POST',
    body: JSON.stringify({ email, password: 'Password123!' })
  });
  assert.equal(signedIn.status, 200, `signin failed for ${label}`);
  return { email, name, token: signedIn.body.token };
}

try {
  await waitForApi();
  console.log(`\nCopilot API checks (port ${PORT})\n`);

  const owner = await signup('owner');
  const teammate = await signup('teammate');
  const ownerProfile = await api('/profile', {
    method: 'PATCH',
    body: JSON.stringify({ skills: ['frontend'] })
  }, owner.token);
  assert.equal(ownerProfile.status, 200);
  const teammateProfile = await api('/profile', {
    method: 'PATCH',
    body: JSON.stringify({ skills: ['backend', 'payments', 'api'] })
  }, teammate.token);
  assert.equal(teammateProfile.status, 200);

  const boards = await api('/boards', {}, owner.token);
  assert.equal(boards.status, 200);
  const board = boards.body[0];
  assert.ok(board?.id);
  const invite = await api(`/boards/${board.id}/members`, {
    method: 'POST',
    body: JSON.stringify({ email: teammate.email })
  }, owner.token);
  assert.equal(invite.status, 201);

  const genericPrompt = await api('/copilot/chat', {
    method: 'POST',
    body: JSON.stringify({
      boardId: board.id,
      message: 'create some task for ecommerce web application and assign them as well'
    })
  }, owner.token);
  assert.equal(genericPrompt.status, 200);
  assert.equal(genericPrompt.body.action.type, 'created_many');
  assert.equal(genericPrompt.body.action.keys.length, 7);

  const explicitPrompt = await api('/copilot/chat', {
    method: 'POST',
    body: JSON.stringify({
      boardId: board.id,
      message: 'yes create about 10 tasks for the ecommerce web application and assign them to the users'
    })
  }, owner.token);
  assert.equal(explicitPrompt.status, 200);
  assert.equal(explicitPrompt.body.action.type, 'created_many');
  assert.equal(explicitPrompt.body.action.keys.length, 10);

  const allTasks = await api(`/tasks?boardId=${encodeURIComponent(board.id)}`, {}, owner.token);
  assert.equal(allTasks.status, 200);
  const created = allTasks.body.filter((task) => explicitPrompt.body.action.keys.includes(task.key));
  assert.equal(created.length, 10);
  assert.ok(created.every((task) => task.assignee !== 'Unassigned'));
  assert.ok(created.some((task) => task.assignee === owner.name));
  assert.ok(created.some((task) => task.assignee === teammate.name));
  assert.ok(created.every((task) => [1, 2, 3, 5, 8, 13].includes(task.storyPoints)));

  console.log('  ok  project requests with "some task" create a useful task plan');
  console.log('  ok  approximate numeric requests create the requested number of tasks');
  console.log('  ok  generated tasks persist and are assigned to current board members');
  console.log('\n3 Copilot API checks passed.');
} finally {
  server.kill();
}
