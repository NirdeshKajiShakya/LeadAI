// Unit checks for the J1 task status service helpers. `applyStatusLifecycle`
// is the shared, database-free core used by both the Mongo and in-memory
// storage paths, so it can be tested without a running server.
import assert from 'node:assert/strict';
import {
  ALLOWED_STATUSES_LIST, STATUS_CATEGORIES, STATUS_CATEGORY_MAP,
  applyStatusLifecycle, isInProgressStatus, isDoneStatus, isTaskStatusRecord
} from './taskService.js';

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

console.log(`\n${passed} task service checks passed.`);
