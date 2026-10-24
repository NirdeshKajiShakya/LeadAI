// Signup email verification and the existing code-based login/reset checks,
// all against an in-memory server. No SMTP is configured, so messages are
// printed to the server log; the test reads the one-time token/code from there,
// which is also how a local developer gets them.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = process.env.TEST_AUTH_PORT || 4110;
const BASE = `http://127.0.0.1:${PORT}/api`;
const EMAIL = `otp-${Date.now()}@example.com`;
const PASSWORD = 'Password123!';
const NEW_PASSWORD = 'AnotherPass456!';
const DEVICE_A = 'test-device-aaaaaaaaaa';
const DEVICE_B = 'test-device-bbbbbbbbbb';

const server = spawn(process.execPath, ['server/index.js'], {
  env: {
    ...process.env,
    PORT: String(PORT),
    MONGODB_URI: '',
    ALLOW_MEMORY_DB: '1',
    NODE_ENV: 'development',
    AUTH_OTP_DISABLED: '',
    SMTP_HOST: '',
    SMTP_FROM: '',
    SMTP_USER: '',
    SMTP_PASS: '',
    APP_URL: 'http://localhost:5173',
    OPENROUTER_API_KEY: ''
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let output = '';
server.stdout.on('data', (chunk) => { output += chunk; });
server.stderr.on('data', (chunk) => { output += chunk; });

async function waitForApi() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch { /* not up yet */ }
    await sleep(150);
  }
  throw new Error('server did not start');
}

async function api(path, { token, ...options } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers
    }
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

function emailsFor(subject) {
  return output
    .split('[email:development]')
    .filter((block) => block.includes(`Subject: ${subject}`));
}

function codesFor(subject) {
  return emailsFor(subject)
    .map((block) => block.match(/^\s{4}(\d{6})$/m)?.[1])
    .filter(Boolean);
}

async function waitForCode(subject, occurrence = 0) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const codes = codesFor(subject);
    if (codes.length > occurrence) return codes[occurrence];
    await sleep(100);
  }
  throw new Error(`no ${subject} email was logged`);
}

function verificationTokens() {
  return emailsFor('Confirm your LeadAI email address')
    .map((block) => block.match(/\/verify-email#token=([a-f0-9]{64})/)?.[1])
    .filter(Boolean);
}

async function waitForVerificationToken(occurrence = 0) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const tokens = verificationTokens();
    if (tokens.length > occurrence) return tokens[occurrence];
    await sleep(100);
  }
  throw new Error('no verification email was logged');
}

let passed = 0;
async function check(label, fn) {
  await fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

try {
  await waitForApi();
  console.log(`auth email API checks, in-memory mode (port ${PORT})\n`);

  let signup;
  await check('signup creates an unverified account and asks for an emailed verification link', async () => {
    signup = await api('/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ name: 'OTP Tester', email: EMAIL, password: PASSWORD, deviceId: DEVICE_A })
    });
    assert.equal(signup.status, 201);
    assert.equal(signup.body.verificationRequired, true);
    assert.equal(signup.body.email, EMAIL);
    assert.match(signup.body.message, /Check your email to verify your account/);
    assert.equal(signup.body.token, undefined);
    assert.equal(signup.body.challengeId, undefined);
  });

  await check('the same email cannot be registered twice', async () => {
    const duplicate = await api('/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ name: 'Impostor', email: EMAIL, password: PASSWORD })
    });
    assert.equal(duplicate.status, 409);
  });

  await check('signing in before verification returns no session', async () => {
    const response = await api('/auth/signin', {
      method: 'POST',
      body: JSON.stringify({ email: EMAIL, password: PASSWORD, deviceId: DEVICE_A })
    });
    assert.equal(response.status, 403);
    assert.equal(response.body.code, 'EMAIL_NOT_VERIFIED');
    assert.equal(response.body.token, undefined);
  });

  await check('an immediate resend is accepted without sending a second email', async () => {
    const before = verificationTokens().length;
    const response = await api('/auth/verify-email/resend', {
      method: 'POST',
      body: JSON.stringify({ email: EMAIL })
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.ok(response.body.cooldownSeconds > 0);
    await sleep(150);
    assert.equal(verificationTokens().length, before);
  });

  await check('resending for an unknown address looks the same', async () => {
    const response = await api('/auth/verify-email/resend', {
      method: 'POST',
      body: JSON.stringify({ email: `nobody-${Date.now()}@example.com` })
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.match(response.body.message, /If that account/);
  });

  const verificationToken = await waitForVerificationToken(0);

  await check('a malformed verification token is rejected', async () => {
    const response = await api('/auth/verify-email', {
      method: 'POST',
      body: JSON.stringify({ token: 'not-a-real-token' })
    });
    assert.equal(response.status, 400);
    assert.match(response.body.error, /invalid or has expired/);
  });

  await check('an unknown but well-formed token is rejected', async () => {
    const response = await api('/auth/verify-email', {
      method: 'POST',
      body: JSON.stringify({ token: 'a'.repeat(64) })
    });
    assert.equal(response.status, 400);
    assert.match(response.body.error, /invalid or has expired/);
  });

  await check('the emailed link verifies the account', async () => {
    const response = await api('/auth/verify-email', {
      method: 'POST',
      body: JSON.stringify({ token: verificationToken })
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.email, EMAIL);
    assert.match(response.body.message, /You can sign in now/);
    assert.equal(response.body.token, undefined);
  });

  await check('the verification link cannot be reused', async () => {
    const response = await api('/auth/verify-email', {
      method: 'POST',
      body: JSON.stringify({ token: verificationToken })
    });
    assert.equal(response.status, 400);
    assert.match(response.body.error, /invalid or has expired/);
  });

  let token;
  await check('the verified account can sign in and receives a starter board', async () => {
    const challenge = await api('/auth/signin', {
      method: 'POST',
      body: JSON.stringify({ email: EMAIL, password: PASSWORD, deviceId: DEVICE_A })
    });
    // A new browser still passes the existing sign-in check.
    assert.equal(challenge.status, 200);
    assert.equal(challenge.body.otpRequired, true);
    assert.equal(challenge.body.purpose, 'login');
    const code = await waitForCode('Your LeadAI sign-in code');
    const response = await api('/auth/otp/verify', {
      method: 'POST',
      body: JSON.stringify({ challengeId: challenge.body.challengeId, code, deviceId: DEVICE_A, deviceLabel: 'Test A' })
    });
    assert.equal(response.status, 200);
    assert.ok(response.body.token);
    assert.equal(response.body.user.emailVerified, true);
    assert.equal(response.body.user.trustedDevices, undefined);
    token = response.body.token;

    const boards = await api('/boards', { token });
    assert.equal(boards.body.length, 1);
    assert.equal(boards.body[0].name, "OTP Tester's board");
    const tasks = await api('/tasks', { token });
    assert.equal(tasks.body.length, 5);
  });

  await check('a known device signs in without a code', async () => {
    const response = await api('/auth/signin', {
      method: 'POST',
      body: JSON.stringify({ email: EMAIL, password: PASSWORD, deviceId: DEVICE_A })
    });
    assert.equal(response.status, 200);
    assert.ok(response.body.token);
  });

  let loginChallenge;
  await check('a new device is challenged with a sign-in code', async () => {
    const response = await api('/auth/signin', {
      method: 'POST',
      body: JSON.stringify({ email: EMAIL, password: PASSWORD, deviceId: DEVICE_B })
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.otpRequired, true);
    assert.equal(response.body.purpose, 'login');
    assert.equal(response.body.token, undefined);
    loginChallenge = response.body.challengeId;
  });

  await check('resending within a minute is refused', async () => {
    const response = await api('/auth/otp/resend', { method: 'POST', body: JSON.stringify({ challengeId: loginChallenge }) });
    assert.equal(response.status, 429);
    assert.match(response.body.error, /just sent/);
  });

  const loginCode = await waitForCode('Your LeadAI sign-in code', 1);

  await check('a sign-in code cannot be spent on the password reset form', async () => {
    const response = await api('/auth/reset-password/confirm', {
      method: 'POST',
      body: JSON.stringify({ challengeId: loginChallenge, code: loginCode, password: NEW_PASSWORD })
    });
    assert.equal(response.status, 400);
    assert.match(response.body.error, /different step/);
  });

  await check('the sign-in code still works on the sign-in form', async () => {
    const response = await api('/auth/otp/verify', {
      method: 'POST',
      body: JSON.stringify({ challengeId: loginChallenge, code: loginCode, deviceId: DEVICE_B, deviceLabel: 'Test B' })
    });
    assert.equal(response.status, 200);
    assert.ok(response.body.token);
  });

  await check('the second device is trusted afterwards', async () => {
    const response = await api('/auth/signin', {
      method: 'POST',
      body: JSON.stringify({ email: EMAIL, password: PASSWORD, deviceId: DEVICE_B })
    });
    assert.ok(response.body.token);
  });

  let resetChallenge;
  await check('a reset request always returns a challenge, even for unknown emails', async () => {
    const known = await api('/auth/reset-password/request', { method: 'POST', body: JSON.stringify({ email: EMAIL }) });
    assert.equal(known.status, 200);
    assert.ok(known.body.challengeId);
    resetChallenge = known.body.challengeId;
    const unknown = await api('/auth/reset-password/request', { method: 'POST', body: JSON.stringify({ email: `nobody-${Date.now()}@example.com` }) });
    assert.equal(unknown.status, 200);
    assert.ok(unknown.body.challengeId);
  });

  const resetCode = await waitForCode('Reset your LeadAI password');

  await check('a short new password is refused before the code is spent', async () => {
    const response = await api('/auth/reset-password/confirm', {
      method: 'POST',
      body: JSON.stringify({ challengeId: resetChallenge, code: resetCode, password: 'short' })
    });
    assert.equal(response.status, 400);
    assert.match(response.body.error, /between 8 and 128/);
  });

  await check('the reset code changes the password', async () => {
    const response = await api('/auth/reset-password/confirm', {
      method: 'POST',
      body: JSON.stringify({ challengeId: resetChallenge, code: resetCode, password: NEW_PASSWORD })
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
  });

  await check('the old password no longer signs in', async () => {
    const response = await api('/auth/signin', {
      method: 'POST',
      body: JSON.stringify({ email: EMAIL, password: PASSWORD, deviceId: DEVICE_A })
    });
    assert.equal(response.status, 401);
  });

  await check('the new password works and the reset revoked every trusted device', async () => {
    const response = await api('/auth/signin', {
      method: 'POST',
      body: JSON.stringify({ email: EMAIL, password: NEW_PASSWORD, deviceId: DEVICE_A })
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.otpRequired, true);
    assert.equal(response.body.purpose, 'login');
  });

  console.log(`\n${passed} auth email API checks passed.`);
} finally {
  server.kill();
}
