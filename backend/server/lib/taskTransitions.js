// Rules for moving work between the Product Backlog and a sprint.
//
// Product Backlog -> To Do and To Do -> Product Backlog are the only two edges that
// cross the sprint boundary, and both are handled by the sprint task endpoints. Once a
// task is inside a sprint its status may advance one stage at a time:
//
//   To Do -> In Progress -> Review -> Done
//                    Review -> In Progress
//
// Done is terminal, so a finished task is never silently reopened and no stage is
// skipped. Tasks that are not assigned to a sprint keep the board's existing behaviour.
import { sprintState } from './sprintDates.js';

export const BACKLOG_STATUS = 'backlog';
export const SPRINT_ENTRY_STATUS = 'todo';

const SPRINT_TRANSITIONS = Object.freeze({
  todo: ['progress'],
  progress: ['review'],
  review: ['progress', 'done'],
  done: []
});

const STATUS_LABELS = Object.freeze({
  backlog: 'Product Backlog',
  todo: 'To Do',
  progress: 'In Progress',
  review: 'Review',
  done: 'Done'
});

export function statusLabel(status) {
  return STATUS_LABELS[status] || status;
}

// Only used for a task that already belongs to a sprint; the crossing edges are
// enforced separately by the sprint assignment endpoints.
export function isPermittedSprintStatusChange(from, to) {
  if (from === to) return true;
  return (SPRINT_TRANSITIONS[from] || []).includes(to);
}

// Returns a sanitized reason when the sprint cannot accept the task, or null when it can.
export function sprintAcceptsBacklogItem(sprint, task) {
  if (!sprint) return 'Sprint not found.';
  if (task.sprintId) return 'This task is already assigned to a sprint.';
  if (!sprint.boardId) {
    return 'This sprint is not assigned to a board.';
  }
  if (String(sprint.boardId) !== String(task.boardId || '')) {
    return 'This sprint belongs to a different project.';
  }
  if (sprintState(sprint.startDate, sprint.endDate) !== 'active') {
    return 'Only an active sprint can accept Product Backlog items.';
  }
  return null;
}

// Returns a sanitized reason when the task cannot leave its sprint, or null when it can.
export function taskCanReturnToBacklog(task) {
  if (task.status !== SPRINT_ENTRY_STATUS) {
    return `Only ${statusLabel(SPRINT_ENTRY_STATUS)} tasks can return to the Product Backlog.`;
  }
  return null;
}
