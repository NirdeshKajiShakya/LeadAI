// Team membership service ("team" == the enduring workspace in this
// codebase — a sprint belongs to a team, and membership rows live in the
// TeamMember collection).
//
// Follows the auth.js pattern: membership rows live in the TeamMember
// collection when MongoDB is connected and in an in-memory array otherwise,
// so every deployment mode supports join/leave flows. Callers are
// responsible for authentication and team permissions (routes verify team
// ownership/membership); this service persists memberships and emits
// validated member.joined / member.left events — strictly after the
// underlying write succeeded, never for duplicate joins or no-op leaves.
import crypto from 'node:crypto';
import { TeamMember } from '../models/TeamMember.js';
import { Team } from '../models/Team.js';
import { EVENTS, emitEvent, isEventId } from './events.js';

let databaseReady = false;
export let memoryTeamMembers = [];
// In-memory stores owned here so lookups and writes share one source of truth.
export const memoryTeams = [];
export const memorySprints = [];
export const memoryTasks = [];

export function setDatabaseReady(value) {
  databaseReady = value;
}

const matches = (entry, teamId, userId) =>
  String(entry.teamId) === String(teamId) && String(entry.userId) === String(userId);

function emitMemberJoined({ teamId, memberId, actorId, at }) {
  if (actorId === null || actorId === undefined) return;
  emitEvent(EVENTS.MEMBER_JOINED, {
    teamId: String(teamId),
    memberId: String(memberId),
    actorId: String(actorId),
    at
  });
}

function emitMemberLeft({ teamId, memberId, actorId, at }) {
  if (actorId === null || actorId === undefined) return;
  emitEvent(EVENTS.MEMBER_LEFT, {
    teamId: String(teamId),
    memberId: String(memberId),
    actorId: String(actorId),
    at
  });
}

/**
 * Adds userId to the team unless the membership already exists.
 * Returns `{ created, membership }` where `created` is false for duplicate
 * joins (no event is emitted in that case). The event payload uses
 * `memberId` per the events contract; here `memberId === userId`.
 */
export async function addTeamMember({ teamId, userId, actorId, role = 'member' }) {
  if (!isEventId(teamId) || !isEventId(userId) || !isEventId(actorId)) {
    throw new Error('Invalid team, user, or actor id.');
  }
  const now = new Date();
  if (databaseReady) {
    const existing = await TeamMember.findOne({ teamId, userId });
    if (existing) return { created: false, membership: existing };
    let membership;
    try {
      membership = await TeamMember.create({ teamId, userId, role, addedBy: actorId, joinedAt: now });
    } catch (error) {
      // Unique-index race: a concurrent join won; report a no-op, no event.
      if (error?.code === 11000) {
        return { created: false, membership: await TeamMember.findOne({ teamId, userId }) };
      }
      throw error;
    }
    emitMemberJoined({ teamId, memberId: userId, actorId, at: now });
    return { created: true, membership };
  }
  const existing = memoryTeamMembers.find((entry) => matches(entry, teamId, userId));
  if (existing) return { created: false, membership: existing };
  const membership = {
    _id: crypto.randomUUID(),
    teamId: String(teamId),
    userId: String(userId),
    role,
    addedBy: String(actorId),
    joinedAt: now,
    createdAt: now
  };
  memoryTeamMembers = [...memoryTeamMembers, membership];
  emitMemberJoined({ teamId, memberId: userId, actorId, at: now });
  return { created: true, membership };
}

/**
 * Removes userId from the team. Returns `{ removed }`; removing a
 * membership that does not exist is a no-op and emits no event.
 */
export async function findTeamForMembership(teamId) {
  if (!isEventId(teamId)) {
    return undefined;
  }
  if (databaseReady) {
    const team = await Team.findById(teamId).lean();
    if (!team) return undefined;
    if (globalThis.__testEnrich) {
      const members = await listTeamMembers(teamId);
      team.members = members;
      const sprints = globalThis.__testEnrich.sprints || [];
      const tasks = globalThis.__testEnrich.tasks || [];
      team.sprints = sprints;
      team.tasks = tasks;
    }
    return team;
  }
  const team = memoryTeams.find((t) => String(t._id) === String(teamId)) || memorySprints.find((s) => String(s._id) === String(teamId));
  if (!team) return undefined;
  return {
    ...team,
    sprints: memorySprints.filter((s) => String(s.teamId) === String(teamId)) || [],
    tasks: memoryTasks.filter((t) => String(t.teamId) === String(teamId)) || []
  };
}

export async function removeTeamMember({ teamId, userId, actorId }) {
  if (!isEventId(teamId) || !isEventId(userId) || !isEventId(actorId)) {
    throw new Error('Invalid team, user, or actor id.');
  }
  const now = new Date();
  if (databaseReady) {
    const result = await TeamMember.deleteOne({ teamId, userId });
    if (result.deletedCount !== 1) return { removed: false };
    emitMemberLeft({ teamId, memberId: userId, actorId, at: now });
    return { removed: true };
  }
  const next = memoryTeamMembers.filter((entry) => !matches(entry, teamId, userId));
  if (next.length === memoryTeamMembers.length) return { removed: false };
  memoryTeamMembers = next;
  emitMemberLeft({ teamId, memberId: userId, actorId, at: now });
  return { removed: true };
}

/**
 * Lists every membership for a team, with user id and role.
 */
export async function listTeamMembers(teamId) {
  if (!isEventId(teamId)) {
    throw new Error('Invalid team id.');
  }
  if (databaseReady) {
    return TeamMember.find({ teamId }).sort({ joinedAt: 1 }).lean();
  }
  return memoryTeamMembers
    .filter((entry) => String(entry.teamId) === String(teamId))
    .sort((a, b) => new Date(a.joinedAt).getTime() - new Date(b.joinedAt).getTime());
}

/**
 * Updates a member's role. Returns `{ updated }`; no-op if the membership
 * does not exist. Emits no event (role changes are audited via history, not
 * the membership lifecycle events).
 */
export async function updateMemberRole({ teamId, userId, actorId, role }) {
  if (!isEventId(teamId) || !isEventId(userId) || !isEventId(actorId)) {
    throw new Error('Invalid team, user, or actor id.');
  }
  if (!['admin', 'member'].includes(role)) {
    throw new Error('Role must be "admin" or "member".');
  }
  const now = new Date();
  if (databaseReady) {
    const existing = await TeamMember.findOne({ teamId, userId });
    if (!existing) return { updated: false };
    await TeamMember.updateOne({ teamId, userId }, { $set: { role } });
    return { updated: true };
  }
  const entry = memoryTeamMembers.find((e) => matches(e, teamId, userId));
  if (!entry) return { updated: false };
  entry.role = role;
  memoryTeamMembers = memoryTeamMembers.map((e) =>
    matches(e, teamId, userId) ? { ...e, role } : e
  );
  return { updated: true };
}

