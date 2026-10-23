// Unit checks for the centralized event system (lib/events.js): event-name
// constants, strict payload contracts, validation, and listener management.
// Everything here is database-free.
import assert from 'node:assert/strict';
import {
  EVENTS, EVENT_CONTRACTS, EventValidationError,
  emitEvent, onEvent, offEvent, removeAllEventListeners, listenerCount, isSupportedEvent, isEventId
} from './events.js';

let passed = 0;
function check(label, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

console.log('event system checks\n');

// ---- Event name constants ---------------------------------------------------

check('event constants carry the exact supported names', () => {
  assert.deepEqual(EVENTS, {
    TASK_CREATED: 'task.created',
    TASK_STATUS_CHANGED: 'task.status_changed',
    TASK_ASSIGNED: 'task.assigned',
    MEMBER_JOINED: 'member.joined',
    MEMBER_LEFT: 'member.left'
  });
  assert.ok(Object.isFrozen(EVENTS));
});

check('every event constant has a contract, and no others do', () => {
  assert.deepEqual(Object.keys(EVENT_CONTRACTS).sort(), Object.values(EVENTS).sort());
  for (const name of Object.values(EVENTS)) assert.ok(isSupportedEvent(name));
  assert.equal(isSupportedEvent('task.deleted'), false);
  assert.equal(isSupportedEvent('toString'), false, 'prototype keys are not events');
});

check('the shared emitter starts with zero listeners (no import side effects)', () => {
  for (const name of Object.values(EVENTS)) assert.equal(listenerCount(name), 0);
});

// ---- Valid payloads ----------------------------------------------------------

const validPayloads = {
  [EVENTS.TASK_CREATED]: { taskId: '653f1e2b9a4d2c0001abc123', teamId: '653f1e2b9a4d2c0001abc456', actorId: '653f1e2b9a4d2c0001abc789', at: new Date('2026-10-20T09:00:00Z') },
  [EVENTS.TASK_STATUS_CHANGED]: { taskId: '653f1e2b9a4d2c0001abc123', teamId: null, actorId: '653f1e2b9a4d2c0001abc789', from: 'todo', to: 'progress', at: new Date('2026-10-20T09:05:00Z') },
  [EVENTS.TASK_ASSIGNED]: { taskId: '653f1e2b9a4d2c0001abc123', teamId: '653f1e2b9a4d2c0001abc456', actorId: '653f1e2b9a4d2c0001abc789', assigneeId: '653f1e2b9a4d2c0001abc000', at: new Date('2026-10-20T09:10:00Z') },
  [EVENTS.MEMBER_JOINED]: { teamId: '653f1e2b9a4d2c0001abc456', memberId: '653f1e2b9a4d2c0001abc000', actorId: '653f1e2b9a4d2c0001abc789', at: new Date('2026-10-20T09:15:00Z') },
  [EVENTS.MEMBER_LEFT]: { teamId: '653f1e2b9a4d2c0001abc456', memberId: '653f1e2b9a4d2c0001abc000', actorId: '653f1e2b9a4d2c0001abc789', at: new Date('2026-10-20T09:20:00Z') }
};

check('a valid payload is accepted and delivered to the listener', () => {
  for (const [name, payload] of Object.entries(validPayloads)) {
    const seen = [];
    const off = onEvent(name, (delivered) => seen.push(delivered));
    try { emitEvent(name, { ...payload }); } finally { off(); }
    assert.equal(seen.length, 1, `${name} delivered once`);
    assert.deepEqual(seen[0], payload, `${name} payload passes through unchanged`);
  }
});

check('the delivered payload is a frozen copy, not the caller object', () => {
  const seen = [];
  const off = onEvent(EVENTS.TASK_CREATED, (delivered) => seen.push(delivered));
  try {
    const payload = { ...validPayloads[EVENTS.TASK_CREATED] };
    emitEvent(EVENTS.TASK_CREATED, payload);
    payload.taskId = 'mutated-after-emit';
  } finally { off(); }
  assert.ok(Object.isFrozen(seen[0]), 'delivered payload is frozen');
  assert.equal(seen[0].taskId, '653f1e2b9a4d2c0001abc123', 'later caller mutation does not leak into delivery');
});

check('memory-mode ids (UUIDs, mem-sprint-*) are accepted like ObjectIds', () => {
  assert.equal(isEventId('653f1e2b9a4d2c0001abc123'), true);
  assert.equal(isEventId('a1b2c3d4-e5f6-7890-abcd-ef1234567890'), true);
  assert.equal(isEventId('mem-sprint-1760000000000-1'), true);
  assert.equal(isEventId('short'), false);
  assert.equal(isEventId('has spaces here!!'), false);
  assert.equal(isEventId(42), false);
  assert.equal(isEventId(null), false);
});

// ---- Rejections: missing / malformed / unexpected ---------------------------

check('missing required fields are rejected', () => {
  for (const [name, payload] of Object.entries(validPayloads)) {
    const field = Object.keys(payload)[0];
    const incomplete = { ...payload };
    delete incomplete[field];
    assert.throws(() => emitEvent(name, incomplete), EventValidationError, `${name} without ${field}`);
  }
  assert.throws(() => emitEvent(EVENTS.TASK_STATUS_CHANGED, { ...validPayloads[EVENTS.TASK_STATUS_CHANGED], from: undefined }), EventValidationError);
});

check('malformed ids are rejected where required', () => {
  const payload = { ...validPayloads[EVENTS.TASK_ASSIGNED] };
  for (const field of ['taskId', 'teamId', 'actorId', 'assigneeId']) {
    const broken = { ...payload, [field]: 'not a valid id!' };
    assert.throws(() => emitEvent(EVENTS.TASK_ASSIGNED, broken), EventValidationError, `task.assigned with bad ${field}`);
  }
  assert.throws(() => emitEvent(EVENTS.MEMBER_JOINED, { ...validPayloads[EVENTS.MEMBER_JOINED], memberId: 'x' }), EventValidationError);
});

check('teamId must be present (null allowed) on task events', () => {
  const withoutTeam = { ...validPayloads[EVENTS.TASK_CREATED] };
  delete withoutTeam.teamId;
  assert.throws(() => emitEvent(EVENTS.TASK_CREATED, withoutTeam), EventValidationError);
  assert.throws(() => emitEvent(EVENTS.MEMBER_JOINED, { ...validPayloads[EVENTS.MEMBER_JOINED], teamId: null }), EventValidationError, 'member events require a real team');
});

check('invalid task statuses are rejected', () => {
  for (const field of ['from', 'to']) {
    const payload = { ...validPayloads[EVENTS.TASK_STATUS_CHANGED] };
    payload[field] = 'doing';
    assert.throws(() => emitEvent(EVENTS.TASK_STATUS_CHANGED, payload), EventValidationError, `status_changed with bad ${field}`);
  }
  assert.throws(() => emitEvent(EVENTS.TASK_STATUS_CHANGED, { ...validPayloads[EVENTS.TASK_STATUS_CHANGED], from: 5 }), EventValidationError);
});

check('invalid timestamps are rejected', () => {
  for (const bad of ['2026-10-20T09:00:00Z', null, new Date('nonsense'), 1760000000000]) {
    assert.throws(() => emitEvent(EVENTS.TASK_CREATED, { ...validPayloads[EVENTS.TASK_CREATED], at: bad }), EventValidationError, `at = ${String(bad)}`);
  }
});

check('unexpected extra fields are rejected', () => {
  assert.throws(() => emitEvent(EVENTS.TASK_CREATED, { ...validPayloads[EVENTS.TASK_CREATED], extra: 1 }), EventValidationError);
  assert.throws(() => emitEvent(EVENTS.MEMBER_LEFT, { ...validPayloads[EVENTS.MEMBER_LEFT], note: 'why' }), EventValidationError);
});

check('non-object payloads are rejected', () => {
  for (const bad of [null, undefined, 'task.created', 7, ['taskId']]) {
    assert.throws(() => emitEvent(EVENTS.TASK_CREATED, bad), EventValidationError);
  }
});

check('unsupported event names are rejected for emit and subscribe', () => {
  assert.throws(() => emitEvent('task.deleted', validPayloads[EVENTS.TASK_CREATED]), EventValidationError);
  assert.throws(() => emitEvent('__proto__', {}), EventValidationError);
  assert.throws(() => onEvent('task.deleted', () => {}), EventValidationError);
  assert.throws(() => offEvent('task.deleted', () => {}), EventValidationError);
  assert.throws(() => removeAllEventListeners('task.deleted'), EventValidationError);
  assert.throws(() => onEvent(EVENTS.TASK_CREATED, 'not a function'), EventValidationError);
});

check('invalid payloads never reach listeners', () => {
  const seen = [];
  const off = onEvent(EVENTS.TASK_CREATED, (payload) => seen.push(payload));
  try {
    assert.throws(() => emitEvent(EVENTS.TASK_CREATED, { taskId: '653f1e2b9a4d2c0001abc123' }), EventValidationError);
  } finally { off(); }
  assert.equal(seen.length, 0);
});

// ---- Listener management ----------------------------------------------------

check('onEvent returns an unsubscribe handle; offEvent also works', () => {
  const seen = [];
  const off = onEvent(EVENTS.MEMBER_JOINED, (payload) => seen.push(payload));
  emitEvent(EVENTS.MEMBER_JOINED, { ...validPayloads[EVENTS.MEMBER_JOINED] });
  off();
  emitEvent(EVENTS.MEMBER_JOINED, { ...validPayloads[EVENTS.MEMBER_JOINED] });
  assert.equal(seen.length, 1, 'unsubscribe stops delivery');

  const off2 = onEvent(EVENTS.MEMBER_JOINED, (payload) => seen.push(payload));
  emitEvent(EVENTS.MEMBER_JOINED, { ...validPayloads[EVENTS.MEMBER_JOINED] });
  offEvent(EVENTS.MEMBER_JOINED, () => {});
  assert.equal(seen.length, 2, 'offEvent with an unknown listener is a no-op');
  off2();
  assert.equal(listenerCount(EVENTS.MEMBER_JOINED), 0);
});

check('removeAllEventListeners clears one event only', () => {
  const joined = [];
  const left = [];
  const offJoined = onEvent(EVENTS.MEMBER_JOINED, (p) => joined.push(p));
  const offLeft = onEvent(EVENTS.MEMBER_LEFT, (p) => left.push(p));
  try {
    removeAllEventListeners(EVENTS.MEMBER_JOINED);
    assert.equal(listenerCount(EVENTS.MEMBER_JOINED), 0);
    assert.equal(listenerCount(EVENTS.MEMBER_LEFT), 1, 'other events untouched');
    emitEvent(EVENTS.MEMBER_LEFT, { ...validPayloads[EVENTS.MEMBER_LEFT] });
    assert.equal(left.length, 1);
  } finally { offJoined(); offLeft(); }
});

check('a throwing listener does not crash emitEvent or block other listeners', () => {
  const seen = [];
  const offBad = onEvent(EVENTS.TASK_ASSIGNED, () => { throw new Error('listener boom'); });
  const offGood = onEvent(EVENTS.TASK_ASSIGNED, (payload) => seen.push(payload));
  const originalError = console.error;
  console.error = () => {}; // silence the expected containment log
  try {
    emitEvent(EVENTS.TASK_ASSIGNED, { ...validPayloads[EVENTS.TASK_ASSIGNED] });
  } finally {
    console.error = originalError;
    offBad();
    offGood();
  }
  assert.equal(seen.length, 1, 'remaining listeners still observe the event');
  assert.equal(listenerCount(EVENTS.TASK_ASSIGNED), 0);
});

console.log(`\n${passed} event system checks passed.`);

