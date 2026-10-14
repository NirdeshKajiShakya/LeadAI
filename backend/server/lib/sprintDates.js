// Calendar-day helpers for sprint planning.
//
// Sprint dates are stored and compared as plain 'YYYY-MM-DD' strings and parsed as
// UTC midnight. Mixing UTC timestamps with local calendar dates is what produces
// off-by-one sprint days, so we never convert a sprint boundary to local time.
export const SPRINT_DURATION_DAYS = 14;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86400000;

export function isValidIsoDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function toIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

// Today in the server's local calendar, which is what a user sees on their screen.
export function todayIsoDate(now = new Date()) {
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

export function parseIsoDate(value) {
  return isValidIsoDate(value) ? new Date(`${value}T00:00:00Z`) : null;
}

export function diffCalendarDays(fromIso, toIso) {
  const from = parseIsoDate(fromIso);
  const to = parseIsoDate(toIso);
  if (!from || !to) return null;
  return Math.round((to.getTime() - from.getTime()) / MS_PER_DAY);
}

export function addDays(iso, days) {
  const parsed = parseIsoDate(iso);
  if (!parsed) return null;
  return toIsoDate(new Date(parsed.getTime() + days * MS_PER_DAY));
}

// An inclusive 14-day sprint starts at startDate and ends 13 days later.
export function endDateForStart(startIso) {
  return addDays(startIso, SPRINT_DURATION_DAYS - 1);
}

export function validateSprintRange(startIso, endIso) {
  if (!isValidIsoDate(startIso)) return { ok: false, error: 'Start date must be a valid YYYY-MM-DD date.' };
  if (endIso !== undefined && endIso !== null && endIso !== '' && !isValidIsoDate(endIso)) {
    return { ok: false, error: 'End date must be a valid YYYY-MM-DD date.' };
  }
  const durationDays = diffCalendarDays(startIso, endIso ?? endDateForStart(startIso));
  if (durationDays < 0) return { ok: false, error: 'End date must be on or after the start date.' };
  if (durationDays !== SPRINT_DURATION_DAYS - 1) {
    return { ok: false, error: `A sprint runs for ${SPRINT_DURATION_DAYS} calendar days.` };
  }
  return { ok: true, durationDays: durationDays + 1 };
}

// The sprint's own first calendar day is Day 1, never Day 0.
export function computeSprintDay(startIso, endIso, todayIso = todayIsoDate()) {
  const elapsed = diffCalendarDays(startIso, todayIso);
  if (elapsed === null) return null;
  const duration = validateSprintRange(startIso, endIso);
  if (!duration.ok) return null;
  const day = elapsed + 1;
  if (day < 1) return { day: 0, total: SPRINT_DURATION_DAYS, remaining: SPRINT_DURATION_DAYS, state: 'upcoming' };
  if (day > SPRINT_DURATION_DAYS) return { day: SPRINT_DURATION_DAYS, total: SPRINT_DURATION_DAYS, remaining: 0, state: 'completed' };
  return { day, total: SPRINT_DURATION_DAYS, remaining: SPRINT_DURATION_DAYS - day, state: 'active' };
}

export function sprintState(startIso, endIso, todayIso = todayIsoDate()) {
  return computeSprintDay(startIso, endIso, todayIso)?.state ?? 'upcoming';
}

export function formatDateRange(startIso, endIso) {
  if (!isValidIsoDate(startIso) || !isValidIsoDate(endIso)) return '';
  const format = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `${format(startIso)} - ${format(endIso)}`;
}

// Sprint progress is committed work, not a stored value: completed story points
// over total committed story points. Empty sprints report 0 instead of NaN.
export function summarizeTasks(tasks = []) {
  const totalStoryPoints = tasks.reduce((sum, task) => sum + (Number(task.storyPoints) || 0), 0);
  const completedStoryPoints = tasks
    .filter((task) => task.status === 'done')
    .reduce((sum, task) => sum + (Number(task.storyPoints) || 0), 0);
  const progressPercent = totalStoryPoints > 0 ? Math.round((completedStoryPoints / totalStoryPoints) * 100) : 0;
  return {
    total: tasks.length,
    completed: tasks.filter((task) => task.status === 'done').length,
    totalStoryPoints,
    completedStoryPoints,
    remainingStoryPoints: totalStoryPoints - completedStoryPoints,
    progressPercent
  };
}