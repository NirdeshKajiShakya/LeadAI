// Mirrors backend/server/lib/sprintDates.js. Sprint boundaries are calendar days,
// so dates are handled as plain YYYY-MM-DD values and never shifted by a timezone.
export const SPRINT_DURATION_DAYS = 14;

const MS_PER_DAY = 86400000;

export function isCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function addDays(iso, days) {
  const parsed = new Date(`${iso}T00:00:00Z`);
  return new Date(parsed.getTime() + days * MS_PER_DAY).toISOString().slice(0, 10);
}

export function endDateForStart(startIso) {
  return addDays(startIso, SPRINT_DURATION_DAYS - 1);
}

export function formatDateRange(startIso, endIso) {
  const format = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `${format(startIso)} - ${format(endIso)}`;
}