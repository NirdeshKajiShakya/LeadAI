// Unit checks for the J1 task status service helpers. `applyStatusLifecycle`
// is the shared, database-free core used by both the Mongo and in-memory
// storage paths, so it can be tested without a running server. The event
// emission helpers are database-free too: they build payloads from a
// task-like object and push them through the shared emitter.
import assert from 'node:assert/strict';
import {
  ALLOWED_STATUSES_LIST, STATUS_CATEGORIES, STATUS_CATEGORY_MAP,
  applyStatusLifecycle, isInProgressStatus, isDoneStatus, isTaskStatusRecord,
  emitTaskCreated, emitTaskStatusChanged, emitTaskAssigned
} from './taskService.js';
import { EVENTS, EventValidationError, onEvent, listenerCount } from './events.js';

let passed = 0;
function check(label, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

console.log('task service checks\n');

check('canonical status list matches the J2 statuses', () => {
  assert.deepEqual([...ALLOWED_STATUSES_LIST], ['backlog', 'todo', 'progress', 'review', 'done']);
  assert.ok(Object.isFrozen(ALLOWED_STATUSES_LIST));
});

check('status category map covers exactly the allowed statuses', () => {
  assert.deepEqual(Object.keys(STATUS_CATEGORY_MAP).sort(), [...ALLOWED_STATUSES_LIST].sort());
  const valid = new Set(Object.values(STATUS_CATEGORIES));
  for (const category of Object.values(STATUS_CATEGORY_MAP)) assert.ok(valid.has(category));
});

check('progress and review count as in-progress; done as done', () => {
  assert.equal(isInProgressStatus('progress'), true);
  assert.equal(isInProgressStatus('review'), true);
  assert.equal(isInProgressStatus('backlog'), false);
  assert.equal(isDoneStatus('done'), true);
  assert.equal(isDoneStatus('review'), false);
});

check('entering an in-progress status stamps startedAt once', () => {
  const task = { status: 'todo', startedAt: null, completedAt: null, updatedAt: null };
  const first = new Date('2026-10-19T10:00:00Z');
  applyStatusLifecycle(task, 'progress', first);
  assert.equal(task.startedAt.getTime(), first.getTime());

  const later = new Date('2026-10-20T10:00:00Z');
  applyStatusLifecycle(task, 'review', later);
  // startedAt must never be overwritten once set.
  assert.equal(task.startedAt.getTime(), first.getTime());
  assert.equal(task.status, 'review');
  assert.equal(task.updatedAt.getTime(), later.getTime());
});

check('reaching done stamps completedAt; reopening clears it', () => {
  const task = { status: 'progress', startedAt: null, completedAt: null, updatedAt: null };
  applyStatusLifecycle(task, 'progress', new Date('2026-10-19T10:00:00Z'));
  const doneAt = new Date('2026-10-21T10:00:00Z');
  applyStatusLifecycle(task, 'done', doneAt);
  assert.equal(task.completedAt.getTime(), doneAt.getTime());

  applyStatusLifecycle(task, 'todo', new Date('2026-10-22T10:00:00Z'));
  assert.equal(task.completedAt, null);
  assert.ok(task.startedAt, 'startedAt survives a reopen');
});

check('a task born in progress/done gets lifecycle timestamps on creation', () => {
  const born = { status: 'backlog', startedAt: null, completedAt: null };
  const now = new Date('2026-10-19T09:00:00Z');
  applyStatusLifecycle(born, 'done', now);
  assert.equal(born.completedAt.getTime(), now.getTime());
  assert.equal(born.startedAt, null);
});

check('isTaskStatusRecord reflects the current status', () => {
  assert.equal(isTaskStatusRecord({ status: 'done' }, 'done'), true);
  assert.equal(isTaskStatusRecord({ status: 'done' }, 'progress'), false);
});

// ---- Event emission helpers -------------------------------------------------
// Each helper emits exactly one validated event built from the persisted
// task-like object, and stays silent when the operation has no actor or no
// meaningful change (unassignment / unchanged assignee).

function capture(eventName, fn) {
  const seen = [];
  const off = onEvent(eventName, (payload) => seen.push(payload));
  try { fn(); } finally { off(); }
  return seen;
}

check('emitTaskCreated emits one validated task.created event', () => {
  const task = { _id: 'task-id-000001', sprintId: null };
  const at = new Date('2026-10-20T10:00:00Z');
  const seen = capture(EVENTS.TASK_CREATED, () => emitTaskCreated({ task, actorId: 'actor-id-000001', teamId: null, at }));
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], { taskId: 'task-id-000001', teamId: null, actorId: 'actor-id-000001', at });
});

check('emitTaskCreated stays silent without an actor', () => {
  const seen = capture(EVENTS.TASK_CREATED, () => emitTaskCreated({ task: { _id: 'task-id-000001' }, actorId: null, teamId: null, at: new Date() }));
  assert.equal(seen.length, 0);
});

check('emitTaskStatusChanged reports the actual persisted from/to', () => {
  const task = { _id: 'task-id-000001', sprintId: 'team-id-000001', status: 'progress' };
  const at = new Date('2026-10-20T10:05:00Z');
  const seen = capture(EVENTS.TASK_STATUS_CHANGED, () => emitTaskStatusChanged({ task, from: 'todo', to: 'progress', actorId: 'actor-id-000001', teamId: 'team-id-000001', at }));
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], { taskId: 'task-id-000001', teamId: 'team-id-000001', actorId: 'actor-id-000001', from: 'todo', to: 'progress', at });
});

check('emitTaskStatusChanged rejects invalid statuses before notifying listeners', () => {
  const task = { _id: 'task-id-000001', sprintId: null, status: 'doing' };
  assert.throws(
    () => emitTaskStatusChanged({ task, from: 'todo', to: 'doing', actorId: 'actor-id-000001', teamId: null, at: new Date() }),
    EventValidationError
  );
});

check('emitTaskAssigned emits for a new assignee reference', () => {
  const task = { _id: 'task-id-000001', sprintId: null, assigneeId: 'user-id-000001' };
  const at = new Date('2026-10-20T10:10:00Z');
  const seen = capture(EVENTS.TASK_ASSIGNED, () => emitTaskAssigned({ task, previousAssigneeId: null, actorId: 'actor-id-000001', at }));
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], { taskId: 'task-id-000001', teamId: null, actorId: 'actor-id-000001', assigneeId: 'user-id-000001', at });
});

check('emitTaskAssigned reports the persisted new assignee on reassignment', () => {
  const task = { _id: 'task-id-000001', sprintId: 'team-id-000001', assigneeId: 'user-id-000002' };
  const seen = capture(EVENTS.TASK_ASSIGNED, () => emitTaskAssigned({ task, previousAssigneeId: 'user-id-000001', actorId: 'actor-id-000001', at: new Date() }));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].assigneeId, 'user-id-000002');
});

check('emitTaskAssigned stays silent for unchanged assignment and unassignment', () => {
  const at = new Date();
  const unchanged = capture(EVENTS.TASK_ASSIGNED, () => emitTaskAssigned({
    task: { _id: 'task-id-000001', sprintId: null, assigneeId: 'user-id-000001' },
    previousAssigneeId: 'user-id-000001', actorId: 'actor-id-000001', at
  }));
  const unassigned = capture(EVENTS.TASK_ASSIGNED, () => emitTaskAssigned({
    task: { _id: 'task-id-000001', sprintId: null, assigneeId: null },
    previousAssigneeId: 'user-id-000001', actorId: 'actor-id-000001', at
  }));
  assert.equal(unchanged.length, 0);
  assert.equal(unassigned.length, 0);
});

check('listeners unsubscribe cleanly after the emission checks', () => {
  for (const name of [EVENTS.TASK_CREATED, EVENTS.TASK_STATUS_CHANGED, EVENTS.TASK_ASSIGNED]) {
    assert.equal(listenerCount(name), 0, `no leaked listeners on ${name}`);
  }
});

console.log(`\n${passed} task service checks passed.`);
