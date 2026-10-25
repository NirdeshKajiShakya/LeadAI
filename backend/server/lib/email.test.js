// Email provider selection and delivery failure behaviour. No real message is
// sent: the console transport is captured and the Resend HTTP call is stubbed.
import assert from 'node:assert/strict';
import { emailConfig, emailConfigured, sendMail } from './email.js';

let passed = 0;
async function check(label, fn) {
  await fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

const ENV_KEYS = ['NODE_ENV', 'EMAIL_PROVIDER', 'EMAIL_FROM', 'SMTP_FROM', 'RESEND_API_KEY', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function resetEnv(values = {}) {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, values);
}

try {
  await check('no provider configuration selects the console transport', () => {
    const config = emailConfig({});
    assert.equal(config.provider, 'console');
    assert.equal(emailConfigured({ EMAIL_FROM: 'LeadAI <no-reply@example.com>' }), false);
  });

  await check('development prints codes in the terminal even when SMTP is configured', () => {
    const config = emailConfig({ NODE_ENV: 'development', SMTP_HOST: 'smtp.example.com', EMAIL_FROM: 'no-reply@example.com' });
    assert.equal(config.provider, 'console');
    assert.equal(emailConfig({ NODE_ENV: 'development', EMAIL_PROVIDER: 'smtp', SMTP_HOST: 'smtp.example.com' }).provider, 'smtp');
  });

  await check('a Resend key selects Resend and wins over SMTP', () => {
    const config = emailConfig({ NODE_ENV: 'production', RESEND_API_KEY: 're_test', SMTP_HOST: 'smtp.example.com', EMAIL_FROM: 'no-reply@example.com' });
    assert.equal(config.provider, 'resend');
    assert.equal(config.apiKey, 're_test');
    assert.equal(emailConfigured({ NODE_ENV: 'production', RESEND_API_KEY: 're_test', EMAIL_FROM: 'no-reply@example.com' }), true);
  });

  await check('SMTP is used when no Resend key exists', () => {
    const config = emailConfig({ NODE_ENV: 'production', SMTP_HOST: 'smtp.example.com', EMAIL_FROM: 'no-reply@example.com' });
    assert.equal(config.provider, 'smtp');
    assert.equal(config.port, 587);
    assert.equal(config.secure, false);
    assert.equal(emailConfigured({ NODE_ENV: 'production', SMTP_HOST: 'smtp.example.com', EMAIL_FROM: 'no-reply@example.com' }), true);
  });

  await check('EMAIL_PROVIDER picks a provider explicitly', () => {
    const smtp = emailConfig({ NODE_ENV: 'production', EMAIL_PROVIDER: 'smtp', RESEND_API_KEY: 're_test', SMTP_HOST: 'smtp.example.com' });
    assert.equal(smtp.provider, 'smtp');
    assert.equal(emailConfig({ NODE_ENV: 'production', EMAIL_PROVIDER: 'resend', SMTP_HOST: 'smtp.example.com' }).provider, 'resend');
    const secure = emailConfig({ NODE_ENV: 'production', SMTP_HOST: 'smtp.example.com', SMTP_PORT: '465' });
    assert.equal(secure.secure, true);
  });

  await check('a configured provider without the required values is not "configured"', () => {
    assert.equal(emailConfigured({ NODE_ENV: 'production', RESEND_API_KEY: 're_test' }), false);
    assert.equal(emailConfigured({ NODE_ENV: 'production', EMAIL_PROVIDER: 'resend', EMAIL_FROM: 'no-reply@example.com' }), false);
    assert.equal(emailConfigured({ NODE_ENV: 'production', EMAIL_PROVIDER: 'smtp', EMAIL_FROM: 'no-reply@example.com' }), false);
  });

  await check('an unknown provider is rejected instead of silently ignored', () => {
    assert.throws(() => emailConfig({ EMAIL_PROVIDER: 'sendgrid' }), /EMAIL_PROVIDER must be one of/);
    assert.equal(emailConfigured({ EMAIL_PROVIDER: 'sendgrid' }), false);
  });

  await check('development logs the message instead of sending it', async () => {
    resetEnv({ NODE_ENV: 'development' });
    const logs = [];
    const original = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    try {
      const result = await sendMail({ to: 'dev@example.com', subject: 'Development Subject', text: '  123456' });
      assert.deepEqual(result, { delivered: false, provider: 'console' });
    } finally {
      console.log = original;
    }
    const output = logs.join('\n');
    assert.match(output, /\[email:development\]/);
    assert.match(output, /Development Subject/);
    assert.match(output, /123456/);
  });

  await check('production refuses to write a code to the log', async () => {
    resetEnv({ NODE_ENV: 'production' });
    await assert.rejects(
      () => sendMail({ to: 'prod@example.com', subject: 'Production Subject', text: '  123456' }),
      /Email delivery is not configured/
    );
  });

  await check('a configured provider without a sender fails before sending', async () => {
    resetEnv({ NODE_ENV: 'production', RESEND_API_KEY: 're_test' });
    await assert.rejects(
      () => sendMail({ to: 'nobody@example.com', subject: 'No Sender', text: '123456' }),
      /Set EMAIL_FROM/
    );
  });

  await check('Resend sends one message and never exposes the key', async () => {
    resetEnv({ NODE_ENV: 'production', EMAIL_FROM: 'LeadAI <no-reply@example.com>', RESEND_API_KEY: 're_secret_value' });
    const calls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200 };
    };
    try {
      const result = await sendMail({
        to: 'member@example.com', subject: 'Your code', text: '  654321', html: '<p>654321</p>'
      });
      assert.deepEqual(result, { delivered: true, provider: 'resend' });
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.resend.com/emails');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer re_secret_value');
    assert.ok(calls[0].init.signal, 'a timeout signal must be attached');
    const body = JSON.parse(calls[0].init.body);
    assert.deepEqual(body.to, ['member@example.com']);
    assert.equal(body.from, 'LeadAI <no-reply@example.com>');
    assert.equal(body.html, '<p>654321</p>');
  });

  await check('a Resend rejection becomes a safe 502', async () => {
    resetEnv({ NODE_ENV: 'production', EMAIL_FROM: 'LeadAI <no-reply@example.com>', RESEND_API_KEY: 're_secret_value' });
    const originalFetch = globalThis.fetch;
    const originalError = console.error;
    const errors = [];
    console.error = (...args) => errors.push(args.join(' '));
    globalThis.fetch = async () => ({ ok: false, status: 422, text: async () => 'recipient member@example.com rejected' });
    try {
      await assert.rejects(
        () => sendMail({ to: 'member@example.com', subject: 'Your code', text: '  654321' }),
        (error) => error.status === 502 && !/member@example.com|re_secret_value/.test(error.message)
      );
    } finally {
      globalThis.fetch = originalFetch;
      console.error = originalError;
    }
    const output = errors.join('\n');
    assert.match(output, /HTTP 422/);
    assert.doesNotMatch(output, /member@example\.com|re_secret_value/);
  });

  await check('an explicit Resend provider without a key fails clearly', async () => {
    resetEnv({ NODE_ENV: 'production', EMAIL_FROM: 'LeadAI <no-reply@example.com>', EMAIL_PROVIDER: 'resend' });
    await assert.rejects(
      () => sendMail({ to: 'member@example.com', subject: 'Your code', text: '654321' }),
      /RESEND_API_KEY is required/
    );
  });

  console.log(`\n${passed} email provider checks passed.`);
} finally {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
}
