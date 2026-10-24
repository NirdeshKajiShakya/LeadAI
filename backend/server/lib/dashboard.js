// Home dashboard helpers.
//
// The dashboard is a read-only summary. Every rule that decides "is this mine?",
// "is it overdue?" and "which task deserves attention first?" lives here so the
// API and its tests share one definition.
import { priorityRank } from './backlogOrder.js';
import { isValidIsoDate, sprintState, todayIsoDate } from './sprintDates.js';

export const PRIORITY_TASK_LIMIT = 6;
export const BOARD_SUMMARY_LIMIT = 4;

// A finished task is never "open" and can never be overdue.
export function isOpenTask(task) {
  return Boolean(task) && task.status !== 'done';
}

// MongoDB stores dueDate as a Date while the UI and these rules speak
// YYYY-MM-DD, so both shapes normalise through here. Free-text legacy values
// are ignored: only a real calendar date can be compared with today.
export function dueDateText(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10);
  return typeof value === 'string' ? value : '';
}

export function isOverdueTask(task, today = todayIsoDate()) {
  if (!isOpenTask(task)) return false;
  const due = dueDateText(task.dueDate);
  return isValidIsoDate(due) && isValidIsoDate(today) && due < today;
}

// Assignees are stored as board member names (falling back to the account email
// for legacy rows). "Unassigned" is a display value, not a person.
export function taskBelongsTo(task, names) {
  const assignee = String(task?.assignee || '').trim();
  if (!assignee || assignee.toLowerCase() === 'unassigned') return false;
  return names.some((name) => String(name || '').trim() === assignee);
}

function createdTime(task) {
  const time = task?.createdAt ? new Date(task.createdAt).getTime() : Number.NaN;
  return Number.isFinite(time) ? time : 0;
}

function dueDateOf(task) {
  const due = dueDateText(task?.dueDate);
  return isValidIsoDate(due) ? due : null;
}

// Attention order, highest first:
//   1. overdue work
//   2. priority (urgent -> high -> medium -> low)
//   3. the nearest real calendar due date (undated work last)
//   4. oldest first, then the task key, so the list never reshuffles randomly.
export function compareDashboardTasks(a, b, today = todayIsoDate()) {
  const overdue = Number(isOverdueTask(a, today)) - Number(isOverdueTask(b, today));
  if (overdue !== 0) return -overdue;

  const byPriority = priorityRank(a?.priority) - priorityRank(b?.priority);
  if (byPriority !== 0) return byPriority;

  const dueA = dueDateOf(a);
  const dueB = dueDateOf(b);
  if (dueA !== dueB) {
    if (dueA && !dueB) return -1;
    if (!dueA && dueB) return 1;
    if (dueA < dueB) return -1;
    if (dueA > dueB) return 1;
  }

  const byAge = createdTime(a) - createdTime(b);
  if (byAge !== 0) return byAge;
  return String(a?.key ?? '').localeCompare(String(b?.key ?? ''));
}

export function orderDashboardTasks(tasks = [], today = todayIsoDate()) {
  return [...tasks].sort((a, b) => compareDashboardTasks(a, b, today));
}

export function stageCounts(tasks = []) {
  const counts = { backlog: 0, todo: 0, progress: 0, review: 0, done: 0 };
  for (const task of tasks) {
    if (Object.hasOwn(counts, task?.status)) counts[task.status] += 1;
  }
  return counts;
}

function endDateOf(sprint) {
  return isValidIsoDate(sprint?.endDate) ? sprint.endDate : '9999-12-31';
}

// A user can own several sprints. The dashboard shows the one that ends first,
// because that is the sprint that needs attention now.
export function activeSprintsOf(sprints = [], today = todayIsoDate()) {
  return sprints
    .filter((sprint) => sprintState(sprint?.startDate, sprint?.endDate, today) === 'active')
    .sort((a, b) => endDateOf(a).localeCompare(endDateOf(b)) || String(a?.name || '').localeCompare(String(b?.name || '')));
}

export function mostRelevantActiveSprint(sprints = [], today = todayIsoDate()) {
  return activeSprintsOf(sprints, today)[0] || null;
}

export function numberOf(value) {
  return Number.isFinite(value) ? value : 0;
}
