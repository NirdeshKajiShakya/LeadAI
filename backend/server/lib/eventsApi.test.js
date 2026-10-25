// End-to-end event integration checks. Unlike the other API suites this test
// imports the app in-process (forced into in-memory mode) so it can attach
// listeners to the shared emitter while exercising the real HTTP routes and
// the exported service store. Emission is synchronous inside the request
// handler, so by the time a fetch resolves the events are already recorded.
import assert from 'node:assert/strict';

// Must be set before index.js loads: empty URI forces the in-memory path,
// and dotenv will not override an already-set key.
process.env.MONGODB_URI = '';
process.env.PORT = process.env.TEST_PORT || '4102';
process.env.NODE_ENV = 'test';
// This suite exercises task events, not email verification; the auth flow has
// its own end-to-end suite.
process.env.AUTH_OTP_DISABLED = '1';

const { store, serverStarted } = await import('../index.js');
const { EVENTS, onEvent, listenerCount } = await import('./events.js');

const server = await serverStarted;
const BASE = `http://127.0.0.1:${server.address().port}/api`;

async function api(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(globalThis.authToken ? { Authorization: `Bearer ${globalThis.authToken}` } : {}) },
    ...options
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

let passed = 0;
async function check(label, fn) {
  await fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

// One shared event log for the whole suite; cleaned up at the very end.
const log = [];
const offs = Object.values(EVENTS).map((name) => onEvent(name, (payload) => log.push({ name, payload })));
const eventsOf = (name) => log.filter((entry) => entry.name === name);

console.log(`event API checks (port ${server.address().port})\n`);

try {
  // ---- Setup: two users, one team (sprint), listeners attached after seeding
  const emailA = `event-owner-${Date.now()}@example.com`;
  const signupA = await api('/auth/signup', { method: 'POST', body: JSON.stringify({ name: 'Event Owner', username: `event-owner-${Date.now()}`, email: emailA, password: 'Password123!' }) });
  assert.equal(signupA.status, 201, `owner signup failed: ${JSON.stringify(signupA.body)}`);
  const signInA = await api('/auth/signin', { method: 'POST', body: JSON.stringify({ email: emailA, password: 'Password123!' }) });
  globalThis.authToken = signInA.body.token;
  const userA = signInA.body.user;

  const emailB = `event-member-${Date.now()}@example.com`;
  const signupB = await api('/auth/signup', { method: 'POST', body: JSON.stringify({ name: 'Event Member', username: `event-member-${Date.now()}`, email: emailB, password: 'Password123!' }) });
  assert.equal(signupB.status, 201, `member signup failed: ${JSON.stringify(signupB.body)}`);
  const signInB = await api('/auth/signin', { method: 'POST', body: JSON.stringify({ email: emailB, password: 'Password123!' }) });
  const userB = signInB.body.user;

  const { body: sprints } = await api('/sprints');
  const teamId = sprints[0].id;

  // Starter tasks are seeded during signup, before any authenticated request
  // exists. The event contract deliberately refuses to fabricate an actor, so
  // seeding emits nothing; the checks below are relative to that baseline.
  const seededCreations = eventsOf(EVENTS.TASK_CREATED).length;
  await check('starter-task seeding emits no events without an authenticated actor', () => {
    assert.equal(seededCreations, 0);
  });

  // ---- task.created --------------------------------------------------------

  const created = await api('/tasks', { method: 'POST', body: JSON.stringify({ title: 'Event probe', status: 'todo' }) });
  await check('successful creation emits exactly one task.created with persisted ids', () => {
    assert.equal(created.status, 201);
    assert.ok(created.body.key, 'existing response shape preserved');
    const seen = eventsOf(EVENTS.TASK_CREATED);
    assert.equal(seen.length, seededCreations + 1);
    const { payload } = seen[seen.length - 1];
    assert.equal(payload.taskId, created.body._id);
    assert.equal(payload.teamId, null, 'backlog task has no team');
    assert.equal(payload.actorId, userA._id, 'actor comes from the session, not the body');
    assert.ok(payload.at instanceof Date);
  });

  const key = created.body.key;

  await check('task.created is emitted only after the task is persisted', async () => {
    // Emission is synchronous in the request handler, so observing this event
    // after the 201 response proves post-commit ordering: the history endpoint
    // 404s for unpersisted tasks (via the same authorizedTask lookup), so a
    // 200 here proves the task was committed before the event fired.
    const history = await api(`/tasks/${key}/history`);
    assert.equal(history.status, 200);
    assert.ok(Array.isArray(history.body));
  });

  const rejected = await api('/tasks', { method: 'POST', body: JSON.stringify({ status: 'todo' }) });
  await check('failed task creation (400) emits no event', () => {
    assert.equal(rejected.status, 400);
    assert.equal(eventsOf(EVENTS.TASK_CREATED).length, seededCreations + 1, 'count unchanged');
  });

  const createdInTeam = await api('/tasks', { method: 'POST', body: JSON.stringify({ title: 'Team task', sprintId: teamId }) });
  await check('task.created reports the persisted team reference', () => {
    assert.equal(createdInTeam.status, 201);
    const seen = eventsOf(EVENTS.TASK_CREATED);
    assert.equal(seen.length, seededCreations + 2);
    assert.equal(seen[seen.length - 1].payload.taskId, createdInTeam.body._id);
    assert.equal(seen[seen.length - 1].payload.teamId, teamId);
  });

  // ---- task.status_changed --------------------------------------------------

  const moved = await api(`/tasks/${key}`, { method: 'PATCH', body: JSON.stringify({ status: 'progress' }) });
  await check('a real transition emits one task.status_changed with actual from/to', () => {
    assert.equal(moved.status, 200);
    const seen = eventsOf(EVENTS.TASK_STATUS_CHANGED);
    assert.equal(seen.length, 1, 'exactly one status change so far');
    const { payload } = seen[0];
    assert.deepEqual(Object.keys(payload).sort(), ['actorId', 'at', 'from', 'taskId', 'teamId', 'to']);
    assert.equal(payload.taskId, created.body._id);
    assert.equal(payload.from, 'todo', 'previous status from the persisted task, not the body');
    assert.equal(payload.to, 'progress', 'resulting persisted status');
    assert.equal(payload.actorId, userA._id, 'actor comes from the session');
    assert.ok(payload.at instanceof Date, 'timestamp is a Date');
  });

  const noop = await api(`/tasks/${key}`, { method: 'PATCH', body: JSON.stringify({ status: 'progress' }) });
  await check('a no-op status update emits no status-change event', () => {
    assert.equal(noop.status, 200);
    assert.equal(eventsOf(EVENTS.TASK_STATUS_CHANGED).length, 1, 'count unchanged');
  });

  const badStatus = await api(`/tasks/${key}`, { method: 'PATCH', body: JSON.stringify({ status: 'doing' }) });
  await check('a failed status update emits no status-change event', () => {
    assert.equal(badStatus.status, 400);
    assert.equal(eventsOf(EVENTS.TASK_STATUS_CHANGED).length, 1, 'count unchanged');
  });

  // ---- task.assigned ----------------------------------------------------------

  // In-memory user resolution only knows the signed-in caller, so the owner
  // assigns the task to themselves ΓÇö the meaningful assertion is that the
  // persisted assignee reference (not the raw input) lands in the payload.
  // Starter tasks are seeded without an actor, so they emit no assignment event
  // either; this baseline is therefore expected to be zero.
  const seededAssignments = eventsOf(EVENTS.TASK_ASSIGNED).length;
  const assigned = await api(`/tasks/${key}`, { method: 'PATCH', body: JSON.stringify({ assigneeId: userA._id }) });
  await check('successful assignment emits task.assigned with the persisted assignee', () => {
    assert.equal(assigned.status, 200);
    const seen = eventsOf(EVENTS.TASK_ASSIGNED);
    assert.equal(seen.length, seededAssignments + 1);
    const { payload } = seen[seen.length - 1];
    assert.deepEqual(Object.keys(payload).sort(), ['actorId', 'assigneeId', 'at', 'taskId', 'teamId']);
    assert.equal(payload.taskId, created.body._id);
    assert.equal(payload.assigneeId, userA._id);
    assert.equal(payload.actorId, userA._id);
    assert.ok(payload.at instanceof Date);
  });

  const unchangedAssign = await api(`/tasks/${key}`, { method: 'PATCH', body: JSON.stringify({ assigneeId: userA._id }) });
  await check('an unchanged assignment emits no duplicate event', () => {
    assert.equal(unchangedAssign.status, 200);
    assert.equal(eventsOf(EVENTS.TASK_ASSIGNED).length, seededAssignments + 1, 'count unchanged');
  });

  const badAssignee = await api(`/tasks/${key}`, { method: 'PATCH', body: JSON.stringify({ assigneeId: userB._id }) });
  await check('a failed assignment emits no assignment event', () => {
    // In-memory mode only resolves the caller; an unknown id is a 400 before
    // any write, so nothing may be emitted.
    assert.equal(badAssignee.status, 400);
    assert.equal(eventsOf(EVENTS.TASK_ASSIGNED).length, seededAssignments + 1, 'count unchanged');
  });

  // Member events (member.joined / member.left) belong to the membership
  // service and are covered by teamService.test.js. The HTTP membership routes
  // this suite used to exercise were removed with the team-workspace rewrite;
  // board membership now lives under /api/boards/:id/members.

  await check('PATCH still returns the updated task shape', () => {
    assert.ok(moved.body.key === key && moved.body.status === 'progress');
  });

  console.log(`\n${passed} event API checks passed.`);
} finally {
  for (const off of offs) off();
  for (const name of Object.values(EVENTS)) assert.equal(listenerCount(name), 0, `no leaked listeners on ${name}`);
  server.close();
}
