// End-to-end API checks for Sprint Backlog. Spawns the server on a scratch port so it
// never touches the developer API on :4000, then tears the process down.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { todayIsoDate } from './sprintDates.js';

const PORT = process.env.TEST_PORT || 4100;
const BASE = `http://127.0.0.1:${PORT}/api`;

const server = spawn(process.execPath, ['server/index.js'], {
  env: { ...process.env, PORT: String(PORT), MONGODB_URI: '', ALLOW_MEMORY_DB: '1', OPENROUTER_API_KEY: '' },
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

async function signup(label) {
  const email = `sprint-${label}-${Date.now()}@example.com`;
  const response = await api('/auth/signup', {
    method: 'POST',
    body: JSON.stringify({ name: `Sprint ${label}`, email, password: 'Password123!' })
  });
  assert.equal(response.status, 201);
  const signedIn = await api('/auth/signin', {
    method: 'POST',
    body: JSON.stringify({ email, password: 'Password123!' })
  });
  assert.equal(signedIn.status, 200);
  return { email, token: signedIn.body.token };
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
  const { body: boards } = await api('/boards');
  const boardId = boards[0].id;
  const boardScope = `?boardId=${encodeURIComponent(boardId)}`;

  const { body: noSprints } = await api(`/sprints${boardScope}`);
  check('reading the sprint list does not create placeholder sprints', () => assert.deepEqual(noSprints, []));
  const missingBoardScope = await api('/sprints');
  check('sprint listing requires an explicit board scope', () => assert.equal(missingBoardScope.status, 400));
  const unavailableAi = await api('/ai/sprints', {
    method: 'POST',
    body: JSON.stringify({ goal: 'Plan a sprint for backend refactoring' })
  });
  check('AI sprint generation reports a missing provider without creating a sprint', () => {
    assert.equal(unavailableAi.status, 503);
    assert.equal(unavailableAi.body.code, 'AI_NOT_CONFIGURED');
  });
  const { body: stillEmpty } = await api(`/sprints${boardScope}`);
  check('the failed AI generation leaves the sprint list empty', () => assert.deepEqual(stillEmpty, []));

  const createdActive = await api('/sprints', {
    method: 'POST',
    body: JSON.stringify({ name: 'Sprint 1', goal: 'Ship the first product increment', startDate: todayIsoDate(), boardId })
  });
  check('a sprint can be created explicitly with a string id', () => {
    assert.equal(createdActive.status, 201);
    assert.equal(typeof createdActive.body.id, 'string');
    assert.notEqual(createdActive.body.id, '[object Object]');
  });
  check('created sprint runs 14 calendar days', () => assert.equal(createdActive.body.durationDays, 14));
  check('sprint day is computed from persisted dates', () => {
    assert.equal(createdActive.body.current.total, 14);
    assert.equal(createdActive.body.current.day, 1);
    assert.equal(createdActive.body.current.state, 'active');
  });
  check('sprint exposes a persisted goal', () => assert.equal(createdActive.body.goal, 'Ship the first product increment'));

  const sprintId = createdActive.body.id;
  const { body: backlogBefore } = await api(`/backlog${boardScope}`);
  const { body: sprintTasksBefore } = await api(`/sprints/${sprintId}/tasks${boardScope}`);
  check('every task is in exactly one backlog list', () => {
    assert.equal(backlogBefore.length + sprintTasksBefore.length, 5);
  });

  const task = backlogBefore[0];
  const moved = await api(`/sprints/${sprintId}/tasks`, { method: 'POST', body: JSON.stringify({ key: task.key }) });
  check('moving a task to the sprint returns 201', () => assert.equal(moved.status, 201));

  const { body: backlogAfter } = await api(`/backlog${boardScope}`);
  const { body: sprintTasksAfter } = await api(`/sprints/${sprintId}/tasks${boardScope}`);
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
  const estimated = await api(`/tasks/${task.key}`, { method: 'PATCH', body: JSON.stringify({ storyPoints: 5, status: 'progress' }) });
  const liveProgress = await api(`/sprints/${sprintId}`);
  check('editing story points immediately updates sprint commitment metrics', () => {
    assert.equal(estimated.body.storyPoints, 5);
    assert.equal(liveProgress.body.progress.totalStoryPoints, 5);
    assert.equal(liveProgress.body.progress.completedStoryPoints, 0);
    assert.equal(liveProgress.body.progress.remainingStoryPoints, 5);
    assert.equal(liveProgress.body.progress.progressPercent, 0);
  });
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
  const { body: backlogRestored } = await api(`/backlog${boardScope}`);
  const { body: sprintTasksRestored } = await api(`/sprints/${sprintId}/tasks${boardScope}`);
  check('removed task is back in the product backlog', () => {
    assert.equal(backlogRestored.some((t) => t.key === returnable.key), true);
    assert.equal(sprintTasksRestored.some((t) => t.key === returnable.key), false);
  });
  const { body: afterRemove } = await api(`/sprints/${sprintId}`);
  check('progress reflects the completed work that stayed in the sprint', () => assert.equal(afterRemove.progress.progressPercent, 100));

  const created = await api('/sprints', { method: 'POST', body: JSON.stringify({ name: 'Sprint 15', goal: 'Lifecycle', startDate: '2026-11-02', boardId }) });
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
  const customRange = await api(`/sprints/${created.body.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ startDate: '2026-11-02', endDate: '2026-11-08' })
  });
  check('sprint dates can be edited to a custom valid range', () => {
    assert.equal(customRange.status, 200);
    assert.equal(customRange.body.durationDays, 7);
    assert.equal(customRange.body.current.total, 7);
  });

  const { body: both } = await api(`/sprints?boardId=${encodeURIComponent(boardId)}`);
  check('multiple sprints are selectable', () => assert.equal(both.length, 2));

  const secondBoard = await api('/boards', { method: 'POST', body: JSON.stringify({ name: 'Second Project' }) });
  const otherBoardTask = await api('/tasks', {
    method: 'POST',
    body: JSON.stringify({ title: 'Task on first board', boardId, status: 'backlog' })
  });
  const secondBoardSprint = await api('/sprints', {
    method: 'POST',
    body: JSON.stringify({ name: 'Second Board Sprint', startDate: todayIsoDate(), boardId: secondBoard.body.id })
  });
  const { body: secondBoardSprints } = await api(`/sprints?boardId=${encodeURIComponent(secondBoard.body.id)}`);
  check('sprint selector data is isolated to the requested board', () => {
    assert.equal(secondBoardSprint.status, 201);
    assert.deepEqual(secondBoardSprints.map((sprint) => sprint.id), [secondBoardSprint.body.id]);
  });
  const wrongBoardMove = await api(`/sprints/${secondBoardSprint.body.id}/tasks?boardId=${encodeURIComponent(secondBoard.body.id)}`, {
    method: 'POST',
    body: JSON.stringify({ key: otherBoardTask.body.key })
  });
  check('tasks cannot be moved into another board sprint', () => assert.equal(wrongBoardMove.status, 409));
  const { body: secondBoardBacklog } = await api(`/backlog?boardId=${encodeURIComponent(secondBoard.body.id)}`);
  check('product backlog data is isolated to the requested board', () => assert.deepEqual(secondBoardBacklog, []));
  const missingBoardSprint = await api('/sprints', {
    method: 'POST',
    body: JSON.stringify({ name: 'Unscoped Sprint', startDate: todayIsoDate() })
  });
  check('sprint creation requires an explicit board', () => assert.equal(missingBoardSprint.status, 400));
  const missingBacklogBoard = await api('/backlog');
  check('product backlog listing requires an explicit board', () => assert.equal(missingBacklogBoard.status, 400));

  const teammate = await signup('Teammate');
  const ownerToken = globalThis.authToken;
  const sharedBoard = await api(`/boards/${boardId}/members`, {
    method: 'POST',
    body: JSON.stringify({ email: teammate.email })
  });
  check('board owner can invite a teammate', () => assert.equal(sharedBoard.status, 201));
  globalThis.authToken = teammate.token;
  const { body: notifications } = await api('/notifications');
  const invitation = notifications.notifications.find((item) => item.type === 'board_invite');
  const accepted = await api('/boards/invite/respond', {
    method: 'POST',
    body: JSON.stringify({ notificationId: invitation.id, action: 'accept' })
  });
  check('teammate accepts the board invitation', () => assert.equal(accepted.status, 200));
  const { body: teammateSprints } = await api(`/sprints${boardScope}`);
  check('sprints are visible to every member of their board', () => {
    assert.equal(teammateSprints.length, 2);
    assert.ok(teammateSprints.every((sprint) => sprint.boardId === boardId));
  });
  const { body: teammateBacklog } = await api(`/backlog${boardScope}`);
  check('shared board backlog includes tasks created by the board owner', () => {
    assert.ok(teammateBacklog.length > 0);
    assert.ok(teammateBacklog.every((item) => item.boardId === boardId));
  });
  const teammateMove = await api(`/sprints/${sprintId}/tasks${boardScope}`, {
    method: 'POST',
    body: JSON.stringify({ key: teammateBacklog[0].key })
  });
  check('a board member can add another member’s backlog task to a board sprint', () => assert.equal(teammateMove.status, 201));
  globalThis.authToken = ownerToken;
  const { body: ownerSprintTasks } = await api(`/sprints/${sprintId}/tasks${boardScope}`);
  check('sprint tasks are shared with all board members', () => {
    assert.ok(ownerSprintTasks.some((task) => task.key === teammateBacklog[0].key));
  });
  const teammateTaskReturn = await api(`/sprints/${sprintId}/tasks/${teammateBacklog[0].key}${boardScope}`, { method: 'DELETE' });
  check('the board owner can return a shared sprint task to the Product Backlog', () => assert.equal(teammateTaskReturn.status, 200));
  globalThis.authToken = teammate.token;
  const teammateSprint = await api('/sprints', {
    method: 'POST',
    body: JSON.stringify({ name: 'Teammate Sprint', goal: 'Shared board planning', boardId })
  });
  check('a board member can create a sprint on the shared board', () => assert.equal(teammateSprint.status, 201));
  globalThis.authToken = ownerToken;
  const { body: ownerSprintsAfterInvite } = await api(`/sprints${boardScope}`);
  check('the board owner sees sprints created by another board member', () => {
    assert.ok(ownerSprintsAfterInvite.some((sprint) => sprint.id === teammateSprint.body.id));
  });

  const rejections = [
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
  const { status: missingTask } = await api(`/sprints/${sprintId}/tasks`, { method: 'POST', body: JSON.stringify({ key: `KAN-MISSING-${Date.now()}` }) });
  check('rejects unknown task key', () => assert.equal(missingTask, 404));

  const { body: emptySprint } = await api(`/sprints/${created.body.id}`);
  check('empty sprint reports 0% without dividing by zero', () => assert.equal(emptySprint.progress.progressPercent, 0));

  const { body: boardTasks } = await api('/tasks');
  check('existing board endpoint still returns all tasks', () => assert.equal(boardTasks.length, 6));

  console.log(`\n${passed} API checks passed.`);
} finally {
  server.kill();
}