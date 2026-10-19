import { Task } from '../models/Task.js';
import { User } from '../models/User.js';

export const ALLOWED_STATUSES = ['backlog', 'todo', 'progress', 'review', 'done'];

export const STATUS_CATEGORY = {
  backlog: 'todo',
  todo: 'todo',
  progress: 'in-progress',
  review: 'in-progress',
  done: 'done'
};

export function assertMappedStatus(status) {
  if (!ALLOWED_STATUSES.includes(status)) {
    throw new Error(`Unmapped status: ${status}`);
  }
}

export function statusCategory(status) {
  assertMappedStatus(status);
  return STATUS_CATEGORY[status];
}

export async function resolveAssignee(value) {
  if (value === null || value === undefined || value === '' || String(value).trim() === 'Unassigned') {
    return null;
  }
  const text = String(value).trim();
  if (!text) return null;

  const normalized = text.toLowerCase();
  const byEmail = await User.findOne({ email: normalized });
  if (byEmail) return byEmail._id.toString();

  const byName = await User.findOne({ name: text });
  if (byName) return byName._id.toString();

  return null;
}

export async function migrateTaskAssignee(task) {
  const result = { resolved: 0, unresolved: 0, kept: 0 };

  // Already migrated: leave the resolved id untouched (idempotent re-runs).
  if (task.assigneeId !== undefined && task.assigneeId !== null && task.assigneeId !== '') {
    result.resolved = 1;
    return result;
  }

  const assignee = task.assignee;
  if (assignee === undefined || assignee === null || assignee === '') {
    result.kept = 1;
    return result;
  }

  const resolved = await resolveAssignee(assignee);
  if (resolved) {
    task.assigneeId = resolved;
    result.resolved = 1;
  } else {
    // Keep the legacy display text so the UI still shows a name; it simply
    // has no resolved assigneeId. The case is reported as "unresolved".
    result.unresolved = 1;
  }
  return result;
}

const MIGRATION_REFERENCE_DATE = '2026-10-19';

function isoToDate(iso) {
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function monthToIndex(month) {
  const map = {
    Jan: 1,
    Feb: 2,
    Mar: 3,
    Apr: 4,
    May: 5,
    Jun: 6,
    Jul: 7,
    Aug: 8,
    Sep: 9,
    Oct: 10,
    Nov: 11,
    Dec: 12
  };
  const value = map[month];
  if (!value) throw new Error(`Unmapped month in due date: ${month}`);
  return value;
}

function resolveSep28Date(taskDate, todayIso) {
  const m = /^([A-Z][a-z]{2})\s+(\d{1,2})$/.exec(taskDate.trim());
  if (!m) return null;
  const month = m[1];
  const day = parseInt(m[2], 10);

  const today = new Date(`${todayIso}T00:00:00Z`);
  for (let i = 0; i <= 4; i += 1) {
    // Construct in UTC so the result does not drift with the server timezone.
    const candidate = new Date(Date.UTC(today.getUTCFullYear() + i, monthToIndex(month) - 1, day));
    if (candidate.getTime() >= today.getTime()) {
      return candidate;
    }
  }
  return null;
}

export function convertDueDate(legacy, todayIso = MIGRATION_REFERENCE_DATE) {
  if (legacy === null || legacy === undefined) return { date: null, reason: null };
  if (legacy instanceof Date) return { date: legacy, reason: null };

  const text = String(legacy).trim();

  if (text === '') return { date: null, reason: null };

  if (text === 'Unscheduled' || text === 'UNSCHEDULED') {
    return { date: null, reason: null };
  }

  if (text === 'Today') {
    return { date: new Date(`${todayIso}T00:00:00Z`), reason: null };
  }

  const isoDate = isoToDate(text);
  if (isoDate) return { date: isoDate, reason: null };

  const resolved = resolveSep28Date(text, todayIso);
  if (resolved) return { date: resolved, reason: null };

  return { date: null, reason: `cannot parse: ${text}` };
}

export async function migrateLegacyFields() {
  const tasks = await Task.find({}).lean();
  const report = {
    startedAt: new Date().toISOString(),
    assigned: { resolved: 0, unresolved: 0, kept: 0 },
    due: { converted: 0, flagged: 0, unchanged: 0 },
    updated: 0,
    unchanged: 0,
    total: tasks.length
  };

  for (const task of tasks) {
    const assignResult = await migrateTaskAssignee(task);
    report.assigned[assignResult.resolved ? 'resolved' : assignResult.unresolved ? 'unresolved' : 'kept'] += 1;

    const alreadyDated = task.dueDate instanceof Date;
    const due = convertDueDate(task.dueDate);
    if (alreadyDated) {
      report.due.unchanged += 1;
    } else if (due.reason) {
      report.due.flagged += 1;
    } else if (due.date === null && task.dueDate !== undefined && task.dueDate !== null && task.dueDate !== '') {
      report.due.unchanged += 1;
    } else {
      report.due.converted += 1;
    }

    const patched = {};
    if (assignResult.resolved && task.assigneeId) patched.assigneeId = task.assigneeId;
    if (!alreadyDated && due.date !== null) patched.dueDate = due.date;

    if (Object.keys(patched).length) {
      await Task.updateOne({ _id: task._id }, { $set: patched });
      report.updated += 1;
    } else {
      report.unchanged += 1;
    }
  }

  report.endedAt = new Date().toISOString();
  return report;
}
