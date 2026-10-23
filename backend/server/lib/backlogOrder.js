// Product Backlog ordering.
//
// The Product Backlog is the set of tasks with no sprint assignment. The data model
// has no separate rank/score field, so the order is derived only from values that are
// already persisted:
//   1. explicit priority (urgent -> high -> medium -> low)
//   2. oldest first within a priority, so the longest-waiting work is surfaced first
//   3. task key, which is unique, so equal items cannot reshuffle between refreshes
//
// Missing or unknown priority is treated as the model default ("medium") and a missing
// createdAt sorts as the oldest possible value. Legacy rows therefore stay sortable
// instead of throwing.
export const PRIORITY_RANK = Object.freeze({ urgent: 0, high: 1, medium: 2, low: 3 });
const DEFAULT_PRIORITY_RANK = PRIORITY_RANK.medium;

export function priorityRank(priority) {
  return Object.hasOwn(PRIORITY_RANK, priority) ? PRIORITY_RANK[priority] : DEFAULT_PRIORITY_RANK;
}

function createdTime(task) {
  const time = task?.createdAt ? new Date(task.createdAt).getTime() : Number.NaN;
  return Number.isFinite(time) ? time : 0;
}

export function compareBacklogTasks(a, b) {
  const byPriority = priorityRank(a?.priority) - priorityRank(b?.priority);
  if (byPriority !== 0) return byPriority;
  const byAge = createdTime(a) - createdTime(b);
  if (byAge !== 0) return byAge;
  return String(a?.key ?? '').localeCompare(String(b?.key ?? ''));
}

export function sortBacklog(tasks = []) {
  return [...tasks].sort(compareBacklogTasks);
}
