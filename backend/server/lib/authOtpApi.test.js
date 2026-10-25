// Signup email verification and the existing code-based login/reset checks,
// all against an in-memory server. No SMTP is configured, so messages are
// printed to the server log; the test reads the one-time code from there,
// which is also how a local developer gets them.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = process.env.TEST_AUTH_PORT || 4110;
const BASE = `http://127.0.0.1:${PORT}/api`;
const STAMP = Date.now();
const EMAIL = `otp-${STAMP}@example.com`;
const USERNAME = `otp-tester-${STAMP}`;
const PASSWORD = 'Password123!';
const NEW_PASSWORD = 'AnotherPass456!';
const DEVICE_A = 'test-device-aaaaaaaaaa';
const DEVICE_B = 'test-device-bbbbbbbbbb';
const SIGNUP_SUBJECT = 'Confirm your LeadAI email address';

const server = spawn(process.execPath, ['server/index.js'], {
  env: {
    ...process.env,
    PORT: String(PORT),
    MONGODB_URI: '',
    ALLOW_MEMORY_DB: '1',
    NODE_ENV: 'development',
    AUTH_OTP_DISABLED: '',
    EMAIL_FROM: '',
    EMAIL_PROVIDER: '',
    RESEND_API_KEY: '',
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

const wrongCode = (code) => (code === '000000' ? '111111' : '000000');

let passed = 0;
async function check(label, fn) {
  await fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

try {
  await waitForApi();
  console.log(`auth email API checks, in-memory mode (port ${PORT})\n`);

  await check('an unused username is reported as available', async () => {
    const response = await api(`/auth/username-available?username=${USERNAME.toUpperCase()}`);
    assert.equal(response.status, 200);
    assert.equal(response.body.username, USERNAME);
    assert.equal(response.body.available, true);
  });

  await check('malformed usernames are rejected by the availability check', async () => {
    const response = await api('/auth/username-available?username=ab');
    assert.equal(response.status, 400);
  });

  let signup;
  await check('signup creates an unverified account and emails a confirmation code', async () => {
    signup = await api('/auth/signup', {
      method: 'POST',
      body: JSON.stringify({
        name: 'OTP Tester', username: USERNAME.toUpperCase(), email: EMAIL, password: PASSWORD
      })
    });
    assert.equal(signup.status, 201);
    assert.equal(signup.body.otpRequired, true);
    assert.equal(signup.body.purpose, 'signup');
    assert.ok(signup.body.challengeId);
    assert.equal(signup.body.email, EMAIL);
    assert.match(signup.body.message, /6-digit code/);
    assert.equal(signup.body.token, undefined);
    assert.equal(signup.body.user, undefined);
  });

  await check('the username is taken and normalized after signup', async () => {
    const response = await api(`/auth/username-available?username=${USERNAME}`);
    assert.equal(response.status, 200);
    assert.equal(response.body.available, false);
  });

  await check('signup without a username is refused', async () => {
    const response = await api('/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ name: 'No Handle', email: `no-handle-${STAMP}@example.com`, password: PASSWORD })
    });
    assert.equal(response.status, 400);
    assert.match(response.body.error, /username/i);
  });

  await check('invalid usernames are refused', async () => {
    const response = await api('/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ name: 'Bad Handle', username: '-bad-', email: `bad-handle-${STAMP}@example.com`, password: PASSWORD })
    });
    assert.equal(response.status, 400);
    assert.match(response.body.error, /username/i);
  });

  await check('the same email cannot be registered twice', async () => {
    const duplicate = await api('/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ name: 'Impostor', username: `impostor-${STAMP}`, email: EMAIL, password: PASSWORD })
    });
    assert.equal(duplicate.status, 409);
  });

  await check('usernames are unique regardless of case', async () => {
    const duplicate = await api('/auth/signup', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Same Handle', username: USERNAME.toUpperCase(), email: `same-handle-${STAMP}@example.com`, password: PASSWORD
      })
    });
    assert.equal(duplicate.status, 409);
    assert.match(duplicate.body.error, /username is already taken/i);
  });

  await check('weak passwords are refused with the full policy', async () => {
    const short = await api('/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ name: 'Weak', username: `weak-${STAMP}`, email: `weak-${STAMP}@example.com`, password: 'short' })
    });
    assert.equal(short.status, 400);
    assert.match(short.body.error, /between 8 and 128/);

    const partial = await api('/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ name: 'Weak', username: `weak-${STAMP}`, email: `weak-${STAMP}@example.com`, password: 'password' })
    });
    assert.equal(partial.status, 400);
    assert.match(partial.body.error, /uppercase/i);
    assert.match(partial.body.error, /number/i);
    assert.match(partial.body.error, /special/i);
  });

  await check('signing in before verification returns no session, only a code challenge', async () => {
    const response = await api('/auth/signin', {
      method: 'POST',
      body: JSON.stringify({ email: EMAIL, password: PASSWORD, deviceId: DEVICE_A })
    });
    assert.equal(response.status, 403);
    assert.equal(response.body.code, 'EMAIL_NOT_VERIFIED');
    assert.equal(response.body.otpRequired, true);
    assert.equal(response.body.purpose, 'signup');
    assert.equal(response.body.challengeId, signup.body.challengeId);
    assert.equal(response.body.token, undefined);
  });

  const signupCode = await waitForCode(SIGNUP_SUBJECT, 0);

  await check('a wrong signup code is refused and counted', async () => {
    const response = await api('/auth/otp/verify', {
      method: 'POST',
      body: JSON.stringify({ challengeId: signup.body.challengeId, code: wrongCode(signupCode) })
    });
    assert.equal(response.status, 400);
    assert.match(response.body.error, /4 attempts left/);
  });

  let token;
  await check('the emailed code verifies the account and signs the user in', async () => {
    const response = await api('/auth/otp/verify', {
      method: 'POST',
      body: JSON.stringify({ challengeId: signup.body.challengeId, code: signupCode })
    });
    assert.equal(response.status, 200);
    assert.ok(response.body.token);
    assert.equal(response.body.user.emailVerified, true);
    assert.equal(response.body.user.username, USERNAME);
    assert.equal(response.body.user.trustedDevices, undefined);
    assert.equal(response.body.user.passwordHash, undefined);
    token = response.body.token;
  });

  await check('the signup code cannot be reused', async () => {
    const response = await api('/auth/otp/verify', {
      method: 'POST',
      body: JSON.stringify({ challengeId: signup.body.challengeId, code: signupCode })
    });
    assert.equal(response.status, 400);
    assert.match(response.body.error, /invalid or has expired/);
  });

  await check('verification creates the starter board after signup', async () => {
    const boards = await api('/boards', { token });
    assert.equal(boards.body.length, 1);
    assert.equal(boards.body[0].name, "OTP Tester's board");
    const tasks = await api('/tasks', { token });
    assert.equal(tasks.body.length, 5);
  });

  let loginChallenge;
  await check('a new browser is challenged with a sign-in code', async () => {
    const response = await api('/auth/signin', {
      method: 'POST',
      body: JSON.stringify({ email: EMAIL, password: PASSWORD, deviceId: DEVICE_A })
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

  await check('resending an unknown challenge is refused', async () => {
    const response = await api('/auth/otp/resend', { method: 'POST', body: JSON.stringify({ challengeId: 'missing' }) });
    assert.equal(response.status, 400);
  });

  const loginCode = await waitForCode('Your LeadAI sign-in code', 0);

  await check('a sign-in code cannot be spent on the password reset form', async () => {
    const response = await api('/auth/reset-password/confirm', {
      method: 'POST',
      body: JSON.stringify({ challengeId: loginChallenge, code: loginCode, password: NEW_PASSWORD })
    });
    assert.equal(response.status, 400);
    assert.match(response.body.error, /different step/);
  });

  await check('the sign-in code works and trusts the browser', async () => {
    const response = await api('/auth/otp/verify', {
      method: 'POST',
      body: JSON.stringify({ challengeId: loginChallenge, code: loginCode, deviceId: DEVICE_A, deviceLabel: 'Test A' })
    });
    assert.equal(response.status, 200);
    assert.ok(response.body.token);
  });

  await check('the trusted browser signs in without another code', async () => {
    const response = await api('/auth/signin', {
      method: 'POST',
      body: JSON.stringify({ email: EMAIL, password: PASSWORD, deviceId: DEVICE_A })
    });
    assert.equal(response.status, 200);
    assert.ok(response.body.token);
  });

  await check('a second, unknown browser is challenged', async () => {
    const response = await api('/auth/signin', {
      method: 'POST',
      body: JSON.stringify({ email: EMAIL, password: PASSWORD, deviceId: DEVICE_B })
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.otpRequired, true);
    assert.equal(response.body.purpose, 'login');
  });

  let resetChallenge;
  await check('a reset request always returns a challenge, even for unknown emails', async () => {
    const known = await api('/auth/reset-password/request', { method: 'POST', body: JSON.stringify({ email: EMAIL }) });
    assert.equal(known.status, 200);
    assert.ok(known.body.challengeId);
    resetChallenge = known.body.challengeId;
    const unknown = await api('/auth/reset-password/request', { method: 'POST', body: JSON.stringify({ email: `nobody-${STAMP}@example.com` }) });
    assert.equal(unknown.status, 200);
    assert.ok(unknown.body.challengeId);
  });

  const resetCode = await waitForCode('Reset your LeadAI password');

  await check('a weak new password is refused before the code is spent', async () => {
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

  // ---- Attempt limits on a second, still-unverified account ----------------
  const secondEmail = `otp-second-${STAMP}@example.com`;
  let secondSignup;
  await check('a second account can request its own signup code', async () => {
    secondSignup = await api('/auth/signup', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Attempt Limit', username: `attempt-limit-${STAMP}`, email: secondEmail, password: PASSWORD
      })
    });
    assert.equal(secondSignup.status, 201);
    assert.ok(secondSignup.body.challengeId);
  });

  const secondCode = await waitForCode(SIGNUP_SUBJECT, 1);

  await check('five wrong guesses exhaust the code', async () => {
    let lastStatus = 0;
    let lastError = '';
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await api('/auth/otp/verify', {
        method: 'POST',
        body: JSON.stringify({ challengeId: secondSignup.body.challengeId, code: wrongCode(secondCode) })
      });
      lastStatus = response.status;
      lastError = response.body?.error || '';
    }
    assert.equal(lastStatus, 429);
    assert.match(lastError, /Too many incorrect attempts/);

    // Even the real code cannot be used after the limit is reached.
    const response = await api('/auth/otp/verify', {
      method: 'POST',
      body: JSON.stringify({ challengeId: secondSignup.body.challengeId, code: secondCode })
    });
    assert.equal(response.status, 429);
  });

  console.log(`\n${passed} auth email API checks passed.`);
} finally {
  server.kill();
}
