import nodemailer from 'nodemailer';

// One delivery seam for the whole API. Resend is the preferred HTTP provider;
// SMTP stays available as an explicit fallback for installations that have not
// moved yet. Outside production the console transport is the default, so local
// sign-in and signup codes appear in the API terminal without a mailbox. A real
// provider must be selected explicitly in development. Production never writes
// codes to a log.
const EMAIL_PROVIDERS = ['resend', 'smtp', 'console'];

export function emailConfig(env = process.env) {
  const from = String(env.EMAIL_FROM || env.SMTP_FROM || '').trim();
  const resendKey = String(env.RESEND_API_KEY || '').trim();
  const smtpHost = String(env.SMTP_HOST || '').trim();
  const requested = String(env.EMAIL_PROVIDER || '').trim().toLowerCase();
  const localDevelopment = env.NODE_ENV === 'development' || env.NODE_ENV === 'test';

  if (requested && !EMAIL_PROVIDERS.includes(requested)) {
    throw new Error(`EMAIL_PROVIDER must be one of: ${EMAIL_PROVIDERS.join(', ')}.`);
  }
  if (requested === 'console') return { provider: 'console', from };
  // Local development prints codes in the API terminal by default, even when an
  // SMTP host happens to be present in .env. Set EMAIL_PROVIDER=smtp (or resend)
  // explicitly to test a real provider outside production.
  if (!requested && localDevelopment) return { provider: 'console', from };
  if (requested === 'resend' || (!requested && resendKey)) {
    return { provider: 'resend', from, apiKey: resendKey };
  }
  if (requested === 'smtp' || (!requested && smtpHost)) {
    return {
      provider: 'smtp',
      from,
      host: smtpHost,
      port: Number(env.SMTP_PORT || 587),
      secure: env.SMTP_SECURE === 'true' || Number(env.SMTP_PORT || 587) === 465,
      user: String(env.SMTP_USER || ''),
      pass: String(env.SMTP_PASS || '')
    };
  }
  return { provider: 'console', from };
}

export function emailConfigured(env = process.env) {
  try {
    const config = emailConfig(env);
    if (config.provider === 'resend') return Boolean(config.from && config.apiKey);
    if (config.provider === 'smtp') return Boolean(config.from && config.host);
  } catch {
    return false;
  }
  return false;
}

let transporter = null;
let transporterKey = '';

function transportFor(config) {
  const key = [config.host, config.port, config.user, config.pass, config.secure].join('|');
  if (transporter && key === transporterKey) return transporter;
  transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user ? { user: config.user, pass: config.pass } : undefined
  });
  transporterKey = key;
  return transporter;
}

async function sendWithResend(config, { to, subject, text, html }) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: config.from,
      to: [to],
      subject,
      text,
      ...(html ? { html } : {})
    }),
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) {
    // The response body can echo recipient data, so only the status is logged.
    console.error(`[email] Resend rejected a message (HTTP ${response.status}).`);
    const error = new Error('Email delivery failed. Try again shortly.');
    error.status = 502;
    throw error;
  }
  return { delivered: true, provider: 'resend' };
}

/**
 * Sends a plain-text email through the configured provider.
 *
 * - Outside production the console transport is the default: the full message,
 *   including one-time codes, is printed in the API terminal.
 * - Resend (HTTP API) is used when RESEND_API_KEY is set, or when selected with
 *   EMAIL_PROVIDER=resend. In development that selection must be explicit.
 * - SMTP is used when EMAIL_PROVIDER=smtp or, in production, when SMTP_HOST is
 *   configured and no Resend key exists.
 * - Production throws without a real provider, because one-time codes must
 *   never go to production logs.
 */
export async function sendMail({ to, subject, text, html }) {
  const config = emailConfig();

  // The console transport is a development-only convenience and does not need a
  // verified sender. Any real provider does.
  if (config.provider === 'console') {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Email delivery is not configured. Set EMAIL_FROM and RESEND_API_KEY (or SMTP_HOST).');
    }
    console.log(`\n[email:development] Email not sent — local terminal delivery\nTo: ${to}\nSubject: ${subject}\n\n${text}\n`);
    return { delivered: false, provider: 'console' };
  }

  if (!config.from) {
    throw new Error('Email delivery is not configured. Set EMAIL_FROM (and RESEND_API_KEY or SMTP_HOST).');
  }

  if (config.provider === 'resend') {
    if (!config.apiKey) throw new Error('RESEND_API_KEY is required when EMAIL_PROVIDER=resend.');
    return sendWithResend(config, { to, subject, text, html });
  }

  try {
    await transportFor(config).sendMail({ from: config.from, to, subject, text, ...(html ? { html } : {}) });
    return { delivered: true, provider: 'smtp' };
  } catch (error) {
    console.error('[email] SMTP delivery failed:', error.message);
    const failure = new Error('Email delivery failed. Try again shortly.');
    failure.status = 502;
    throw failure;
  }
}
