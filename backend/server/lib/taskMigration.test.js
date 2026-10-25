// Unit checks for the J2 legacy-field migration helpers. These are pure
// functions, so no database is required.
import assert from 'node:assert/strict';
import {
  ALLOWED_STATUSES, STATUS_CATEGORY, assertMappedStatus, statusCategory, convertDueDate, normalizeDueDate
} from './taskMigration.js';

let passed = 0;
function check(label, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

console.log('task migration checks\n');

check('every allowed status maps to a category', () => {
  for (const status of ALLOWED_STATUSES) {
    assert.ok(STATUS_CATEGORY[status], `missing category for ${status}`);
  }
});

check('backlog/todo are todo-category, progress/review in-progress, done done', () => {
  assert.equal(statusCategory('backlog'), 'todo');
  assert.equal(statusCategory('todo'), 'todo');
  assert.equal(statusCategory('progress'), 'in-progress');
  assert.equal(statusCategory('review'), 'in-progress');
  assert.equal(statusCategory('done'), 'done');
});

check('unmapped statuses are rejected', () => {
  assert.throws(() => assertMappedStatus('doing'), /Unmapped status/);
  assert.throws(() => statusCategory('in_progress'), /Unmapped status/);
});

check('Unscheduled maps to no date', () => {
  assert.deepEqual(convertDueDate('Unscheduled'), { date: null, reason: null });
  assert.deepEqual(convertDueDate(''), { date: null, reason: null });
  assert.deepEqual(convertDueDate(null), { date: null, reason: null });
  assert.deepEqual(convertDueDate(undefined), { date: null, reason: null });
});

check('Today resolves against the migration reference date by default', () => {
  const { date, reason } = convertDueDate('Today');
  assert.equal(reason, null);
  assert.equal(date.toISOString(), '2026-10-19T00:00:00.000Z');
});

check('Today honours an explicit today argument', () => {
  const { date } = convertDueDate('Today', '2027-01-15');
  assert.equal(date.toISOString(), '2027-01-15T00:00:00.000Z');
});

check('ISO dates pass through', () => {
  const { date, reason } = convertDueDate('2026-11-05');
  assert.equal(reason, null);
  assert.equal(date.toISOString(), '2026-11-05T00:00:00.000Z');
});

check('existing Date values pass through', () => {
  const input = new Date('2026-12-01T00:00:00Z');
  const { date, reason } = convertDueDate(input);
  assert.equal(reason, null);
  assert.equal(date.getTime(), input.getTime());
});

check('Sep 28 resolves to the next future occurrence', () => {
  // Reference date 2026-10-19 is past Sep 28, so the next year wins.
  assert.equal(convertDueDate('Sep 28', '2026-10-19').date.toISOString(), '2027-09-28T00:00:00.000Z');
  // Still in the future this year.
  assert.equal(convertDueDate('Sep 28', '2026-09-01').date.toISOString(), '2026-09-28T00:00:00.000Z');
});

check('unparseable values are flagged, not silently dropped', () => {
  const { date, reason } = convertDueDate('This week');
  assert.equal(date, null);
  assert.match(reason, /^cannot parse: This week$/);
  assert.match(convertDueDate('whenever').reason, /cannot parse/);
});

check('relative API labels resolve to deterministic calendar dates', () => {
  assert.equal(normalizeDueDate('Today', '2026-10-25').date.toISOString(), '2026-10-25T00:00:00.000Z');
  assert.equal(normalizeDueDate('Tomorrow', '2026-10-25').date.toISOString(), '2026-10-26T00:00:00.000Z');
  assert.equal(normalizeDueDate('This week', '2026-10-25').date.toISOString(), '2026-10-25T00:00:00.000Z');
});

check('invalid and malformed dates are rejected without fallback dates', () => {
  assert.match(normalizeDueDate('2026-02-30', '2026-10-25').reason, /cannot parse/);
  assert.match(normalizeDueDate('whenever', '2026-10-25').reason, /cannot parse/);
  assert.equal(normalizeDueDate(null, '2026-10-25').date, null);
  assert.equal(normalizeDueDate('', '2026-10-25').date, null);
});

console.log(`\n${passed} migration checks passed.`);
