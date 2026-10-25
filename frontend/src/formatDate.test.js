import assert from 'node:assert/strict';
import { formatDate } from './formatDate.js';
import { formatDateRange } from './sprintDates.js';

assert.equal(formatDate('2026-11-05T00:00:00.000Z'), 'Nov 5, 2026');
assert.equal(formatDate('2026-11-05'), 'Nov 5, 2026');
assert.equal(formatDate(null), '');
assert.equal(formatDate(undefined), '');
assert.equal(formatDate(''), '');
assert.equal(formatDate('2026-02-30'), '');
assert.equal(formatDate('2026-11-05not-a-date'), '');
assert.equal(formatDate('not a date'), 'not a date');
assert.equal(formatDate('Unscheduled'), 'Unscheduled');
assert.equal(formatDateRange('2026-11-05', '2026-11-18'), 'Nov 5, 2026 - Nov 18, 2026');
assert.equal(formatDateRange('invalid', '2026-11-18'), 'Dates unavailable');

console.log('Date formatter checks passed.');
