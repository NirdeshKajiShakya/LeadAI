import { Task } from '../models/Task.js';
import { Sprint } from '../models/Sprint.js';
import { TaskHistory } from '../models/TaskHistory.js';
import { ALLOWED_STATUSES, STATUS_CATEGORY, assertMappedStatus } from './taskMigration.js';

// Canonical status list exposed to routes and tests (single source of truth).
export const ALLOWED_STATUSES_LIST = Object.freeze([...ALLOWED_STATUSES]);

const IN_PROGRESS_STATUSES = new Set(['progress', 'review']);
const DONE_STATUSES = new Set(['done']);

export function isInProgressStatus(status) { return IN_PROGRESS_STATUSES.has(status); }
export function isDoneStatus(status) { return DONE_STATUSES.has(status); }

/**
 * Applies the J2 status lifecycle fields to a task-like object:
 *  - `startedAt` is stamped the first time the task enters an in-progress
 *    status (progress/review) and never overwritten afterwards,
 *  - `completedAt` is stamped every time the task reaches `done`,
 *  - `updatedAt` always moves forward.
 * Pure with respect to the database so it is directly unit-testable and is
 * shared by the Mongo path and the in-memory path.
 */
export function applyStatusLifecycle(task, newStatus, now = new Date()) {
  task.status = newStatus;
  task.updatedAt = now;
  if (isInProgressStatus(newStatus) && !task.startedAt) task.startedAt = now;
  if (isDoneStatus(newStatus)) task.completedAt = now;
  if (!isDoneStatus(newStatus)) task.completedAt = null;
  return task;
}

/**
 * Centralized task status transition service (J1).
 *
 * Every persisted status change flows through here. It:
 *  - derives the prior status from persisted state (never trusts a client
 *    `from` value),
 *  - performs a no-op when the status is unchanged (no history entry),
 *  - manages `startedAt`/`completedAt` lifecycle,
 *  - records `TaskHistory` only after the task update has been committed.
 *
 * Limitation: no MongoDB transaction is used (standalone deployments are
 * assumed), so there is a small consistency window if the process dies
 * between the task update and the history write.
 */
export async function updateTaskStatus({ taskId, teamId, newStatus, actorId, userId, requesterRole }) {
  assertMappedStatus(newStatus);

  const task = await Task.findById(taskId);
  if (!task) throw new Error('Task not found.');

  const isAdmin = requesterRole === 'admin';
  if (task.ownerId && userId != null && String(task.ownerId) !== String(userId) && !isAdmin) {
    throw new Error('Task does not belong to the current user.');
  }

  const sprint = teamId ? await Sprint.findById(teamId).lean() : (task.sprintId ? await Sprint.findById(task.sprintId).lean() : null);
  if (sprint && userId != null && String(sprint.ownerId) !== String(userId) && !isAdmin) {
    throw new Error('Team does not belong to the current user.');
  }

  const from = task.status;
  if (from === newStatus) return task; // no-op: never duplicate history.

  const now = new Date();
  applyStatusLifecycle(task, newStatus, now);
  await task.save();

  // History is written after the task update so a failed update never
  // leaves a phantom transition behind.
  const actor = actorId ?? userId;
  if (actor) {
    await TaskHistory.create({
      taskId: task._id,
      teamId: sprint ? sprint._id : (task.sprintId || null),
      from,
      to: newStatus,
      actorId: actor,
      at: now
    });
  }

  return task;
}

// Task creation goes through the same history-consistent path.
export async function createTaskWithHistory({ data, actorId, teamId }) {
  const now = new Date();
  const seed = { ...data, status: data.status || 'backlog', storyPoints: data.storyPoints || 0, updatedAt: now };
  // Tasks born in progress/done still get their lifecycle timestamps.
  applyStatusLifecycle(seed, seed.status, now);
  const task = await Task.create(seed);

  const initialHistory = actorId
    ? await TaskHistory.create({
        taskId: task._id,
        teamId: teamId ?? task.sprintId ?? null,
        from: null,
        to: task.status,
        actorId,
        at: now
      })
    : null;

  return { task, initialHistory };
}

export function isTaskStatusRecord(task, newStatus) {
  return task.status === newStatus;
}

// Reserved status categories used by reporting and the frontend.
export const STATUS_CATEGORIES = {
  todo: 'todo',
  inProgress: 'in-progress',
  done: 'done'
};

// Map of task statuses to their category. Used by analytics/reporting so
// grouping does not depend on UI labels.
export const STATUS_CATEGORY_MAP = Object.freeze(
  Object.fromEntries(ALLOWED_STATUSES.map((status) => [status, STATUS_CATEGORY[status]]))
);


