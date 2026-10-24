// One-time code checks against the in-memory store. A clock is injected so
// expiry and the resend cooldown are tested without sleeping.
import assert from 'node:assert/strict';
import { setDatabaseReady } from '../auth.js';
import {
  issueCode, verifyCode, CODE_TTL_MS, RESEND_COOLDOWN_MS, MAX_CODE_ATTEMPTS
} from './authCodes.js';

setDatabaseReady(false);

const email = `codes-${Date.now()}@example.com`;
const t0 = Date.now();
let passed = 0;

async function check(label, fn) {
  await fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

const wrongCode = (code) => (code === '000000' ? '111111' : '000000');

await check('a code verifies once and is then consumed', async () => {
  const { challengeId, code } = await issueCode({ email, purpose: 'signup', now: t0 });
  const record = await verifyCode({ challengeId, code, purposes: ['signup'], now: t0 + 1_000 });
  assert.equal(record.email, email);
  assert.equal(record.purpose, 'signup');
  await assert.rejects(
    () => verifyCode({ challengeId, code, now: t0 + 2_000 }),
    (error) => error.status === 400 && /invalid or has expired/.test(error.message)
  );
});

await check('a wrong code counts an attempt and still allows the real code', async () => {
  const { challengeId, code } = await issueCode({ email, purpose: 'signup', now: t0 + 2 * RESEND_COOLDOWN_MS });
  await assert.rejects(
    () => verifyCode({ challengeId, code: wrongCode(code), purposes: ['signup'], now: t0 + 2 * RESEND_COOLDOWN_MS }),
    (error) => error.status === 400 && /4 attempts left/.test(error.message)
  );
  const record = await verifyCode({ challengeId, code, purposes: ['signup'], now: t0 + 2 * RESEND_COOLDOWN_MS });
  assert.equal(record.purpose, 'signup');
});

await check('repeated wrong guesses destroy the code', async () => {
  const { challengeId, code } = await issueCode({ email, purpose: 'login', now: t0 + 3 * RESEND_COOLDOWN_MS });
  let lastError = null;
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
    try {
      await verifyCode({ challengeId, code: wrongCode(code), purposes: ['login'], now: t0 + 3 * RESEND_COOLDOWN_MS });
    } catch (error) {
      lastError = error;
    }
  }
  assert.equal(lastError.status, 429);
  assert.match(lastError.message, /Too many incorrect attempts/);
  await assert.rejects(
    () => verifyCode({ challengeId, code, purposes: ['login'], now: t0 + 3 * RESEND_COOLDOWN_MS }),
    (error) => error.status === 400
  );
});

await check('codes expire after ten minutes', async () => {
  const issuedAt = t0 + 4 * RESEND_COOLDOWN_MS;
  const { challengeId, code } = await issueCode({ email, purpose: 'reset', now: issuedAt });
  await assert.rejects(
    () => verifyCode({ challengeId, code, purposes: ['reset'], now: issuedAt + CODE_TTL_MS + 1 }),
    (error) => error.status === 400 && /expired/.test(error.message)
  );
});

await check('a second code for the same purpose waits for the cooldown', async () => {
  const issuedAt = t0 + 5 * RESEND_COOLDOWN_MS;
  await issueCode({ email, purpose: 'login', now: issuedAt });
  await assert.rejects(
    () => issueCode({ email, purpose: 'login', now: issuedAt + RESEND_COOLDOWN_MS - 1 }),
    (error) => error.status === 429 && /just sent/.test(error.message)
  );
  const later = await issueCode({ email, purpose: 'login', now: issuedAt + RESEND_COOLDOWN_MS + 1 });
  assert.ok(later.challengeId);
  // A different purpose is not blocked by another purpose's cooldown.
  const resetCode = await issueCode({ email, purpose: 'reset', now: issuedAt + RESEND_COOLDOWN_MS + 2 });
  assert.ok(resetCode.challengeId);
});

await check('a code cannot be spent on the wrong step', async () => {
  const issuedAt = t0 + 6 * RESEND_COOLDOWN_MS;
  const { challengeId, code } = await issueCode({ email, purpose: 'signup', now: issuedAt });
  await assert.rejects(
    () => verifyCode({ challengeId, code, purposes: ['reset'], now: issuedAt + 1_000 }),
    (error) => error.status === 400 && /different step/.test(error.message)
  );
  const record = await verifyCode({ challengeId, code, purposes: ['signup'], now: issuedAt + 2_000 });
  assert.equal(record.purpose, 'signup');
});

await check('malformed codes are rejected without spending an attempt', async () => {
  const issuedAt = t0 + 8 * RESEND_COOLDOWN_MS;
  const { challengeId, code } = await issueCode({ email, purpose: 'login', now: issuedAt });
  await assert.rejects(
    () => verifyCode({ challengeId, code: '12345', now: issuedAt + 1_000 }),
    (error) => error.status === 400 && /6-digit/.test(error.message)
  );
  const record = await verifyCode({ challengeId, code, purposes: ['login'], now: issuedAt + 2_000 });
  assert.equal(record.purpose, 'login');
});

console.log(`\n${passed} auth code checks passed.`);
