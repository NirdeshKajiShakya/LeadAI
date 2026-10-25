import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Task } from '../models/Task.js';

const PORT = Number(process.env.NOTIFICATION_TEST_PORT || 4137);
const BASE = `http://127.0.0.1:${PORT}/api`;
const server = spawn(process.execPath, [fileURLToPath(new URL('../index.js', import.meta.url))], {
  env: { ...process.env, PORT: String(PORT), MONGODB_URI: '', ALLOW_MEMORY_DB: '1' },
  stdio: 'ignore'
});

async function waitForApi() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch { /* the child process is still starting */ }
    await sleep(100);
  }
  throw new Error('notification test server did not start');
}

async function api(path, token, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {})
    }
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function eventually(callback, message) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const value = await callback();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(message);
}

try {
  await waitForApi();
  const suffix = Date.now();
  const ownerEmail = `notification-owner-${suffix}@example.com`;
  const memberEmail = `notification-member-${suffix}@example.com`;
  await api('/auth/signup', null, { method: 'POST', body: JSON.stringify({ name: 'Owner', email: ownerEmail, password: 'Password123!' }) });
  await api('/auth/signup', null, { method: 'POST', body: JSON.stringify({ name: 'Member', email: memberEmail, password: 'Password123!' }) });
  const ownerAuth = await api('/auth/signin', null, { method: 'POST', body: JSON.stringify({ email: ownerEmail, password: 'Password123!' }) });
  const memberAuth = await api('/auth/signin', null, { method: 'POST', body: JSON.stringify({ email: memberEmail, password: 'Password123!' }) });
  const ownerToken = ownerAuth.body.token;
  const memberToken = memberAuth.body.token;
  const owner = ownerAuth.body.user;
  const member = memberAuth.body.user;
  const ownerBoards = await api('/boards', ownerToken);
  const boardId = ownerBoards.body[0].id;
  const starterTasks = await api(`/tasks?boardId=${boardId}`, ownerToken);
  assert.ok(starterTasks.body.length > 0);
  for (const starterTask of starterTasks.body) {
    assert.ok(starterTask.dueDate === null || /^\d{4}-\d{2}-\d{2}$/.test(starterTask.dueDate));
    const casted = new Task({ key: starterTask.key, title: starterTask.title, dueDate: starterTask.dueDate });
    await assert.doesNotReject(() => casted.validate());
  }

  const invite = await api(`/boards/${boardId}/members`, ownerToken, {
    method: 'POST', body: JSON.stringify({ email: memberEmail })
  });
  assert.equal(invite.status, 201);
  assert.equal(invite.body.pending, true);
  const stillPrivate = await api('/boards', memberToken);
  assert.equal(stillPrivate.body.some((board) => board.id === boardId), false);
  const memberNotifications = await api('/notifications', memberToken);
  const inviteNotice = memberNotifications.body.notifications.find((item) => item.type === 'board_invite');
  assert.ok(inviteNotice);
  assert.equal(inviteNotice.metadata.inviteStatus, 'pending');
  const unauthorizedResponse = await api('/boards/invite/respond', ownerToken, {
    method: 'POST', body: JSON.stringify({ notificationId: inviteNotice._id, action: 'accept' })
  });
  assert.equal(unauthorizedResponse.status, 404);
  const readInvite = await api(`/notifications/${inviteNotice._id}/read`, memberToken, { method: 'PATCH' });
  assert.equal(readInvite.status, 200);
  const accepted = await api('/boards/invite/respond', memberToken, {
    method: 'POST', body: JSON.stringify({ notificationId: inviteNotice._id, action: 'accept' })
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.notification.metadata.inviteStatus, 'accepted');
  const sharedBoards = await api('/boards', memberToken);
  assert.equal(sharedBoards.body.some((board) => board.id === boardId), true);

  const rulesResponse = await api(`/automations?boardId=${boardId}`, ownerToken);
  assert.equal(rulesResponse.status, 200);
  assert.deepEqual(rulesResponse.body.rules, {
    taskAssignmentNotification: true,
    taskReviewAlert: true,
    smartMemberReassignment: false,
    autoCompleteSubtasks: false,
    overduePriorityEscalation: true,
    sprintKickoffBroadcast: true
  });
  const ruleUpdate = await api('/automations', ownerToken, {
    method: 'PATCH',
    body: JSON.stringify({ boardId, rules: { autoCompleteSubtasks: true } })
  });
  assert.equal(ruleUpdate.body.rules.autoCompleteSubtasks, true);
  assert.equal(ruleUpdate.body.rules.taskAssignmentNotification, true);
  assert.equal((await api('/automations', memberToken, {
    method: 'PATCH', body: JSON.stringify({ boardId, rules: { taskReviewAlert: false } })
  })).status, 403);

  const task = await api('/tasks', ownerToken, {
    method: 'POST',
    body: JSON.stringify({
      boardId,
      title: 'Checklist and assignment task',
      status: 'todo',
      assigneeId: member._id,
      dueDate: '2000-01-01',
      checklist: [{ text: 'Ship implementation', completed: false }]
    })
  });
  assert.equal(task.status, 201);
  const assignment = await eventually(async () => {
    const result = await api('/notifications', memberToken);
    return result.body.notifications.find((item) => item.type === 'task_assigned');
  }, 'task assignment notification was not dispatched');
  assert.equal(assignment.metadata.taskKey, task.body.key);
  const review = await api(`/tasks/${task.body.key}`, memberToken, {
    method: 'PATCH', body: JSON.stringify({ status: 'review' })
  });
  assert.equal(review.status, 200);
  await eventually(async () => {
    const result = await api('/notifications', ownerToken);
    return result.body.notifications.find((item) => item.type === 'task_review');
  }, 'task review notification was not dispatched');

  const completed = await api(`/tasks/${task.body.key}`, ownerToken, {
    method: 'PATCH', body: JSON.stringify({ checklist: [{ text: 'Ship implementation', completed: true }] })
  });
  assert.equal(completed.body.status, 'done');
  const completionHistory = await api(`/tasks/${task.body.key}/history`, ownerToken);
  assert.ok(completionHistory.body.some((entry) => entry.source === 'automation' && entry.note.includes('checklist item')));

  await eventually(async () => {
    const result = await api(`/tasks?boardId=${boardId}`, ownerToken);
    const overdue = result.body.find((item) => item.key === task.body.key);
    return overdue?.automationFlags?.overdueEscalated && overdue.priority === 'high';
  }, 'overdue task was not escalated');

  const sprint = await api('/sprints', ownerToken, {
    method: 'POST',
    body: JSON.stringify({ name: 'Kickoff Sprint', goal: 'Deliver notifications', boardId })
  });
  assert.equal(sprint.status, 201);
  await eventually(async () => {
    const result = await api('/notifications', memberToken);
    return result.body.notifications.find((item) => item.type === 'sprint_started');
  }, 'sprint kickoff notification was not broadcast');

  await api('/automations', ownerToken, {
    method: 'PATCH',
    body: JSON.stringify({ boardId, rules: { smartMemberReassignment: true } })
  });
  const reassignmentTask = await api('/tasks', ownerToken, {
    method: 'POST',
    body: JSON.stringify({ boardId, title: 'Reassign after departure', status: 'todo', assigneeId: member._id })
  });
  assert.equal(reassignmentTask.status, 201);
  const removed = await api(`/boards/${boardId}/members/${member._id}`, memberToken, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  await eventually(async () => {
    const result = await api(`/tasks?boardId=${boardId}`, ownerToken);
    const movedTask = result.body.find((item) => item.key === reassignmentTask.body.key);
    return movedTask?.assigneeId === owner._id && movedTask.assignee === owner.name;
  }, 'member departure did not reassign the open task');
  const reassignmentHistory = await api(`/tasks/${reassignmentTask.body.key}/history`, ownerToken);
  assert.ok(reassignmentHistory.body.some((entry) => entry.source === 'automation' && entry.note.includes('after their departure')));

  const secondBoard = await api('/boards', ownerToken, {
    method: 'POST', body: JSON.stringify({ name: 'Decline test board' })
  });
  const declineInvite = await api(`/boards/${secondBoard.body.id}/members`, ownerToken, {
    method: 'POST', body: JSON.stringify({ email: memberEmail })
  });
  assert.equal(declineInvite.status, 201);
  const freshNotifications = await api('/notifications', memberToken);
  const pendingToDecline = freshNotifications.body.notifications.find((item) =>
    item.type === 'board_invite' && item.metadata.boardId === secondBoard.body.id
  );
  assert.ok(pendingToDecline);
  const declined = await api('/boards/invite/respond', memberToken, {
    method: 'POST', body: JSON.stringify({ notificationId: pendingToDecline._id, action: 'decline' })
  });
  assert.equal(declined.body.notification.metadata.inviteStatus, 'declined');
  const memberBoardsAfterDecline = await api('/boards', memberToken);
  assert.equal(memberBoardsAfterDecline.body.some((board) => board.id === secondBoard.body.id), false);

  const markAll = await api('/notifications/read-all', memberToken, { method: 'PATCH' });
  assert.equal(markAll.status, 200);
  assert.equal((await api('/notifications', memberToken)).body.unreadCount, 0);
  const dismiss = await api(`/notifications/${pendingToDecline._id}`, memberToken, { method: 'DELETE' });
  assert.equal(dismiss.status, 200);
  assert.equal(owner._id, ownerAuth.body.user._id);
  console.log('notification, board invitation, and automation API checks passed');
} finally {
  server.kill('SIGTERM');
}
