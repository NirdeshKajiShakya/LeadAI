// Pure rules behind the Home dashboard: overdue detection and deterministic
// attention ordering. The API test exercises the same helpers against a server.
import assert from 'node:assert/strict';
import {
  activeSprintsOf, compareDashboardTasks, isOverdueTask, orderDashboardTasks, stageCounts, taskBelongsTo
} from './dashboard.js';

const today = '2026-10-23';
let passed = 0;
function check(label, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

console.log('dashboard rules\n');

check('only unfinished tasks can be overdue', () => {
  assert.equal(isOverdueTask({ status: 'todo', dueDate: '2026-10-22' }, today), true);
  assert.equal(isOverdueTask({ status: 'done', dueDate: '2026-10-22' }, today), false);
  assert.equal(isOverdueTask({ status: 'review', dueDate: today }, today), false);
});

check('free-text and malformed due dates are ignored', () => {
  assert.equal(isOverdueTask({ status: 'todo', dueDate: 'Today' }, today), false);
  assert.equal(isOverdueTask({ status: 'todo', dueDate: 'This week' }, today), false);
  assert.equal(isOverdueTask({ status: 'todo', dueDate: '2026-13-40' }, today), false);
  assert.equal(isOverdueTask({ status: 'todo', dueDate: '' }, today), false);
});

check('assignment matches the stored member name and ignores Unassigned', () => {
  assert.equal(taskBelongsTo({ assignee: 'Ada Lovelace' }, ['Ada Lovelace']), true);
  assert.equal(taskBelongsTo({ assignee: 'ada lovelace' }, ['Ada Lovelace']), false);
  assert.equal(taskBelongsTo({ assignee: 'Unassigned' }, ['Ada Lovelace']), false);
  assert.equal(taskBelongsTo({}, ['Ada Lovelace']), false);
});

check('overdue work sorts before higher-priority planned work', () => {
  const ordered = orderDashboardTasks([
    { key: 'KAN-1', priority: 'urgent', dueDate: '2026-11-01', createdAt: '2026-01-01T00:00:00Z' },
    { key: 'KAN-2', priority: 'low', dueDate: '2026-10-01', createdAt: '2026-01-02T00:00:00Z' }
  ], today);
  assert.deepEqual(ordered.map((task) => task.key), ['KAN-2', 'KAN-1']);
});

check('then priority, then the nearest real due date', () => {
  const ordered = orderDashboardTasks([
    { key: 'KAN-1', priority: 'medium', dueDate: '2026-10-24' },
    { key: 'KAN-2', priority: 'high', dueDate: '2026-12-01' },
    { key: 'KAN-3', priority: 'high', dueDate: '2026-11-01' },
    { key: 'KAN-4', priority: 'high', dueDate: 'This week' }
  ], today);
  assert.deepEqual(ordered.map((task) => task.key), ['KAN-3', 'KAN-2', 'KAN-4', 'KAN-1']);
});

check('ties fall back to age and then the unique key', () => {
  const ordered = orderDashboardTasks([
    { key: 'KAN-9', priority: 'high', createdAt: '2026-02-01T00:00:00Z' },
    { key: 'KAN-3', priority: 'high', createdAt: '2026-01-01T00:00:00Z' },
    { key: 'KAN-1', priority: 'high', createdAt: '2026-01-01T00:00:00Z' }
  ], today);
  assert.deepEqual(ordered.map((task) => task.key), ['KAN-1', 'KAN-3', 'KAN-9']);
  assert.ok(compareDashboardTasks({ key: 'A' }, { key: 'B' }, today) < 0);
});

check('stage counts ignore unknown statuses', () => {
  assert.deepEqual(
    stageCounts([{ status: 'backlog' }, { status: 'todo' }, { status: 'todo' }, { status: 'done' }, { status: 'mystery' }]),
    { backlog: 1, todo: 2, progress: 0, review: 0, done: 1 }
  );
});

check('the active sprint that ends first is selected', () => {
  const active = activeSprintsOf([
    { name: 'Later', startDate: '2026-10-20', endDate: '2026-11-02' },
    { name: 'Ends soon', startDate: '2026-10-18', endDate: '2026-10-31' },
    { name: 'Finished', startDate: '2026-10-01', endDate: '2026-10-14' }
  ], today);
  assert.deepEqual(active.map((sprint) => sprint.name), ['Ends soon', 'Later']);
});

console.log(`\n${passed} dashboard rule checks passed.`);
