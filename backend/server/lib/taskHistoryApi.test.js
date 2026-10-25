// End-to-end J1 (task history) + J2 (schema fields) API checks. Spawns the
// server on a scratch port with in-memory storage so it never touches the
// developer API on :4000, then tears the process down.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = process.env.TEST_PORT || 4101;
const BASE = `http://127.0.0.1:${PORT}/api`;

const server = spawn(process.execPath, ['server/index.js'], {
  env: { ...process.env, PORT: String(PORT), MONGODB_URI: '', ALLOW_MEMORY_DB: '1', AUTH_OTP_DISABLED: '1' },
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
  const response = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(globalThis.authToken ? { Authorization: `Bearer ${globalThis.authToken}` } : {}) },
    ...options
  });
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
  console.log(`task history + schema API checks (port ${PORT})\n`);

  const email = `history-${Date.now()}@example.com`;
  await api('/auth/signup', { method: 'POST', body: JSON.stringify({ name: 'History Tester', email, password: 'Password123!' }) });
  const signedIn = await api('/auth/signin', { method: 'POST', body: JSON.stringify({ email, password: 'Password123!' }) });
  globalThis.authToken = signedIn.body.token;
  const me = signedIn.body.user;

  // ---- J2: creation carries the new schema fields --------------------------
  const created = await api('/tasks', {
    method: 'POST',
    body: JSON.stringify({
      title: 'History probe', status: 'todo', priority: 'high', labels: ['J1'],
      assigneeId: me._id, dueDate: 'Today', estimateHours: 6.5
    })
  });
  check('creating a task returns 201', () => assert.equal(created.status, 201));
  check('assigneeId is persisted with a resolved display name', () => {
    assert.equal(created.body.assigneeId, me._id);
    assert.equal(created.body.assignee, 'History Tester');
  });
  check('dueDate "Today" converts to a real date', () => {
    assert.ok(created.body.dueDate, 'dueDate present');
    assert.ok(!Number.isNaN(Date.parse(created.body.dueDate)), 'dueDate parses');
  });
  const tomorrow = await api('/tasks', {
    method: 'POST',
    body: JSON.stringify({ title: 'Tomorrow task', dueDate: 'Tomorrow' })
  });
  check('creating with Tomorrow converts to a date-only value', () => {
    assert.match(tomorrow.body.dueDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(new Date(`${tomorrow.body.dueDate}T00:00:00Z`).getTime() - Date.parse(created.body.dueDate), 86400000);
  });
  const pickerDate = await api('/tasks', {
    method: 'POST',
    body: JSON.stringify({ title: 'Picker date', dueDate: '2026-11-05' })
  });
  check('creating with a date-picker value preserves the calendar date', () => assert.equal(pickerDate.body.dueDate, '2026-11-05'));
  check('estimateHours is persisted', () => assert.equal(created.body.estimateHours, 6.5));
  const key = created.body.key;
  const updatedDue = await api(`/tasks/${key}`, { method: 'PATCH', body: JSON.stringify({ dueDate: '2026-12-15' }) });
  check('updating a task deadline preserves the date-only value', () => assert.equal(updatedDue.body.dueDate, '2026-12-15'));
  const clearedDue = await api(`/tasks/${key}`, { method: 'PATCH', body: JSON.stringify({ dueDate: null }) });
  check('null clears an optional deadline', () => assert.equal(clearedDue.body.dueDate, null));

  // ---- J1: creation writes a history entry ---------------------------------
  const history0 = await api(`/tasks/${key}/history`);
  check('creation writes an initial history entry', () => {
    assert.equal(history0.status, 200);
    assert.equal(history0.body.length, 1);
    assert.equal(history0.body[0].from, null);
    assert.equal(history0.body[0].to, 'todo');
    assert.equal(history0.body[0].actorId, me._id);
  });

  // ---- J1/J2: status transitions through the centralized path --------------
  const toProgress = await api(`/tasks/${key}`, { method: 'PATCH', body: JSON.stringify({ status: 'progress' }) });
  check('status transition returns the updated task', () => assert.equal(toProgress.body.status, 'progress'));
  check('entering progress stamps startedAt', () => {
    assert.ok(toProgress.body.startedAt, 'startedAt set');
    assert.equal(toProgress.body.completedAt, null);
  });

  const history1 = await api(`/tasks/${key}/history`);
  check('transition appends a from/to history entry', () => {
    assert.equal(history1.body.length, 2);
    const last = history1.body[history1.body.length - 1];
    assert.equal(last.from, 'todo');
    assert.equal(last.to, 'progress');
    assert.equal(last.actorId, me._id);
  });

  const noop = await api(`/tasks/${key}`, { method: 'PATCH', body: JSON.stringify({ status: 'progress' }) });
  const historyNoop = await api(`/tasks/${key}/history`);
  check('setting the same status is a no-op for history', () => {
    assert.equal(noop.body.status, 'progress');
    assert.equal(historyNoop.body.length, 2, 'no duplicate entry');
  });

  const toDone = await api(`/tasks/${key}`, { method: 'PATCH', body: JSON.stringify({ status: 'done' }) });
  check('reaching done stamps completedAt', () => assert.ok(toDone.body.completedAt));

  const reopened = await api(`/tasks/${key}`, { method: 'PATCH', body: JSON.stringify({ status: 'progress' }) });
  check('reopening clears completedAt but keeps startedAt', () => {
    assert.equal(reopened.body.completedAt, null);
    assert.equal(reopened.body.startedAt, toProgress.body.startedAt);
  });

  const history2 = await api(`/tasks/${key}/history`);
  check('history stays chronological with every transition', () => {
    assert.equal(history2.body.length, 4);
    const times = history2.body.map((entry) => new Date(entry.at).getTime());
    assert.deepEqual([...times].sort((a, b) => a - b), times);
    assert.deepEqual(history2.body.map((entry) => entry.to), ['todo', 'progress', 'done', 'progress']);
  });

  // ---- J2: input validation ------------------------------------------------
  const badStatus = await api(`/tasks/${key}`, { method: 'PATCH', body: JSON.stringify({ status: 'doing' }) });
  check('unmapped status is rejected with 400', () => assert.equal(badStatus.status, 400));

  const badEstimate = await api(`/tasks/${key}`, { method: 'PATCH', body: JSON.stringify({ estimateHours: -5 }) });
  check('negative estimateHours is rejected with 400', () => assert.equal(badEstimate.status, 400));

  const hugeEstimate = await api('/tasks', { method: 'POST', body: JSON.stringify({ title: 'Too big', estimateHours: 5000 }) });
  check('estimateHours above 1000 is rejected with 400', () => assert.equal(hugeEstimate.status, 400));

  const badDue = await api(`/tasks/${key}`, { method: 'PATCH', body: JSON.stringify({ dueDate: 'whenever' }) });
  check('unparseable dueDate is rejected with 400', () => assert.equal(badDue.status, 400));

  const badAssignee = await api('/tasks', { method: 'POST', body: JSON.stringify({ title: 'Bad assignee', assigneeId: 'not-my-user-id-123' }) });
  check('foreign assigneeId is rejected with 400', () => assert.equal(badAssignee.status, 400));

  const malformedAssignee = await api(`/tasks/${key}`, { method: 'PATCH', body: JSON.stringify({ assigneeId: '!!' }) });
  check('malformed assigneeId is rejected with 400', () => assert.equal(malformedAssignee.status, 400));

  const unscheduled = await api('/tasks', { method: 'POST', body: JSON.stringify({ title: 'No date', dueDate: 'Unscheduled' }) });
  check('Unscheduled converts to a null dueDate', () => assert.equal(unscheduled.body.dueDate, null));

  const unassign = await api(`/tasks/${unscheduled.body.key}`, { method: 'PATCH', body: JSON.stringify({ assigneeId: null }) });
  check('explicit null assigneeId unassigns the task', () => {
    assert.equal(unassign.body.assigneeId, null);
    assert.equal(unassign.body.assignee, 'Unassigned');
  });

  // ---- J1: team-wide history ----------------------------------------------
  const { body: sprints } = await api('/sprints');
  const sprintId = sprints[0].id;
  const moved = await api(`/sprints/${sprintId}/tasks`, { method: 'POST', body: JSON.stringify({ key }) });
  check('moving the task into the sprint returns 201', () => assert.equal(moved.status, 201));

  const teamHistory = await api(`/teams/${sprintId}/history`);
  check('team history lists the member task transitions', () => {
    assert.equal(teamHistory.status, 200);
    assert.ok(teamHistory.body.length >= 4, 'transitions visible for the team');
    assert.ok(teamHistory.body.some((entry) => entry.to === 'progress'));
  });

  const badTeam = await api('/teams/short!/history');
  check('team history rejects a malformed team id', () => assert.equal(badTeam.status, 400));
  const unknownTeam = await api('/teams/notmyteam123456/history');
  check('team history 404s for a team the user does not own', () => assert.equal(unknownTeam.status, 404));

  // ---- J1: history is an audit trail --------------------------------------
  const cleared = await api(`/tasks/${key}/history`, { method: 'DELETE' });
  check('non-admin members cannot clear history', () => assert.equal(cleared.status, 403));
  const stillThere = await api(`/tasks/${key}/history`);
  check('history survives the rejected clear', () => assert.ok(stillThere.body.length >= 4));

  const migrate = await api('/admin/migrate-tasks', { method: 'POST' });
  check('non-admin members cannot run the migration', () => assert.equal(migrate.status, 403));

  console.log(`\n${passed} API checks passed.`);
} finally {
  server.kill();
}
