import assert from 'node:assert/strict';
import { fallbackSprintName, fallbackSprintPlan } from './sprintPlan.js';

const backlog = [
  { key: 'KAN-1', status: 'backlog' },
  { key: 'KAN-1', status: 'backlog' },
  { key: 'KAN-2', status: 'todo' },
  { key: 'KAN-3', status: 'backlog', sprintId: 'sprint-1' },
  ...Array.from({ length: 22 }, (_, index) => ({
    key: `KAN-${index + 4}`,
    status: 'backlog'
  }))
];

assert.deepEqual(fallbackSprintPlan(backlog), {
  selectedTaskKeys: [
    'KAN-1',
    ...Array.from({ length: 19 }, (_, index) => `KAN-${index + 4}`)
  ],
  tasks: []
});
assert.deepEqual(fallbackSprintPlan([]), { selectedTaskKeys: [], tasks: [] });
assert.equal(fallbackSprintName('Create a new sprint 2 with the goal to finish the project'), 'Sprint 2');
assert.equal(fallbackSprintName('Finish the project', "Zen's board"), "Zen's board Sprint");

console.log('sprint plan fallback checks passed');
