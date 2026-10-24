import nodemailer from 'nodemailer';

let transporter = null;
let transporterKey = '';

export function smtpConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_FROM);
}

function transport() {
  const key = [process.env.SMTP_HOST, process.env.SMTP_PORT, process.env.SMTP_USER, process.env.SMTP_PASS, process.env.SMTP_SECURE].join('|');
  if (transporter && key === transporterKey) return transporter;
  const port = Number(process.env.SMTP_PORT || 587);
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: process.env.SMTP_SECURE === 'true' || port === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
  });
  transporterKey = key;
  return transporter;
}

/**
 * Sends a plain-text email.
 *
 * - With SMTP configured, delivery failures throw so the caller can answer
 *   with an honest error instead of pretending a code was sent.
 * - Without SMTP, development and tests print the message to the server log
 *   (this is how a local setup gets its codes).
 * - In production a missing SMTP configuration is an error: one-time codes
 *   must never end up in production logs.
 */
export async function sendMail({ to, subject, text }) {
  if (!smtpConfigured()) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Email delivery is not configured. Set SMTP_HOST, SMTP_FROM and credentials.');
    }
    console.log(`\n[email:development] To: ${to}\nSubject: ${subject}\n\n${text}\n`);
    return { delivered: false };
  }
  await transport().sendMail({ from: process.env.SMTP_FROM, to, subject, text });
  return { delivered: true };
}
