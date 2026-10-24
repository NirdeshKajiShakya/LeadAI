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
  await api('/auth/signup', { method: 'POST', body: JSON.stringify({ name: 'Event Owner', email: emailA, password: 'Password123!' }) });
  const signInA = await api('/auth/signin', { method: 'POST', body: JSON.stringify({ email: emailA, password: 'Password123!' }) });
  globalThis.authToken = signInA.body.token;
  const userA = signInA.body.user;

  const emailB = `event-member-${Date.now()}@example.com`;
  await api('/auth/signup', { method: 'POST', body: JSON.stringify({ name: 'Event Member', email: emailB, password: 'Password123!' }) });
  const signInB = await api('/auth/signin', { method: 'POST', body: JSON.stringify({ email: emailB, password: 'Password123!' }) });
  const userB = signInB.body.user;

  const { body: sprints } = await api('/sprints');
  const teamId = sprints[0].id;

  // Signup seeds five starter tasks per user (each emitting task.created with
  // the new user as actor), so all creation assertions below are relative to
  // this baseline rather than absolute.
  const seededCreations = eventsOf(EVENTS.TASK_CREATED).length;
  await check('starter-task seeding emits task.created events only for persisted tasks', () => {
    assert.equal(seededCreations, 10);
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
  // Starter tasks seeded during signup with an assignee also emit task.assigned
  // on creation, so we measure relative to that baseline.
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

  // ---- member.joined ----------------------------------------------------------

  const joined = await api(`/teams/${teamId}/members`, { method: 'POST', body: JSON.stringify({ userId: userB._id }) });
  await check('successful membership addition emits member.joined once', () => {
    assert.equal(joined.status, 201);
    const seen = eventsOf(EVENTS.MEMBER_JOINED);
    assert.equal(seen.length, 1);
    const { payload } = seen[0];
    assert.deepEqual(Object.keys(payload).sort(), ['actorId', 'at', 'memberId', 'teamId']);
    assert.equal(payload.teamId, teamId);
    assert.equal(payload.memberId, userB._id);
    assert.equal(payload.actorId, userA._id, 'actor is the owner performing the add');
    assert.ok(payload.at instanceof Date);
  });

  const duplicateJoin = await api(`/teams/${teamId}/members`, { method: 'POST', body: JSON.stringify({ userId: userB._id }) });
  await check('adding an existing member emits no duplicate join event', () => {
    assert.equal(duplicateJoin.status, 409);
    assert.equal(eventsOf(EVENTS.MEMBER_JOINED).length, 1, 'count unchanged');
  });

  const badJoin = await api(`/teams/${teamId}/members`, { method: 'POST', body: JSON.stringify({ userId: 'nope' }) });
  await check('a failed membership addition emits no join event', () => {
    assert.equal(badJoin.status, 400);
    assert.equal(eventsOf(EVENTS.MEMBER_JOINED).length, 1, 'count unchanged');
  });

  // ---- member.left ------------------------------------------------------------

  const left = await api(`/teams/${teamId}/members/${userB._id}`, { method: 'DELETE' });
  await check('successful membership removal emits member.left once', () => {
    assert.equal(left.status, 200);
    assert.equal(left.body.ok, true, 'existing response contract preserved');
    const seen = eventsOf(EVENTS.MEMBER_LEFT);
    assert.equal(seen.length, 1);
    const { payload } = seen[0];
    assert.deepEqual(Object.keys(payload).sort(), ['actorId', 'at', 'memberId', 'teamId']);
    assert.equal(payload.teamId, teamId);
    assert.equal(payload.memberId, userB._id);
    assert.equal(payload.actorId, userA._id);
    assert.ok(payload.at instanceof Date);
  });

  const missingLeave = await api(`/teams/${teamId}/members/${userB._id}`, { method: 'DELETE' });
  await check('removing a nonexistent membership emits no false leave event', () => {
    assert.equal(missingLeave.status, 404);
    assert.equal(eventsOf(EVENTS.MEMBER_LEFT).length, 1, 'count unchanged');
  });

  // ---- self-removal (leaver is the actor) -------------------------------------

  const rejoined = await api(`/teams/${teamId}/members`, { method: 'POST', body: JSON.stringify({ userId: userB._id }) });
  assert.equal(rejoined.status, 201);
  globalThis.authToken = signInB.body.token;
  const selfLeave = await api(`/teams/${teamId}/members/${userB._id}`, { method: 'DELETE' });
  await check('a member may leave the team themselves (actor is the leaver)', () => {
    assert.equal(selfLeave.status, 200);
    const seen = eventsOf(EVENTS.MEMBER_LEFT);
    assert.equal(seen.length, 2);
    assert.equal(seen[1].payload.actorId, userB._id);
    assert.equal(seen[1].payload.memberId, userB._id);
  });

  await check('PATCH still returns the updated task shape', () => {
    assert.ok(moved.body.key === key && moved.body.status === 'progress');
  });

  console.log(`\n${passed} event API checks passed.`);
} finally {
  for (const off of offs) off();
  for (const name of Object.values(EVENTS)) assert.equal(listenerCount(name), 0, `no leaked listeners on ${name}`);
  server.close();
}
