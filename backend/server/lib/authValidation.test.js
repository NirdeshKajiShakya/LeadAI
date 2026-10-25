// Pure validation checks for the shared password and username policy, plus
// in-memory uniqueness rules. The same helpers back the HTTP endpoints.
import assert from 'node:assert/strict';
import {
  setDatabaseReady,
  createUser,
  isUsernameTaken,
  normalizeAndValidateUsername,
  passwordViolations,
  validatePassword,
  PASSWORD_RULES
} from '../auth.js';

setDatabaseReady(false);

let passed = 0;
async function check(label, fn) {
  await fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

await check('the password policy exposes all five rules', () => {
  assert.deepEqual(PASSWORD_RULES.map((rule) => rule.id), ['length', 'lowercase', 'uppercase', 'number', 'special']);
});

await check('a compliant password passes every rule', () => {
  assert.deepEqual(passwordViolations('Password123!'), []);
  assert.doesNotThrow(() => validatePassword('Password123!'));
  assert.doesNotThrow(() => validatePassword('aA1!aaaa'));
  assert.doesNotThrow(() => validatePassword('x'.repeat(120) + 'A1!'));
});

await check('each missing character class is reported', () => {
  assert.deepEqual(passwordViolations('password123!'), ['One uppercase letter']);
  assert.deepEqual(passwordViolations('PASSWORD123!'), ['One lowercase letter']);
  assert.deepEqual(passwordViolations('Password!'), ['One number']);
  assert.deepEqual(passwordViolations('Password123'), ['One special character']);
  assert.deepEqual(passwordViolations('Aa1!'), ['At least 8 characters']);
});

await check('out-of-range and non-string passwords are rejected', () => {
  assert.throws(() => validatePassword('short'), (error) => error.status === 400 && /between 8 and 128/.test(error.message));
  assert.throws(() => validatePassword(`${'A'.repeat(127)}1!`), (error) => error.status === 400 && /between 8 and 128/.test(error.message));
  assert.throws(() => validatePassword(undefined), (error) => error.status === 400);
});

await check('usernames are trimmed, lowercased and validated', () => {
  assert.equal(normalizeAndValidateUsername('  Alice-Cooper  '), 'alice-cooper');
  assert.equal(normalizeAndValidateUsername('A-1'), 'a-1');
  assert.throws(() => normalizeAndValidateUsername(''), (error) => error.status === 400 && /required/.test(error.message));
  assert.throws(() => normalizeAndValidateUsername('ab'), (error) => error.status === 400 && /between 3 and 30/.test(error.message));
  assert.throws(() => normalizeAndValidateUsername('a'.repeat(31)), (error) => error.status === 400 && /between 3 and 30/.test(error.message));
  for (const invalid of ['-alice', 'alice-', 'alice_cooper', 'alice cooper', 'alice!']) {
    assert.throws(
      () => normalizeAndValidateUsername(invalid),
      (error) => error.status === 400 && /lowercase letters, numbers, and hyphens/.test(error.message),
      `${invalid} should be rejected`
    );
  }
});

const first = await createUser({
  name: 'Validation One',
  email: `validation-one-${Date.now()}@example.com`,
  username: 'Validation-One',
  password: 'Password123!'
});

await check('createUser requires and normalizes a username without leaking secrets', () => {
  assert.equal(first.username, 'validation-one');
  assert.equal(first.passwordHash, undefined);
  assert.equal('trustedDevices' in first, false);
});

await check('createUser rejects a missing username before hashing', async () => {
  await assert.rejects(
    () => createUser({ name: 'No Handle', email: `no-handle-${Date.now()}@example.com`, password: 'Password123!' }),
    (error) => error.status === 400 && /username is required/i.test(error.message)
  );
});

await check('usernames are unique regardless of case', async () => {
  assert.equal(await isUsernameTaken('VALIDATION-ONE'), true);
  assert.equal(await isUsernameTaken('validation-one', first._id), false);
  await assert.rejects(
    () => createUser({ name: 'Second', email: `validation-two-${Date.now()}@example.com`, username: 'VALIDATION-ONE', password: 'Password123!' }),
    (error) => error.status === 409 && /username is already taken/i.test(error.message)
  );
});

await check('emails remain unique', async () => {
  await assert.rejects(
    () => createUser({ name: 'Second', email: first.email, username: 'validation-two', password: 'Password123!' }),
    (error) => error.status === 409 && /email already exists/i.test(error.message)
  );
});

await check('a weak password cannot create an account', async () => {
  await assert.rejects(
    () => createUser({ name: 'Weak', email: `weak-${Date.now()}@example.com`, username: 'weak-pass', password: 'password' }),
    (error) => error.status === 400 && /uppercase/i.test(error.message)
  );
});

console.log(`\n${passed} auth validation checks passed.`);
