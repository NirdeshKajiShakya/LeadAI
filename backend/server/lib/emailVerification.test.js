// Signup verification token checks against the in-memory store. A clock is
// injected so expiry and the resend cooldown are tested without sleeping.
import assert from 'node:assert/strict';
import { setDatabaseReady } from '../auth.js';
import {
  issueVerificationToken, consumeVerificationToken, clearVerificationTokens,
  hashVerificationToken, VERIFICATION_TTL_MS, RESEND_COOLDOWN_MS
} from './emailVerification.js';

setDatabaseReady(false);

const t0 = Date.now();
const emailFor = (name) => `verify-${name}-${Date.now()}@example.com`;
const USER_ID = 'user-verification-test';
let passed = 0;

async function check(label, fn) {
  await fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

await check('a verification token is random, hashed, and single-use', async () => {
  const email = emailFor('single-use');
  const issued = await issueVerificationToken({ email, userId: USER_ID, now: t0 });
  assert.match(issued.token, /^[a-f0-9]{64}$/);
  assert.equal(issued.token, issued.token.toLowerCase());
  assert.equal(hashVerificationToken(issued.token).length, 64);
  assert.notEqual(hashVerificationToken(issued.token), issued.token);

  const record = await consumeVerificationToken({ token: issued.token, now: t0 + 1_000 });
  assert.equal(record.email, email);
  assert.equal(record.userId, USER_ID);

  await assert.rejects(
    () => consumeVerificationToken({ token: issued.token, now: t0 + 2_000 }),
    (error) => error.status === 400 && /invalid or has expired/.test(error.message)
  );
});

await check('emails are normalized before a token is stored', async () => {
  const email = emailFor('case');
  const issued = await issueVerificationToken({ email: email.toUpperCase(), userId: USER_ID, now: t0 });
  const record = await consumeVerificationToken({ token: issued.token, now: t0 + 1_000 });
  assert.equal(record.email, email);
});

await check('tokens expire after thirty minutes', async () => {
  const email = emailFor('expiry');
  const issued = await issueVerificationToken({ email, userId: USER_ID, now: t0 });
  await assert.rejects(
    () => consumeVerificationToken({ token: issued.token, now: t0 + VERIFICATION_TTL_MS + 1 }),
    (error) => error.status === 400 && /expired/.test(error.message)
  );
});

await check('malformed tokens are rejected', async () => {
  await assert.rejects(
    () => consumeVerificationToken({ token: 'nope', now: t0 }),
    (error) => error.status === 400
  );
  await assert.rejects(
    () => consumeVerificationToken({ token: '', now: t0 }),
    (error) => error.status === 400
  );
});

await check('a second token waits for the resend cooldown', async () => {
  const email = emailFor('cooldown');
  const issuedAt = t0 + RESEND_COOLDOWN_MS * 10;
  await issueVerificationToken({ email, userId: USER_ID, now: issuedAt });
  await assert.rejects(
    () => issueVerificationToken({ email, userId: USER_ID, now: issuedAt + RESEND_COOLDOWN_MS - 1 }),
    (error) => error.status === 429 && /just sent/.test(error.message)
  );
  const later = await issueVerificationToken({ email, userId: USER_ID, now: issuedAt + RESEND_COOLDOWN_MS + 1 });
  assert.ok(later.token);
});

await check('resend mode reports throttling without throwing', async () => {
  const email = emailFor('throttled');
  const issuedAt = t0 + RESEND_COOLDOWN_MS * 20;
  await issueVerificationToken({ email, userId: USER_ID, now: issuedAt });
  const throttled = await issueVerificationToken({ email, userId: USER_ID, now: issuedAt + 1_000, enforceCooldown: false });
  assert.equal(throttled.throttled, true);
  assert.ok(throttled.retryAfter > 0);
  assert.equal(throttled.token, undefined);
});

await check('issuing a newer token invalidates the previous link', async () => {
  const email = emailFor('rotate');
  const issuedAt = t0 + RESEND_COOLDOWN_MS * 30;
  const first = await issueVerificationToken({ email, userId: USER_ID, now: issuedAt });
  const second = await issueVerificationToken({ email, userId: USER_ID, now: issuedAt + RESEND_COOLDOWN_MS + 1 });
  await assert.rejects(
    () => consumeVerificationToken({ token: first.token, now: issuedAt + RESEND_COOLDOWN_MS + 2 }),
    (error) => error.status === 400
  );
  const record = await consumeVerificationToken({ token: second.token, now: issuedAt + RESEND_COOLDOWN_MS + 3 });
  assert.equal(record.email, email);
});

await check('clearing tokens makes outstanding links invalid', async () => {
  const email = emailFor('clear');
  const issued = await issueVerificationToken({ email, userId: USER_ID, now: t0 + RESEND_COOLDOWN_MS * 40 });
  await clearVerificationTokens(email);
  await assert.rejects(
    () => consumeVerificationToken({ token: issued.token, now: t0 + RESEND_COOLDOWN_MS * 40 + 1 }),
    (error) => error.status === 400
  );
});

console.log(`\n${passed} verification token checks passed.`);
