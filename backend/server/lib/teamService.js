// Team membership service ("team" == sprint in this codebase — the same
// mapping used by TaskHistory.teamId and the /api/teams routes).
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
import { EVENTS, emitEvent, isEventId } from './events.js';

let databaseReady = false;
export let memoryTeamMembers = [];

export function setDatabaseReady(value) {
  databaseReady = value;
}

const matches = (entry, teamId, memberId) =>
  String(entry.teamId) === String(teamId) && String(entry.memberId) === String(memberId);

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
 * Adds `memberId` to the team unless the membership already exists.
 * Returns `{ created, membership }` where `created` is false for duplicate
 * joins (no event is emitted in that case).
 */
export async function addTeamMember({ teamId, memberId, actorId }) {
  if (!isEventId(teamId) || !isEventId(memberId) || !isEventId(actorId)) {
    throw new Error('Invalid team, member, or actor id.');
  }
  const now = new Date();
  if (databaseReady) {
    const existing = await TeamMember.findOne({ teamId, memberId });
    if (existing) return { created: false, membership: existing };
    let membership;
    try {
      membership = await TeamMember.create({ teamId, memberId, addedBy: actorId, joinedAt: now });
    } catch (error) {
      // Unique-index race: a concurrent join won; report a no-op, no event.
      if (error?.code === 11000) {
        return { created: false, membership: await TeamMember.findOne({ teamId, memberId }) };
      }
      throw error;
    }
    emitMemberJoined({ teamId, memberId, actorId, at: now });
    return { created: true, membership };
  }
  const existing = memoryTeamMembers.find((entry) => matches(entry, teamId, memberId));
  if (existing) return { created: false, membership: existing };
  const membership = {
    _id: crypto.randomUUID(),
    teamId: String(teamId),
    memberId: String(memberId),
    addedBy: String(actorId),
    joinedAt: now,
    createdAt: now
  };
  memoryTeamMembers = [...memoryTeamMembers, membership];
  emitMemberJoined({ teamId, memberId, actorId, at: now });
  return { created: true, membership };
}

/**
 * Removes `memberId` from the team. Returns `{ removed }`; removing a
 * membership that does not exist is a no-op and emits no event.
 */
export async function removeTeamMember({ teamId, memberId, actorId }) {
  if (!isEventId(teamId) || !isEventId(memberId) || !isEventId(actorId)) {
    throw new Error('Invalid team, member, or actor id.');
  }
  const now = new Date();
  if (databaseReady) {
    const result = await TeamMember.deleteOne({ teamId, memberId });
    if (result.deletedCount !== 1) return { removed: false };
    emitMemberLeft({ teamId, memberId, actorId, at: now });
    return { removed: true };
  }
  const next = memoryTeamMembers.filter((entry) => !matches(entry, teamId, memberId));
  if (next.length === memoryTeamMembers.length) return { removed: false };
  memoryTeamMembers = next;
  emitMemberLeft({ teamId, memberId, actorId, at: now });
  return { removed: true };
}
