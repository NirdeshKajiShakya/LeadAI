import mongoose from 'mongoose';
import { Notification } from '../models/Notification.js';

// In-memory fallback store (used if MongoDB connection is not ready)
const memoryNotifications = [];
let memoryUserId = null;

// Initialize with the current userId if available from auth context
export function initNotificationService(userId) {
  memoryUserId = userId;
}

// Query the in-memory fallback (used when MongoDB is not available)
export function listMemoryNotifications({ userId, read, limit = 50, skip = 0 } = {}) {
  let items = memoryNotifications
    .filter((n) => String(n.userId) === String(userId))
    .filter((n) => read === undefined || n.read === read)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const total = items.length;
  items = items.slice(skip, skip + limit);
  return { items, total };
}

export function findMemoryNotificationById(id, userId) {
  return memoryNotifications.find((n) => String(n._id || n.id) === String(id) && String(n.userId) === String(userId));
}

export function updateMemoryNotification(id, userId, patch) {
  const idx = memoryNotifications.findIndex((n) => String(n._id || n.id) === String(id) && String(n.userId) === String(userId));
  if (idx < 0) return null;
  memoryNotifications[idx] = { ...memoryNotifications[idx], ...patch };
  return memoryNotifications[idx];
}

export function updateManyMemoryNotifications(userId, patch) {
  let count = 0;
  for (const n of memoryNotifications) {
    if (String(n.userId) === String(userId) && n.read === false) {
      Object.assign(n, patch);
      count += 1;
    }
  }
  return count;
}

// Notifications are in-app records. Email delivery is intentionally not done
// here: the previous queue used a dummy Ethereal transport and sent to an empty
// recipient, which could never deliver a real message. Any future email channel
// must go through lib/email.js and resolve a real address first.
export async function notify({
  userId,
  type,
  title,
  body,
  link,
  meta = {}
}) {
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
    console.error('[notification] Failed to save in-app record:', error?.message || error);
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
}
