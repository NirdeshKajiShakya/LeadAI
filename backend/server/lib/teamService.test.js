// Unit checks for the team membership service (lib/teamService.js) in its
// in-memory mode: join/leave persistence semantics and the member.joined /
// member.left events, which must fire only for real membership changes.
import assert from 'node:assert/strict';
import { addTeamMember, removeTeamMember, memoryTeamMembers, setDatabaseReady } from './teamService.js';
import { EVENTS, onEvent, listenerCount } from './events.js';

let passed = 0;
async function check(label, fn) {
  await fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

const TEAM = 'team-id-00000001';
const MEMBER = 'user-id-00000001';
const OTHER_MEMBER = 'user-id-00000002';
const ACTOR = 'user-id-00000009';

console.log('team membership service checks\n');

// The service must default to memory mode in tests (no Mongo connection).
setDatabaseReady(false);

await check('adding a member persists the membership', async () => {
  let joined = 0;
  const off = onEvent(EVENTS.MEMBER_JOINED, () => { joined += 1; });
  try {
    const { created, membership } = await addTeamMember({ teamId: TEAM, memberId: MEMBER, actorId: ACTOR });
    assert.equal(created, true);
    assert.equal(String(membership.teamId), TEAM);
    assert.equal(String(membership.memberId), MEMBER);
    assert.equal(memoryTeamMembers.length, 1);
  } finally { off(); }
  assert.equal(joined, 1, 'member.joined emitted exactly once');
});

await check('adding the same member again is a no-op with no duplicate event', async () => {
  const before = memoryTeamMembers.length;
  let seenCount = 0;
  const off = onEvent(EVENTS.MEMBER_JOINED, () => { seenCount += 1; });
  try {
    const { created } = await addTeamMember({ teamId: TEAM, memberId: MEMBER, actorId: ACTOR });
    assert.equal(created, false);
    assert.equal(memoryTeamMembers.length, before, 'no second membership row');
  } finally { off(); }
  assert.equal(seenCount, 0);
});

await check('a failed join (invalid ids) throws and emits nothing', async () => {
  let seenCount = 0;
  const off = onEvent(EVENTS.MEMBER_JOINED, () => { seenCount += 1; });
  try {
    await assert.rejects(() => addTeamMember({ teamId: TEAM, memberId: 'x', actorId: ACTOR }), /Invalid team, member, or actor id/);
    await assert.rejects(() => addTeamMember({ teamId: 'x', memberId: MEMBER, actorId: ACTOR }), /Invalid team, member, or actor id/);
    await assert.rejects(() => addTeamMember({ teamId: TEAM, memberId: OTHER_MEMBER, actorId: '' }), /Invalid team, member, or actor id/);
  } finally { off(); }
  assert.equal(seenCount, 0);
  assert.equal(memoryTeamMembers.length, 1, 'failed joins leave state untouched');
});

await check('removing a member deletes the membership and emits member.left once', async () => {
  let joined = 0;
  let left = 0;
  const offJoined = onEvent(EVENTS.MEMBER_JOINED, () => { joined += 1; });
  const offLeft = onEvent(EVENTS.MEMBER_LEFT, () => { left += 1; });
  try {
    const { removed } = await removeTeamMember({ teamId: TEAM, memberId: MEMBER, actorId: ACTOR });
    assert.equal(removed, true);
    assert.equal(memoryTeamMembers.length, 0);
  } finally { offJoined(); offLeft(); }
  assert.equal(joined, 0);
  assert.equal(left, 1);
});

await check('removing a nonexistent membership is a no-op with no false leave event', async () => {
  let left = 0;
  const off = onEvent(EVENTS.MEMBER_LEFT, () => { left += 1; });
  try {
    const { removed } = await removeTeamMember({ teamId: TEAM, memberId: MEMBER, actorId: ACTOR });
    assert.equal(removed, false);
  } finally { off(); }
  assert.equal(left, 0);
  assert.equal(memoryTeamMembers.length, 0);
});

await check('join/leave payloads carry the exact contract fields', async () => {
  const seen = [];
  const off = onEvent(EVENTS.MEMBER_JOINED, (payload) => seen.push(payload));
  try {
    await addTeamMember({ teamId: TEAM, memberId: OTHER_MEMBER, actorId: ACTOR });
  } finally { off(); }
  assert.equal(seen.length, 1);
  const payload = seen[0];
  assert.deepEqual(Object.keys(payload).sort(), ['actorId', 'at', 'memberId', 'teamId']);
  assert.equal(payload.teamId, TEAM);
  assert.equal(payload.memberId, OTHER_MEMBER);
  assert.equal(payload.actorId, ACTOR);
  assert.ok(payload.at instanceof Date && !Number.isNaN(payload.at.getTime()));
  // Clean up so later files/tests never inherit this membership.
  await removeTeamMember({ teamId: TEAM, memberId: OTHER_MEMBER, actorId: ACTOR });
});

check('no listeners leak after the membership checks', () => {
  assert.equal(listenerCount(EVENTS.MEMBER_JOINED), 0);
  assert.equal(listenerCount(EVENTS.MEMBER_LEFT), 0);
  assert.equal(memoryTeamMembers.length, 0);
});

console.log(`\n${passed} team membership service checks passed.`);
