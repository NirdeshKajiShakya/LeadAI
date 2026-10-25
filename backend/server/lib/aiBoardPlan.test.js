// Unit checks for the AI board-generation glue: request validation, plan
// extraction, and the all-or-nothing board creation/rollback contract.
import assert from 'node:assert/strict';
import {
  AI_GOAL_MAX_LENGTH, boardNameFromGoal, createBoardWithPlan, normalizeBoardGenerationRequest,
  planningMessage, tasksFromAiResult
} from './aiBoardPlan.js';

let passed = 0;
function check(label, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

console.log('ai board generation rules\n');

check('goal is required and bounded', () => {
  assert.match(normalizeBoardGenerationRequest({ goal: 'short' }).error, /at least 10 characters/);
  assert.match(normalizeBoardGenerationRequest({ goal: 'x'.repeat(AI_GOAL_MAX_LENGTH + 1) }).error, /2000 characters or fewer/);
  assert.deepEqual(normalizeBoardGenerationRequest({ goal: '  Plan the launch  ', name: ' Launch ' }), {
    goal: 'Plan the launch', name: 'Launch'
  });
});

check('board name is optional and bounded', () => {
  assert.match(normalizeBoardGenerationRequest({ goal: 'Plan the launch', name: 'x'.repeat(121) }).error, /120 characters or fewer/);
});

check('planning message includes the goal and keeps work out of sprints', () => {
  const message = planningMessage('Build a booking site', 'Booking');
  assert.match(message, /Build a booking site/);
  assert.match(message, /named "Booking"/);
  assert.match(message, /Do not assign the work to a sprint/);
  assert.match(message, /Leave every task Unassigned/);
  assert.match(message, /Fibonacci story-point estimate/);
});

check('only create actions become a plan', () => {
  assert.deepEqual(tasksFromAiResult({ action: null }), []);
  assert.deepEqual(tasksFromAiResult({ action: { type: 'update', key: 'KAN-1', changes: {} } }), []);
  assert.deepEqual(
    tasksFromAiResult({ action: { type: 'create_many', tasks: [{ title: 'One' }, { title: 'Two' }] } }).map((task) => task.title),
    ['One', 'Two']
  );
  assert.deepEqual(
    tasksFromAiResult({ action: { type: 'create', title: 'Single' } }).map((task) => task.title),
    ['Single']
  );
});

check('board names derive from the user words without inventing details', () => {
  assert.equal(boardNameFromGoal('Build a coffee shop site. Include ordering.'), 'Build a coffee shop site');
  assert.equal(boardNameFromGoal('   '), 'New AI board');
});

await (async () => {
  const board = { _id: 'board-1', name: 'Launch' };
  const order = [];
  const result = await createBoardWithPlan({
    boardData: { name: 'Launch' },
    tasks: [{ title: 'One' }, { title: 'Two' }],
    createBoard: async () => { order.push('board'); return board; },
    createTask: async (task) => {
      order.push(`task:${task.title}:${task.boardId}`);
      return { key: `KAN-${task.title}` };
    },
    deleteBoardTasks: async () => order.push('deleteTasks'),
    deleteBoard: async () => order.push('deleteBoard')
  });
  check('a successful plan creates the board first and then its tasks', () => {
    assert.deepEqual(order, ['board', 'task:One:board-1', 'task:Two:board-1']);
    assert.equal(result.board, board);
    assert.equal(result.created.length, 2);
  });

  const failedOrder = [];
  await assert.rejects(() => createBoardWithPlan({
    boardData: { name: 'Broken' },
    tasks: [{ title: 'One' }, { title: 'Two' }],
    createBoard: async () => { failedOrder.push('board'); return { _id: 'board-2' }; },
    createTask: async (task) => {
      failedOrder.push(`task:${task.title}`);
      if (task.title === 'Two') throw new Error('validation failed');
      return { key: 'KAN-1' };
    },
    deleteBoardTasks: async (id) => failedOrder.push(`deleteTasks:${id}`),
    deleteBoard: async (id) => failedOrder.push(`deleteBoard:${id}`)
  }), /validation failed/);
  check('a failed task rolls back only the new board and its tasks', () => {
    assert.deepEqual(failedOrder, [
      'board', 'task:One', 'task:Two', 'deleteTasks:board-2', 'deleteBoard:board-2'
    ]);
  });
})();

console.log(`\n${passed} AI board generation checks passed.`);
