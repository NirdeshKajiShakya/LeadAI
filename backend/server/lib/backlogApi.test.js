// End-to-end checks for Backlog Management: outside-sprint storage, deterministic
// priority ordering, and the validated Product Backlog <-> sprint workflow.
// Runs on a scratch port against throwaway in-memory storage, never the shared API.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { compareBacklogTasks, sortBacklog, priorityRank } from './backlogOrder.js';
import { isPermittedSprintStatusChange } from './taskTransitions.js';
import { todayIsoDate } from './sprintDates.js';

const PORT = process.env.TEST_BACKLOG_PORT || 4101;
const BASE = `http://127.0.0.1:${PORT}/api`;

let passed = 0;
function check(label, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

function placedKeys(tasks) {
  return tasks.map((task) => task.key);
}

// --- Ordering rules (pure functions) -------------------------------------------
console.log('backlog ordering rules\n');

check('urgent sorts before high, then medium, then low', () => {
  const ordered = sortBacklog([
    { key: 'KAN-1', priority: 'low', createdAt: '2026-01-01T00:00:00Z' },
    { key: 'KAN-2', priority: 'urgent', createdAt: '2026-01-01T00:00:00Z' },
    { key: 'KAN-3', priority: 'medium', createdAt: '2026-01-01T00:00:00Z' },
    { key: 'KAN-4', priority: 'high', createdAt: '2026-01-01T00:00:00Z' }
  ]);
  assert.deepEqual(placedKeys(ordered), ['KAN-2', 'KAN-4', 'KAN-3', 'KAN-1']);
});

check('equal priority is ordered oldest first', () => {
  const ordered = sortBacklog([
    { key: 'KAN-2', priority: 'high', createdAt: '2026-03-01T00:00:00Z' },
    { key: 'KAN-1', priority: 'high', createdAt: '2026-01-01T00:00:00Z' },
    { key: 'KAN-3', priority: 'high', createdAt: '2026-02-01T00:00:00Z' }
  ]);
  assert.deepEqual(placedKeys(ordered), ['KAN-1', 'KAN-3', 'KAN-2']);
});

check('identical priority and createdAt fall back to the task key', () => {
  const ordered = sortBacklog([
    { key: 'KAN-9', priority: 'medium', createdAt: '2026-01-01T00:00:00Z' },
    { key: 'KAN-2', priority: 'medium', createdAt: '2026-01-01T00:00:00Z' }
  ]);
  assert.deepEqual(placedKeys(ordered), ['KAN-2', 'KAN-9']);
});

check('missing optional fields sort safely instead of throwing', () => {
  const ordered = sortBacklog([
    { key: 'KAN-3', createdAt: '2026-01-02T00:00:00Z' },
    { key: 'KAN-1' },
    { key: 'KAN-2', priority: 'urgent' }
  ]);
  // A missing priority behaves like the schema default (medium); a missing createdAt
  // behaves like the oldest possible value.
  assert.deepEqual(placedKeys(ordered), ['KAN-2', 'KAN-1', 'KAN-3']);
  assert.equal(priorityRank(undefined), priorityRank('medium'));
  assert.ok(compareBacklogTasks({ key: 'A' }, { key: 'B' }) < 0);
});

check('sprint stage matrix keeps Review reversible and Done terminal', () => {
  assert.equal(isPermittedSprintStatusChange('todo', 'progress'), true);
  assert.equal(isPermittedSprintStatusChange('progress', 'review'), true);
  assert.equal(isPermittedSprintStatusChange('review', 'progress'), true);
  assert.equal(isPermittedSprintStatusChange('review', 'done'), true);
  assert.equal(isPermittedSprintStatusChange('todo', 'done'), false);
  assert.equal(isPermittedSprintStatusChange('done', 'progress'), false);
});

// --- API behaviour --------------------------------------------------------------
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

let token = '';
async function api(path, options = {}, useToken = token) {
  const response = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(useToken ? { Authorization: `Bearer ${useToken}` } : {}) },
    ...options
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

async function createTask(fields) {
  const { status, body } = await api('/tasks', { method: 'POST', body: JSON.stringify({ title: fields.title, priority: fields.priority, storyPoints: fields.storyPoints ?? 1 }) });
  assert.equal(status, 201, `could not create ${fields.title}`);
  return body;
}

try {
  await waitForApi();
  console.log(`\nbacklog API checks (port ${PORT})\n`);

  const email = `backlog-${Date.now()}@example.com`;
  await api('/auth/signup', { method: 'POST', body: JSON.stringify({ name: 'Backlog Tester', email, password: 'Password123!' }) });
  const signedIn = await api('/auth/signin', { method: 'POST', body: JSON.stringify({ email, password: 'Password123!' }) });
  token = signedIn.body.token;

  const missingBoardBacklog = await api('/backlog');
  check('Product Backlog requires a selected board', () => assert.equal(missingBoardBacklog.status, 400));
  const { body: boards } = await api('/boards');
  const boardId = boards[0].id;
  const boardScope = `?boardId=${encodeURIComponent(boardId)}`;
  const { body: initialBacklog } = await api(`/backlog${boardScope}`);
  const { body: noSprints } = await api(`/sprints?boardId=${encodeURIComponent(boardId)}`);
  check('new accounts start without a generated placeholder sprint', () => assert.deepEqual(noSprints, []));
  const createdSprint = await api('/sprints', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Sprint 1',
      goal: 'Ship the first product increment',
      startDate: todayIsoDate(),
      boardId,
      taskKeys: [initialBacklog[0].key]
    })
  });
  const activeSprint = createdSprint.body;
  check('a sprint is available after explicit creation', () => {
    assert.equal(createdSprint.status, 201);
    assert.equal(activeSprint.current.state, 'active');
    assert.equal(activeSprint.progress.total, 1);
  });
  check('creating a sprint can commit selected Product Backlog tasks', () => {
    assert.equal(createdSprint.body.progress.totalStoryPoints, 0);
    assert.equal(createdSprint.body.progress.total, 1);
    assert.equal(typeof createdSprint.body.id, 'string');
  });

  check('seeded work is stored outside every sprint', () => assert.ok(initialBacklog.length >= 5));
  const selectedTasks = await api(`/sprints/${activeSprint.id}/tasks`);
  const backlogAfterCreate = await api(`/backlog${boardScope}`);
  check('selected tasks leave the Product Backlog and enter To Do', () => {
    assert.equal(selectedTasks.body.some((task) => task.key === initialBacklog[0].key && task.status === 'todo'), true);
    assert.equal(backlogAfterCreate.body.some((task) => task.key === initialBacklog[0].key), false);
  });
  check('backlog response is ordered by the shared rule', () => {
    for (let index = 1; index < initialBacklog.length; index += 1) {
      assert.ok(compareBacklogTasks(initialBacklog[index - 1], initialBacklog[index]) <= 0);
    }
  });

  // Distinct priorities so the order cannot depend on creation timing.
  const urgent = await createTask({ title: 'Urgent backlog item', priority: 'urgent', storyPoints: 2 });
  const high = await createTask({ title: 'High backlog item', priority: 'high', storyPoints: 3 });
  const medium = await createTask({ title: 'Medium backlog item', priority: 'medium', storyPoints: 5 });
  const low = await createTask({ title: 'Low backlog item', priority: 'low', storyPoints: 8 });
  const lowTwin = await createTask({ title: 'Second low item', priority: 'low', storyPoints: 1 });

  const { body: ordered } = await api(`/backlog${boardScope}`);
  check('new backlog items persist without a sprint assignment', () => {
    for (const task of [urgent, high, medium, low, lowTwin]) {
      const stored = ordered.find((item) => item.key === task.key);
      assert.ok(stored, `${task.title} missing from the Product Backlog`);
      assert.equal(stored.sprintId ?? null, null);
    }
  });
  check('priority ordering is applied to real persisted data', () => {
    const keys = placedKeys(ordered);
    assert.ok(keys.indexOf(urgent.key) < keys.indexOf(high.key));
    assert.ok(keys.indexOf(high.key) < keys.indexOf(medium.key));
    assert.ok(keys.indexOf(medium.key) < keys.indexOf(low.key));
  });
  check('equal-priority items are ordered deterministically', () => {
    const lows = ordered.filter((task) => task.priority === 'low');
    for (let index = 1; index < lows.length; index += 1) {
      assert.ok(compareBacklogTasks(lows[index - 1], lows[index]) <= 0);
    }
  });

  const moved = await api(`/sprints/${activeSprint.id}/tasks`, { method: 'POST', body: JSON.stringify({ key: high.key }) });
  check('moving a backlog item into an active sprint returns 201', () => assert.equal(moved.status, 201));
  check('the item enters the sprint through To Do', () => assert.equal(moved.body.status, 'todo'));
  check('the item records the sprint assignment', () => assert.equal(String(moved.body.sprintId), String(activeSprint.id)));

  const { body: backlogAfterMove } = await api(`/backlog${boardScope}`);
  const { body: sprintAfterMove } = await api(`/sprints/${activeSprint.id}/tasks`);
  check('the item disappears from the Product Backlog', () => assert.equal(backlogAfterMove.some((task) => task.key === high.key), false));
  check('the item appears in the sprint To Do column', () => {
    const inSprint = sprintAfterMove.find((task) => task.key === high.key);
    assert.ok(inSprint);
    assert.equal(inSprint.status, 'todo');
  });
  check('a task never appears in both lists', () => {
    const overlap = backlogAfterMove.filter((task) => sprintAfterMove.some((inner) => inner.key === task.key));
    assert.deepEqual(overlap, []);
  });

  const duplicate = await api(`/sprints/${activeSprint.id}/tasks`, { method: 'POST', body: JSON.stringify({ key: high.key }) });
  check('duplicate sprint assignment is rejected with 409', () => assert.equal(duplicate.status, 409));

  const toProgress = await api(`/tasks/${high.key}`, { method: 'PATCH', body: JSON.stringify({ status: 'progress' }) });
  check('To Do -> In Progress is accepted', () => assert.equal(toProgress.status, 200));

  const skipToDone = await api(`/tasks/${high.key}`, { method: 'PATCH', body: JSON.stringify({ status: 'done' }) });
  check('skipping Review and jumping to Done is rejected with 409', () => assert.equal(skipToDone.status, 409));

  const earlyReturn = await api(`/sprints/${activeSprint.id}/tasks/${high.key}`, { method: 'DELETE' });
  check('a non-To Do task cannot return to the Product Backlog', () => assert.equal(earlyReturn.status, 409));

  const toReview = await api(`/tasks/${high.key}`, { method: 'PATCH', body: JSON.stringify({ status: 'review' }) });
  check('In Progress -> Review is accepted', () => assert.equal(toReview.status, 200));
  const backToProgress = await api(`/tasks/${high.key}`, { method: 'PATCH', body: JSON.stringify({ status: 'progress' }) });
  check('Review -> In Progress is accepted', () => assert.equal(backToProgress.status, 200));
  const reviewAgain = await api(`/tasks/${high.key}`, { method: 'PATCH', body: JSON.stringify({ status: 'review' }) });
  check('In Progress -> Review is repeatable after a rework loop', () => assert.equal(reviewAgain.status, 200));
  const toDone = await api(`/tasks/${high.key}`, { method: 'PATCH', body: JSON.stringify({ status: 'done' }) });
  check('Review -> Done is accepted', () => assert.equal(toDone.status, 200));

  const doneSprint = await api(`/sprints/${activeSprint.id}`);
  check('completed work rolls up into sprint progress', () => assert.equal(doneSprint.body.progress.completedStoryPoints >= 3, true));

  const returnable = await api(`/sprints/${activeSprint.id}/tasks`, { method: 'POST', body: JSON.stringify({ key: urgent.key }) });
  check('a second item can enter the sprint', () => assert.equal(returnable.status, 201));
  const returned = await api(`/sprints/${activeSprint.id}/tasks/${urgent.key}`, { method: 'DELETE' });
  check('To Do -> Product Backlog returns 200', () => assert.equal(returned.status, 200));
  const { body: backlogRestored } = await api(`/backlog${boardScope}`);
  const { body: sprintRestored } = await api(`/sprints/${activeSprint.id}/tasks`);
  check('returning preserves the task and clears its sprint assignment', () => {
    const restored = backlogRestored.find((task) => task.key === urgent.key);
    assert.ok(restored, 'task was deleted instead of returned');
    assert.equal(restored.sprintId ?? null, null);
    assert.equal(restored.status, 'backlog');
  });
  check('returned task leaves the sprint list', () => assert.equal(sprintRestored.some((task) => task.key === urgent.key), false));

  const upcoming = await api('/sprints', { method: 'POST', body: JSON.stringify({ name: 'Future sprint', startDate: '2030-01-06', boardId }) });
  check('an upcoming sprint is created', () => assert.equal(upcoming.body.current.state, 'upcoming'));
  const intoFuture = await api(`/sprints/${upcoming.body.id}/tasks`, { method: 'POST', body: JSON.stringify({ key: medium.key }) });
  check('an inactive sprint cannot accept backlog items', () => assert.equal(intoFuture.status, 409));
  const { body: backlogAfterFuture } = await api(`/backlog${boardScope}`);
  check('the item stays in the Product Backlog when no active sprint applies', () => {
    assert.equal(backlogAfterFuture.some((task) => task.key === medium.key), true);
  });

  const otherEmail = `backlog-other-${Date.now()}@example.com`;
  await api('/auth/signup', { method: 'POST', body: JSON.stringify({ name: 'Other Tester', email: otherEmail, password: 'Password123!' }) });
  const otherSignedIn = await api('/auth/signin', { method: 'POST', body: JSON.stringify({ email: otherEmail, password: 'Password123!' }) });
  const { body: otherBoards } = await api('/boards', {}, otherSignedIn.body.token);
  const otherBoardId = otherBoards[0].id;
  const { body: otherSprints } = await api(`/sprints?boardId=${encodeURIComponent(otherBoardId)}`, {}, otherSignedIn.body.token);
  check('sprint lists are owner-scoped and start empty', () => assert.deepEqual(otherSprints, []));
  const otherSprint = await api('/sprints', {
    method: 'POST',
    body: JSON.stringify({ name: 'Other Sprint', startDate: todayIsoDate(), boardId: otherBoardId })
  }, otherSignedIn.body.token);
  const intrusion = await api(`/sprints/${otherSprint.body.id}/tasks`, { method: 'POST', body: JSON.stringify({ key: low.key }) });
  check('another project\'s sprint cannot receive the task', () => assert.equal(intrusion.status, 403));

  const bypass = await api(`/tasks/${low.key}`, { method: 'PATCH', body: JSON.stringify({ sprintId: activeSprint.id }) });
  check('sprint assignment cannot be bypassed through a generic task edit', () => assert.equal(bypass.status, 409));

  const { body: allTasks } = await api('/tasks');
  check('existing board endpoint still returns every task', () => assert.ok(allTasks.length >= 9));
  check('moves never delete task records', () => {
    for (const task of [urgent, high, medium, low, lowTwin]) {
      assert.ok(allTasks.some((item) => item.key === task.key), `${task.key} was deleted`);
    }
  });

  const invalid = await api('/tasks', { method: 'POST', body: JSON.stringify({ title: 'Bad priority', priority: 'blocker' }) });
  check('invalid priority values are rejected with 400', () => assert.equal(invalid.status, 400));

  const defaultEstimate = await api('/tasks', { method: 'POST', body: JSON.stringify({ title: 'Default estimate task' }) });
  check('new tasks without story points default to zero', () => {
    assert.equal(defaultEstimate.status, 201);
    assert.equal(defaultEstimate.body.storyPoints, 0);
  });
  const legacyEstimate = await api('/tasks', { method: 'POST', body: JSON.stringify({ title: 'Existing scale estimate task', storyPoints: 4 }) });
  const badEstimate = await api('/tasks', { method: 'POST', body: JSON.stringify({ title: 'Out of range estimate task', storyPoints: 101 }) });
  const fractionalEstimate = await api('/tasks', { method: 'POST', body: JSON.stringify({ title: 'Fractional estimate task', storyPoints: 2.5 }) });
  check('existing numeric estimates stay compatible while unsafe values are rejected', () => {
    assert.equal(legacyEstimate.status, 201);
    assert.equal(legacyEstimate.body.storyPoints, 4);
    assert.equal(badEstimate.status, 400);
    assert.equal(fractionalEstimate.status, 400);
  });
  const updatedEstimate = await api(`/tasks/${high.key}`, { method: 'PATCH', body: JSON.stringify({ storyPoints: 13 }) });
  check('manual task edits persist Fibonacci story points', () => {
    assert.equal(updatedEstimate.status, 200);
    assert.equal(updatedEstimate.body.storyPoints, 13);
  });

  console.log(`\n${passed} backlog checks passed.`);
} finally {
  server.kill();
}
