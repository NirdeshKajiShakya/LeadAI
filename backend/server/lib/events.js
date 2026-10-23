// Centralized in-process event system built on Node's built-in `events`
// module (no third-party emitter dependency).
//
// Design:
//  - Exactly one EventEmitter instance is created here, at module load. ESM
//    module caching guarantees every service shares that same instance no
//    matter how often it is imported.
//  - Event names are declared once in `EVENTS`; consumers import the
//    constants instead of repeating raw strings.
//  - Every event has a strict payload contract (`EVENT_CONTRACTS`). Payloads
//    are validated at runtime *before* any listener runs: missing fields,
//    malformed fields, and unexpected extra fields are all rejected with an
//    `EventValidationError`.
//  - Listeners register through the controlled API (`onEvent`, `offEvent`,
//    `removeAllEventListeners`); the raw emitter is not exported, so nothing
//    can bypass validation via `emitter.emit`.
//
// Delivery semantics (intentional limitation): this is a lightweight,
// best-effort, in-process event bus. Emission is synchronous; listeners run
// during the emitting request; events are not persisted and are lost if the
// process crashes. Guaranteed delivery across crashes would require a
// transactional outbox or similar infrastructure, which the current
// requirements do not call for.

import { EventEmitter } from 'node:events';
import { ALLOWED_STATUSES } from './taskMigration.js';
import mongoose from 'mongoose';

// The single shared emitter for the whole application.
const emitter = new EventEmitter();

// Every event name the application supports. Keep these strings stable:
// listeners and tests match on them.
export const EVENTS = Object.freeze({
  TASK_CREATED: 'task.created',
  TASK_STATUS_CHANGED: 'task.status_changed',
  TASK_ASSIGNED: 'task.assigned',
  MEMBER_JOINED: 'member.joined',
  MEMBER_LEFT: 'member.left'
});

// The project's id convention (mirrors `validateTaskInput` in index.js):
// ids are 8-64 characters of A-Z, a-z, 0-9, "_" and "-". This accepts Mongo
// ObjectIds (24 hex chars), the UUIDs used by the in-memory store, and the
// `mem-sprint-*` ids the in-memory sprint store generates.
const ID_PATTERN = /^[a-zA-Z0-9_-]{8,64}$/;

export function isEventId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

const isNullableId = (value) => value === null || isEventId(value);
const isStatus = (value) => typeof value === 'string' && ALLOWED_STATUSES.includes(value);
const isDate = (value) => value instanceof Date && !Number.isNaN(value.getTime());

// Thrown for unsupported event names and for payloads that violate a
// contract. Validation problems are programmer errors, so they always throw
// and are never swallowed.
export class EventValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EventValidationError';
  }
}

// Strict payload contracts, one entry per supported event.
//
// Every listed field is REQUIRED and must be present (a nullable field such
// as `teamId` may be `null`, but the key itself must exist). There are no
// optional fields today; extra keys are rejected so contract drift is
// caught at runtime.
const field = (check, expected) => Object.freeze({ check, expected });

const ID_FIELD = field(isEventId, 'an id string (8-64 characters: A-Z, a-z, 0-9, "_", "-")');
const DATE_FIELD = field(isDate, 'a valid Date instance');
const STATUS_FIELD = field(isStatus, `one of the task statuses (${ALLOWED_STATUSES.join(', ')})`);

export const EVENT_CONTRACTS = Object.freeze({
  // A task was successfully created and persisted.
  [EVENTS.TASK_CREATED]: Object.freeze({
    taskId: ID_FIELD,
    // `teamId` is the sprint the task belongs to; tasks outside any sprint
    // are persisted with `teamId: null` (same rule as TaskHistory.teamId).
    teamId: field(isNullableId, 'an id string or null (null = task outside any team)'),
    actorId: ID_FIELD,
    at: DATE_FIELD
  }),

  // A task's status was successfully changed by a real transition.
  [EVENTS.TASK_STATUS_CHANGED]: Object.freeze({
    taskId: ID_FIELD,
    teamId: field(isNullableId, 'an id string or null (null = task outside any team)'),
    actorId: ID_FIELD,
    // `from` is the actual persisted previous status; `to` the resulting
    // persisted status. Both must be valid task statuses.
    from: STATUS_FIELD,
    to: STATUS_FIELD,
    at: DATE_FIELD
  }),

  // A task was assigned or reassigned to a real user reference. Tasks that
  // end up unassigned never emit this event (there is no unassignment
  // contract).
  [EVENTS.TASK_ASSIGNED]: Object.freeze({
    taskId: ID_FIELD,
    teamId: field(isNullableId, 'an id string or null (null = task outside any team)'),
    actorId: ID_FIELD,
    assigneeId: ID_FIELD,
    at: DATE_FIELD
  }),

  // A membership was successfully created for a team.
  [EVENTS.MEMBER_JOINED]: Object.freeze({
    teamId: ID_FIELD,
    memberId: ID_FIELD,
    actorId: ID_FIELD,
    at: DATE_FIELD
  }),

  // A membership was successfully removed from a team.
  [EVENTS.MEMBER_LEFT]: Object.freeze({
    teamId: ID_FIELD,
    memberId: ID_FIELD,
    actorId: ID_FIELD,
    at: DATE_FIELD
  })
});

export function isSupportedEvent(eventName) {
  return typeof eventName === 'string' && Object.prototype.hasOwnProperty.call(EVENT_CONTRACTS, eventName);
}

function assertSupportedEvent(eventName) {
  if (!isSupportedEvent(eventName)) {
    throw new EventValidationError(
      `Unsupported event name: ${String(eventName)}. Supported events: ${Object.values(EVENTS).join(', ')}.`
    );
  }
}

function assertListener(listener) {
  if (typeof listener !== 'function') {
    throw new EventValidationError('Listener must be a function.');
  }
}

function validatePayload(eventName, payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new EventValidationError(`Invalid payload for "${eventName}": expected a plain object.`);
  }
  const contract = EVENT_CONTRACTS[eventName];
  const problems = [];
  for (const [name, spec] of Object.entries(contract)) {
    if (!Object.prototype.hasOwnProperty.call(payload, name)) {
      problems.push(`missing required field "${name}"`);
    } else if (!spec.check(payload[name])) {
      problems.push(`field "${name}" must be ${spec.expected}`);
    }
  }
  for (const name of Object.keys(payload)) {
    if (!Object.prototype.hasOwnProperty.call(contract, name)) {
      problems.push(`unexpected field "${name}"`);
    }
  }
  if (problems.length) {
    throw new EventValidationError(`Invalid payload for "${eventName}": ${problems.join('; ')}.`);
  }
}

/**
 * Validates `payload` against the contract for `eventName` and, only if the
 * payload is valid, notifies listeners through the shared emitter.
 *
 * Order of operations:
 *  1. reject unsupported event names,
 *  2. reject invalid payloads (listeners are never reached),
 *  3. deliver a frozen copy of the payload to every listener.
 *
 * Validation failures throw `EventValidationError`. Listener failures are
 * logged and contained per listener: the database operation that produced
 * the event has already committed, so a misbehaving listener must not crash
 * unrelated request handling, be mistaken for a rollback, or prevent the
 * remaining listeners from observing the event.
 */
export function emitEvent(eventName, payload) {
  assertSupportedEvent(eventName);
  validatePayload(eventName, payload);
  const frozenPayload = Object.freeze({ ...payload });
  // Listeners run synchronously (standard EventEmitter semantics); iterate
  // them directly so each one is individually isolated.
  for (const listener of emitter.rawListeners(eventName)) {
    try {
      const result = listener(frozenPayload);
      if (result && typeof result.then === 'function') {
        result.catch((error) => {
          console.error(`[events] listener for "${eventName}" failed:`, error);
        });
      }
    } catch (error) {
      console.error(`[events] listener for "${eventName}" failed:`, error);
    }
  }
}

/**
 * Registers `listener` for a supported event. Returns an unsubscribe
 * function so callers (notably tests) can clean up without holding on to the
 * listener reference. Registering the same listener twice registers it twice
 * (standard EventEmitter semantics); ordinary imports register no listeners
 * at all, so importing this module never creates duplicate listeners.
 */
export function onEvent(eventName, listener) {
  assertSupportedEvent(eventName);
  assertListener(listener);
  emitter.on(eventName, listener);
  return () => offEvent(eventName, listener);
}

/** Removes a previously registered listener. Unknown listeners are ignored. */
export function offEvent(eventName, listener) {
  assertSupportedEvent(eventName);
  assertListener(listener);
  emitter.off(eventName, listener);
}

/** Removes every listener for one supported event (test cleanup helper). */
export function removeAllEventListeners(eventName) {
  assertSupportedEvent(eventName);
  emitter.removeAllListeners(eventName);
}

/** Number of listeners currently registered for a supported event. */
export function listenerCount(eventName) {
  assertSupportedEvent(eventName);
  return emitter.listenerCount(eventName);
}
