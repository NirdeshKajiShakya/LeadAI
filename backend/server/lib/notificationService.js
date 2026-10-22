import mongoose from 'mongoose';
import { Notification } from '../models/Notification.js';

// In-memory fallback store (used if MongoDB connection is not ready)
const memoryNotifications = [];
let memoryUserId = null;

// Initialize with the current userId if available from auth context
export function initNotificationService(userId) {
  memoryUserId = userId;
}

// Notify: saves in-app record and triggers email asynchronously
export async function notify({
  userId,
  type,
  title,
  body,
  link,
  meta = {}
}) {
  // Save in-app notification record
  try {
    const notification = new Notification({
      userId,
      type,
      title,
      body,
      link,
      ...meta
    });
    await notification.save();
  } catch (error) {
    console.error('[notification] Failed to save in-app record:', error);
    // Fallback to in-memory if MongoDB fails
    memoryNotifications.push({
      userId,
      type,
      title,
      body,
      link,
      read: false,
      createdAt: new Date(),
      ...meta
    });
  }

  // Trigger email asynchronously with retries (no blocking)
  scheduleEmailDispatch(userId, { type, title, body, link, meta });
}

// scheduleEmailDispatch: sends email with 3 attempts and exponential backoff
let emailRetryQueue = [];

function scheduleEmailDispatch(userId, payload) {
  const attempt = {
    userId,
    payload,
    attempts: 0,
    maxAttempts: 3,
    baseDelay: 1000 // 1 second
  };

  emailRetryQueue.push(attempt);
  processEmailQueue();
}

function processEmailQueue() {
  if (emailRetryQueue.length === 0) return;

  const item = emailRetryQueue[0];

  // If this item has already been processed max times, drop it
  if (item.attempts >= item.maxAttempts) {
    console.log(`[notification] Email dropped after ${item.maxAttempts} attempts for user ${item.userId}`);
    emailRetryQueue.shift();
    processEmailQueue();
    return;
  }

  // Exponential backoff delay
  const delay = item.baseDelay * Math.pow(2, item.attempts);
  item.attempts++;

  setTimeout(() => {
    sendEmail(item.userId, item.payload)
      .then(() => {
        console.log('[notification] Email sent successfully');
        emailRetryQueue.shift();
        processEmailQueue();
      })
      .catch((error) => {
        console.warn(`[notification] Email attempt ${item.attempts} failed:`, error);
        processEmailQueue(); // try next attempt in queue
      });
  }, delay);
}

async function sendEmail(userId, { type, title, body, link }) {
  // Import nodemailer inside the function to avoid top-level ESM issues
  // and to only load it when actually sending email
  let transport, info;

  try {
    // Check SMTP config - if not configured, use Ethereal (dev) or skip
    const smtpHost = process.env.SMTP_HOST;
    const smtpPort = process.env.SMTP_PORT || 587;
    const smtpUser = process.env.SMTP_USER;
    const smtpPass = process.env.SMTP_PASS;
    const smtpFrom = process.env.SMTP_FROM || 'no-reply@leadai.local';

    // If SMTP is configured, use Nodemailer; otherwise use Ethereal for dev
    if (smtpHost && smtpUser && smtpPass) {
      const nodemailer = await import('nodemailer');
      transport = nodemailer.createTransport({
        host: smtpHost,
        port: parseInt(smtpPort),
        secure: parseInt(smtpPort) === 465, // true for 465, false for other ports
        auth: {
          user: smtpUser,
          pass: smtpPass
        }
      });

      const mailOptions = {
        from: smtpFrom,
        to: '', // Will look up user email from DB - placeholder for now
        subject: title,
        text: body,
        html: `<p>${body}</p>${link ? `<p><a href="${link}">View details</a></p>` : ''}`
      };

      info = await transport.sendMail(mailOptions);
      console.log('[notification] Email sent via SMTP:', info.messageId);
    } else {
      // Dev mode: use Ethereal generate a test email
      console.log('[notification] SMTP not configured; generating Ethereal test email');
      const nodemailer = await import('nodemailer');
      transport = nodemailer.createTransport({
        host: 'smtp.ethereal.email',
        port: 587,
        auth: {
          user: process.env.ETHEREAL_USER || 'test',
          pass: process.env.ETHEREAL_PASS || 'test'
        }
      });

      const mailOptions = {
        from: '"LeadAI" <no-reply@leadai.local>',
        to: 'test@example.com',
        subject: title,
        text: body,
        html: `<p>${body}</p>${link ? `<p><a href="${link}">View details</a></p>` : ''}`
      };

      info = await transport.sendMail(mailOptions);
      console.log('[notification] Ethereal test email preview URL:', nodemailer.getTestMessageUrl(info));
    }
  } catch (error) {
    console.error('[notification] Email send error:', error);
    throw error; // Will be caught by processEmailQueue retry logic
  }
}

export { processEmailQueue, scheduleEmailDispatch };