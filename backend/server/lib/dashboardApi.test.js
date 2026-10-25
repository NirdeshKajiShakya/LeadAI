// Home dashboard API checks. Runs against a scratch in-memory server (never the
// shared development database) and verifies auth, ownership, aggregates, overdue
// rules, sprint-progress reuse, isolation, empty state, and the AI failure path.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = process.env.TEST_DASHBOARD_PORT || 4104;
const BASE = `http://127.0.0.1:${PORT}/api`;

let passed = 0;
function check(label, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

const server = spawn(process.execPath, ['server/index.js'], {
  env: {
    ...process.env,
    PORT: String(PORT),
    MONGODB_URI: '',
    ALLOW_MEMORY_DB: '1',
    NODE_ENV: 'test',
    OPENROUTER_API_KEY: ''
  },
  stdio: 'ignore'
});

async function waitForApi() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch { /* not up yet */ }
    await sleep(150);
  }
  throw new Error('server did not start');
}

async function api(path, options = {}, token = '') {
  const response = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...options
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

async function signupAndSignIn(label) {
  const email = `dash-${label}-${Date.now()}@example.com`;
  const name = `Dash ${label} Tester`;
  const signup = await api('/auth/signup', { method: 'POST', body: JSON.stringify({ name, email, password: 'Password123!' }) });
  assert.equal(signup.status, 201, `signup failed for ${label}`);
  const signin = await api('/auth/signin', { method: 'POST', body: JSON.stringify({ email, password: 'Password123!' }) });
  assert.equal(signin.status, 200, `signin failed for ${label}`);
  return { token: signin.body.token, name, email };
}

async function createTask(token, fields) {
  const { status, body } = await api('/tasks', { method: 'POST', body: JSON.stringify(fields) }, token);
  assert.equal(status, 201, `could not create ${fields.title}`);
  return body;
}

try {
  await waitForApi();
  console.log(`\ndashboard API checks (port ${PORT})\n`);

  const unauth = await api('/dashboard/summary');
  check('dashboard requires authentication', () => assert.equal(unauth.status, 401));

  const userA = await signupAndSignIn('A');
  const tokenA = userA.token;

  const initial = await api('/dashboard/summary', {}, tokenA);
  check('summary responds for an authenticated user', () => assert.equal(initial.status, 200));
  check('signup board and real starter data are counted', () => {
    assert.equal(initial.body.stats.boards, 1);
    assert.equal(initial.body.stats.myOpenTasks, 3);
    assert.equal(initial.body.stats.overdueTasks, 0);
    assert.equal(initial.body.boards[0].totalTasks, 5);
    assert.equal(initial.body.boards[0].openTasks, 4);
  });
  check('reading the dashboard never creates a sprint', () => {
    assert.equal(initial.body.stats.activeSprints, 0);
    assert.equal(initial.body.activeSprint, null);
  });
  check('the AI limitation is reported without a secret', () => {
    assert.deepEqual(initial.body.ai, { configured: false });
  });
  check('initial attention order follows priority', () => {
    const titles = initial.body.priorityTasks.map((task) => task.title);
    assert.equal(titles[0], 'Create your first task');
    assert.equal(titles[1], 'Agree on a definition of done');
  });

  const overdue = await createTask(tokenA, {
    title: 'Overdue low item', priority: 'low', dueDate: '2000-01-01', assignee: userA.name
  });
  const urgent = await createTask(tokenA, {
    title: 'Urgent upcoming', priority: 'urgent', dueDate: '2999-01-01', assignee: userA.name, storyPoints: 5
  });
  const high = await createTask(tokenA, {
    title: 'High with date', priority: 'high', dueDate: '2999-02-01', assignee: userA.name
  });
  await createTask(tokenA, {
    title: 'Free text due', priority: 'medium', dueDate: 'This week', assignee: userA.name
  });
  await createTask(tokenA, {
    title: 'Nobody owns this', priority: 'urgent', dueDate: '2000-01-01', assignee: 'Unassigned'
  });

  const withTasks = await api('/dashboard/summary', {}, tokenA);
  check('my open count is assignment-scoped', () => {
    assert.equal(withTasks.body.stats.myOpenTasks, 7);
  });
  check('overdue count ignores done, unassigned, and free-text dates', () => {
    assert.equal(withTasks.body.stats.overdueTasks, 1);
  });
  check('overdue work leads the attention list', () => {
    const titles = withTasks.body.priorityTasks.map((task) => task.title);
    assert.equal(titles[0], 'Overdue low item');
    assert.equal(withTasks.body.priorityTasks[0].overdue, true);
  });
  check('urgent and high work follow, and unassigned work is excluded', () => {
    const titles = withTasks.body.priorityTasks.map((task) => task.title);
    assert.ok(titles.indexOf('Urgent upcoming') < titles.indexOf('High with date'));
    assert.equal(titles.includes('Nobody owns this'), false);
    assert.equal(titles.includes('Free text due'), true);
  });
  check('task summaries expose their board for click-through', () => {
    const task = withTasks.body.priorityTasks[0];
    assert.ok(task.boardId);
    assert.equal(task.boardName, withTasks.body.boards[0].name);
    assert.equal(task.key, overdue.key);
  });

  const boardId = withTasks.body.boards[0].id;
  const secondBoard = await api('/boards', {
    method: 'POST',
    body: JSON.stringify({ name: 'Second Dashboard Board' })
  }, tokenA);
  assert.equal(secondBoard.status, 201);
  const emptySecondBoardSummary = await api(`/dashboard/summary?boardId=${encodeURIComponent(secondBoard.body.id)}`, {}, tokenA);
  check('selected board summary does not inherit another board sprint', () => {
    assert.equal(emptySecondBoardSummary.body.stats.activeSprints, 0);
    assert.equal(emptySecondBoardSummary.body.activeSprint, null);
  });
  const createdSprint = await api('/sprints', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Dashboard Sprint',
      startDate: new Date().toISOString().slice(0, 10),
      boardId
    })
  }, tokenA);
  assert.equal(createdSprint.status, 201, 'could not explicitly create dashboard sprint');
  const { body: sprints } = await api(`/sprints?boardId=${encodeURIComponent(boardId)}`, {}, tokenA);
  const activeSprint = sprints.find((sprint) => sprint.current.state === 'active');
  check('an existing active sprint is summarised', () => assert.ok(activeSprint));

  await api(`/sprints/${activeSprint.id}/tasks`, { method: 'POST', body: JSON.stringify({ key: urgent.key }) }, tokenA);
  await api(`/tasks/${urgent.key}`, { method: 'PATCH', body: JSON.stringify({ storyPoints: 5 }) }, tokenA);
  for (const status of ['progress', 'review', 'done']) {
    const moved = await api(`/tasks/${urgent.key}`, { method: 'PATCH', body: JSON.stringify({ status }) }, tokenA);
    assert.equal(moved.status, 200, `could not move ${urgent.key} to ${status}`);
  }

  const { body: sprintDetail } = await api(`/sprints/${activeSprint.id}`, {}, tokenA);
  const sprintDash = await api('/dashboard/summary', {}, tokenA);
  check('sprint statistics reuse the existing sprint calculation', () => {
    assert.equal(sprintDash.body.stats.activeSprints, 1);
    assert.equal(sprintDash.body.stats.sprintProgress, sprintDetail.progress.progressPercent);
    assert.equal(sprintDash.body.activeSprint.progress.progressPercent, sprintDetail.progress.progressPercent);
    assert.equal(sprintDash.body.activeSprint.progress.totalStoryPoints, sprintDetail.progress.totalStoryPoints);
    assert.equal(sprintDash.body.activeSprint.progress.completedStoryPoints, sprintDetail.progress.completedStoryPoints);
  });
  check('the active sprint reports its board and stage counts', () => {
    assert.equal(sprintDash.body.activeSprint.boardName, withTasks.body.boards[0].name);
    assert.ok(sprintDash.body.activeSprint.stages.done >= 1);
  });
  const secondSprint = await api('/sprints', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Second Board Sprint',
      startDate: new Date().toISOString().slice(0, 10),
      boardId: secondBoard.body.id
    })
  }, tokenA);
  assert.equal(secondSprint.status, 201);
  const firstBoardSummary = await api(`/dashboard/summary?boardId=${encodeURIComponent(boardId)}`, {}, tokenA);
  const secondBoardSummary = await api(`/dashboard/summary?boardId=${encodeURIComponent(secondBoard.body.id)}`, {}, tokenA);
  check('dashboard active sprint and metrics follow the selected board', () => {
    assert.equal(firstBoardSummary.body.activeSprint.id, activeSprint.id);
    assert.equal(secondBoardSummary.body.activeSprint.id, secondSprint.body.id);
    assert.equal(firstBoardSummary.body.stats.activeSprints, 1);
    assert.equal(secondBoardSummary.body.stats.activeSprints, 1);
  });
  check('board cards report open work and the linked active sprint', () => {
    const board = sprintDash.body.boards.find((item) => item.id === boardId);
    assert.ok(board.openTasks > 0);
    assert.equal(board.activeSprint.id, activeSprint.id);
  });

  const userB = await signupAndSignIn('B');
  const tokenB = userB.token;
  const dashB = await api('/dashboard/summary', {}, tokenB);
  check('another user only sees their own board and tasks', () => {
    assert.equal(dashB.body.stats.boards, 1);
    assert.equal(dashB.body.stats.myOpenTasks, 3);
    assert.notEqual(dashB.body.boards[0].id, withTasks.body.boards[0].id);
    const aKeys = new Set(withTasks.body.priorityTasks.map((task) => task.key));
    assert.equal(dashB.body.priorityTasks.some((task) => aKeys.has(task.key)), false);
  });
  check('another user has no active sprint of their own', () => assert.equal(dashB.body.activeSprint, null));

  const crossBoard = await api(`/tasks?boardId=${withTasks.body.boards[0].id}`, {}, tokenB);
  check('board access control still rejects a non-member', () => assert.equal(crossBoard.status, 403));

  const aiUnauth = await api('/ai/boards', { method: 'POST', body: JSON.stringify({ goal: 'Plan a product launch' }) });
  check('AI board generation requires authentication', () => assert.equal(aiUnauth.status, 401));
  const aiShort = await api('/ai/boards', { method: 'POST', body: JSON.stringify({ goal: 'short' }) }, tokenA);
  check('AI board generation validates the goal', () => {
    assert.equal(aiShort.status, 400);
    assert.match(aiShort.body.error, /at least 10 characters/);
  });
  const aiUnconfigured = await api('/ai/boards', { method: 'POST', body: JSON.stringify({ goal: 'Plan a product launch' }) }, tokenA);
  check('missing AI configuration returns an honest 503', () => {
    assert.equal(aiUnconfigured.status, 503);
    assert.equal(aiUnconfigured.body.code, 'AI_NOT_CONFIGURED');
    assert.match(aiUnconfigured.body.error, /not configured/i);
  });
  const afterAi = await api('/dashboard/summary', {}, tokenA);
  check('a failed AI request creates no board', () => {
    assert.equal(afterAi.body.stats.boards, withTasks.body.stats.boards + 1);
  });

  const userC = await signupAndSignIn('C');
  const tokenC = userC.token;
  const boardsC = await api('/boards', {}, tokenC);
  await api(`/boards/${boardsC.body[0].id}`, { method: 'DELETE' }, tokenC);
  const emptyDash = await api('/dashboard/summary', {}, tokenC);
  const emptyDashAgain = await api('/dashboard/summary', {}, tokenC);
  check('an empty workspace returns clean zero states', () => {
    assert.deepEqual(emptyDash.body.stats, {
      boards: 0, myOpenTasks: 0, overdueTasks: 0, activeSprints: 0, sprintProgress: 0
    });
    assert.deepEqual(emptyDash.body.boards, []);
    assert.deepEqual(emptyDash.body.priorityTasks, []);
    assert.equal(emptyDash.body.activeSprint, null);
  });
  check('repeated reads stay empty (no dashboard side effects)', () => {
    assert.equal(emptyDashAgain.body.stats.activeSprints, 0);
    assert.deepEqual(emptyDashAgain.body.boards, []);
  });

  console.log(`\n${passed} dashboard API checks passed.`);
} finally {
  server.kill();
}
