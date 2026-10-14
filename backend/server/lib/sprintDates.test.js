import assert from 'node:assert/strict';
import {
  SPRINT_DURATION_DAYS, isValidIsoDate, diffCalendarDays, endDateForStart,
  validateSprintRange, computeSprintDay, summarizeTasks, todayIsoDate, formatDateRange
} from './sprintDates.js';

let passed = 0;
function check(label, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

check('duration is 14 days', () => assert.equal(SPRINT_DURATION_DAYS, 14));

check('valid ISO dates accepted, real dates only', () => {
  assert.equal(isValidIsoDate('2026-10-13'), true);
  assert.equal(isValidIsoDate('2026-02-30'), false, 'Feb 30 must be rejected');
  assert.equal(isValidIsoDate('2026-13-01'), false);
  assert.equal(isValidIsoDate('26-10-13'), false);
  assert.equal(isValidIsoDate('not-a-date'), false);
  assert.equal(isValidIsoDate(undefined), false);
});

check('leap day parses correctly', () => assert.equal(isValidIsoDate('2028-02-29'), true));

check('end date is start + 13 (inclusive 14)', () => {
  assert.equal(endDateForStart('2026-10-01'), '2026-10-14');
  const range = validateSprintRange('2026-10-01', '2026-10-14');
  assert.equal(range.ok, true);
  assert.equal(range.durationDays, 14);
});

check('range validation rejects wrong length and inverted dates', () => {
  assert.equal(validateSprintRange('2026-10-01', '2026-10-13').ok, false, '13 days is invalid');
  assert.equal(validateSprintRange('2026-10-01', '2026-10-15').ok, false, '15 days is invalid');
  assert.equal(validateSprintRange('2026-10-05', '2026-10-01').ok, false, 'end before start is invalid');
  assert.equal(validateSprintRange('bogus', '2026-10-14').ok, false);
});

check('range validation allows omitted end date', () => {
  assert.equal(validateSprintRange('2026-10-01').ok, true);
});

check('start day counts as Day 1, not Day 0', () => {
  const result = computeSprintDay('2026-10-01', '2026-10-14', '2026-10-01');
  assert.equal(result.day, 1);
  assert.equal(result.state, 'active');
  assert.equal(result.remaining, 13);
});

check('current day advances with elapsed calendar days', () => {
  assert.equal(computeSprintDay('2026-10-01', '2026-10-14', '2026-10-04').day, 4);
  assert.equal(computeSprintDay('2026-10-01', '2026-10-14', '2026-10-04').remaining, 10);
  assert.equal(computeSprintDay('2026-10-01', '2026-10-14', '2026-10-14').day, 14);
  assert.equal(computeSprintDay('2026-10-01', '2026-10-14', '2026-10-14').remaining, 0);
});

check('sprint spans a month boundary without drift', () => {
  const range = validateSprintRange('2026-10-25', '2026-11-07');
  assert.equal(range.ok, true);
  assert.equal(computeSprintDay('2026-10-25', '2026-11-07', '2026-10-29').day, 5);
  assert.equal(computeSprintDay('2026-10-25', '2026-11-07', '2026-11-02').day, 9);
});

check('upcoming and completed states', () => {
  assert.equal(computeSprintDay('2026-10-20', '2026-11-02', '2026-10-13').state, 'upcoming');
  assert.equal(computeSprintDay('2026-10-20', '2026-11-02', '2026-10-13').day, 0);
  assert.equal(computeSprintDay('2026-10-01', '2026-10-14', '2026-10-15').state, 'completed');
  assert.equal(computeSprintDay('2026-10-01', '2026-10-14', '2026-10-15').remaining, 0);
});

check('progress uses completed story points over committed', () => {
  const summary = summarizeTasks([
    { status: 'done', storyPoints: 5 },
    { status: 'todo', storyPoints: 5 },
    { status: 'progress', storyPoints: 0 }
  ]);
  assert.equal(summary.totalStoryPoints, 10);
  assert.equal(summary.completedStoryPoints, 5);
  assert.equal(summary.remainingStoryPoints, 5);
  assert.equal(summary.progressPercent, 50);
});

check('empty sprint does not divide by zero', () => {
  const summary = summarizeTasks([]);
  assert.equal(summary.progressPercent, 0);
  assert.equal(summary.total, 0);
  assert.equal(summarizeTasks(undefined).progressPercent, 0);
});

check('missing story points count as zero', () => {
  assert.equal(summarizeTasks([{ status: 'todo' }]).totalStoryPoints, 0);
});

check('date formatting is stable and timezone independent', () => {
  assert.equal(formatDateRange('2026-10-01', '2026-10-14'), 'Oct 1 - Oct 14');
  assert.equal(formatDateRange('bad', '2026-10-14'), '');
});

check('todayIsoDate returns a valid local calendar date', () => {
  assert.equal(isValidIsoDate(todayIsoDate()), true);
});

console.log(`\n${passed} date/rollup checks passed.`);