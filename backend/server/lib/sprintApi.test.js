// End-to-end API checks for Sprint Backlog. Spawns the server on a scratch port so it
// never touches the developer API on :4000, then tears the process down.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = process.env.TEST_PORT || 4100;
const BASE = `http://127.0.0.1:${PORT}/api`;

const server = spawn(process.execPath, ['server/index.js'], {
  env: { ...process.env, PORT: String(PORT), MONGODB_URI: '', ALLOW_MEMORY_DB: '1' },
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

async function api(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, { headers: { 'Content-Type': 'application/json', ...(globalThis.authToken ? { Authorization: `Bearer ${globalThis.authToken}` } : {}) }, ...options });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

let passed = 0;
function check(label, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

try {
  await waitForApi();
  console.log(`sprint backlog API checks (port ${PORT})\n`);

  const health = await api('/health');
  check('health reports ok', () => assert.equal(health.body.ok, true));

  const email = `sprint-${Date.now()}@example.com`;
  await api('/auth/signup', { method: 'POST', body: JSON.stringify({ name: 'Sprint Tester', email, password: 'Password123!' }) });
  const signedIn = await api('/auth/signin', { method: 'POST', body: JSON.stringify({ email, password: 'Password123!' }) });
  globalThis.authToken = signedIn.body.token;

  const { body: sprints } = await api('/sprints');
  check('seeded sprint exists with a string id', () => {
    assert.equal(sprints.length, 1);
    assert.equal(typeof sprints[0].id, 'string');
    assert.notEqual(sprints[0].id, '[object Object]');
  });
  check('sprint runs 14 calendar days', () => assert.equal(sprints[0].durationDays, 14));
  check('sprint day is computed, not hardcoded', () => {
    assert.equal(sprints[0].current.total, 14);
    assert.ok(sprints[0].current.day >= 1 && sprints[0].current.day <= 14);
    assert.equal(sprints[0].current.state, 'active');
  });
  check('sprint exposes a persisted goal', () => assert.ok(sprints[0].goal.length > 0));

  const sprintId = sprints[0].id;
  const { body: backlogBefore } = await api('/backlog');
  const { body: sprintTasksBefore } = await api(`/sprints/${sprintId}/tasks`);
  check('every task is in exactly one backlog list', () => {
    assert.equal(backlogBefore.length + sprintTasksBefore.length, 5);
  });

  const task = backlogBefore[0];
  const moved = await api(`/sprints/${sprintId}/tasks`, { method: 'POST', body: JSON.stringify({ key: task.key }) });
  check('moving a task to the sprint returns 201', () => assert.equal(moved.status, 201));

  const { body: backlogAfter } = await api('/backlog');
  const { body: sprintTasksAfter } = await api(`/sprints/${sprintId}/tasks`);
  check('task left the product backlog', () => assert.equal(backlogAfter.some((t) => t.key === task.key), false));
  check('task entered the sprint backlog', () => assert.equal(sprintTasksAfter.some((t) => t.key === task.key), true));
  check('task is not duplicated across lists', () => {
    const overlap = backlogAfter.filter((t) => sprintTasksAfter.some((s) => s.key === t.key));
    assert.deepEqual(overlap, []);
  });

  check('move enters the sprint through To Do and keeps the assignee', () => {
    assert.equal(moved.body.status, 'todo');
    assert.equal(moved.body.assignee, task.assignee);
  });

  // A sprint task advances one validated stage at a time: To Do -> In Progress -> Review -> Done.
  await api(`/tasks/${task.key}`, { method: 'PATCH', body: JSON.stringify({ storyPoints: 5, status: 'progress' }) });
  await api(`/tasks/${task.key}`, { method: 'PATCH', body: JSON.stringify({ status: 'review' }) });
  await api(`/tasks/${task.key}`, { method: 'PATCH', body: JSON.stringify({ status: 'done' }) });
  const { body: afterDone } = await api(`/sprints/${sprintId}`);
  check('progress uses completed story points / committed', () => {
    assert.equal(afterDone.progress.totalStoryPoints, 5);
    assert.equal(afterDone.progress.completedStoryPoints, 5);
    assert.equal(afterDone.progress.remainingStoryPoints, 0);
    assert.equal(afterDone.progress.progressPercent, 100);
  });

  // Only To Do work may leave a sprint; return a second item while it is still To Do.
  const returnable = backlogAfter[0];
  const addedForReturn = await api(`/sprints/${sprintId}/tasks`, { method: 'POST', body: JSON.stringify({ key: returnable.key }) });
  check('a second To Do item can enter the sprint', () => assert.equal(addedForReturn.status, 201));
  const removed = await api(`/sprints/${sprintId}/tasks/${returnable.key}`, { method: 'DELETE' });
  check('removing a task returns 200', () => assert.equal(removed.status, 200));
  const { body: backlogRestored } = await api('/backlog');
  const { body: sprintTasksRestored } = await api(`/sprints/${sprintId}/tasks`);
  check('removed task is back in the product backlog', () => {
    assert.equal(backlogRestored.some((t) => t.key === returnable.key), true);
    assert.equal(sprintTasksRestored.some((t) => t.key === returnable.key), false);
  });
  const { body: afterRemove } = await api(`/sprints/${sprintId}`);
  check('progress reflects the completed work that stayed in the sprint', () => assert.equal(afterRemove.progress.progressPercent, 100));

  const created = await api('/sprints', { method: 'POST', body: JSON.stringify({ name: 'Sprint 15', goal: 'Lifecycle', startDate: '2026-11-02' }) });
  check('creating a sprint derives a 14-day range', () => {
    assert.equal(created.status, 201);
    assert.equal(created.body.startDate, '2026-11-02');
    assert.equal(created.body.endDate, '2026-11-15');
    assert.equal(created.body.current.state, 'upcoming');
    assert.equal(created.body.current.day, 0);
  });

  const edited = await api(`/sprints/${created.body.id}`, { method: 'PATCH', body: JSON.stringify({ goal: 'Goal persists' }) });
  check('editing persists the goal without shifting dates', () => {
    assert.equal(edited.body.goal, 'Goal persists');
    assert.equal(edited.body.durationDays, 14);
    assert.equal(edited.body.startDate, '2026-11-02');
  });

  const renamed = await api(`/sprints/${created.body.id}`, { method: 'PATCH', body: JSON.stringify({ name: 'Sprint 15 Renamed' }) });
  check('sprint name is editable', () => assert.equal(renamed.body.name, 'Sprint 15 Renamed'));

  const { body: both } = await api('/sprints');
  check('multiple sprints are selectable', () => assert.equal(both.length, 2));

  const rejections = [
    ['13-day range', '/sprints', { name: 'X', startDate: '2026-10-01', endDate: '2026-10-13' }],
    ['end before start', '/sprints', { name: 'X', startDate: '2026-10-05', endDate: '2026-10-01' }],
    ['invalid date', '/sprints', { name: 'X', startDate: '2026-02-30' }],
    ['missing name', '/sprints', { startDate: '2026-10-01' }]
  ];
  for (const [label, path, payload] of rejections) {
    const { status } = await api(path, { method: 'POST', body: JSON.stringify(payload) });
    check(`rejects ${label}`, () => assert.equal(status, 400));
  }

  const { status: missingSprint } = await api('/sprints/does-not-exist');
  check('rejects unknown sprint id', () => assert.equal(missingSprint, 404));
  const { status: missingTask } = await api(`/sprints/${sprintId}/tasks`, { method: 'POST', body: JSON.stringify({ key: 'KAN-999' }) });
  check('rejects unknown task key', () => assert.equal(missingTask, 404));

  const { body: emptySprint } = await api(`/sprints/${created.body.id}`);
  check('empty sprint reports 0% without dividing by zero', () => assert.equal(emptySprint.progress.progressPercent, 0));

  const { body: boardTasks } = await api('/tasks');
  check('existing board endpoint still returns all tasks', () => assert.equal(boardTasks.length, 5));

  console.log(`\n${passed} API checks passed.`);
} finally {
  server.kill();
}