import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { Notification } from '../models/Notification.js';

let databaseReady = false;
const memoryNotifications = [];

export function setNotificationDatabaseReady(value) {
  databaseReady = Boolean(value);
}

function notificationView(notification) {
  const value = notification?.toObject ? notification.toObject() : notification;
  const status = value.status === 'actioned'
    ? 'actioned'
    : (value.status === 'read' || value.read ? 'read' : 'unread');
  return {
    ...value,
    _id: String(value._id || value.id),
    recipient: String(value.recipient || value.userId || ''),
    message: value.message || value.body || '',
    metadata: value.metadata || value.meta || {},
    status,
    read: status !== 'unread',
    body: value.message || value.body || ''
  };
}

export async function createInAppNotification({
  recipient, sender = null, type, title, message, relatedId = null, metadata = {}
}) {
  if (!recipient || typeof title !== 'string' || typeof message !== 'string') {
    throw new Error('A recipient, title, and message are required for a notification.');
  }
  const record = {
    recipient: String(recipient),
    sender: sender ? String(sender) : null,
    type,
    title: title.trim(),
    message: message.trim(),
    relatedId: relatedId === null ? null : String(relatedId),
    metadata: { ...metadata },
    status: 'unread',
    createdAt: new Date()
  };

  if (databaseReady) {
    const notification = await Notification.create({
      ...record,
      recipient: new mongoose.Types.ObjectId(record.recipient),
      sender: record.sender ? new mongoose.Types.ObjectId(record.sender) : null,
      relatedId: record.relatedId && mongoose.isValidObjectId(record.relatedId)
        ? new mongoose.Types.ObjectId(record.relatedId)
        : null,
      userId: record.recipient,
      body: record.message,
      meta: record.metadata,
      read: false
    });
    return notificationView(notification);
  }

  const notification = { ...record, _id: crypto.randomUUID(), id: null, userId: record.recipient, body: record.message, read: false };
  notification.id = notification._id;
  memoryNotifications.unshift(notification);
  return notificationView(notification);
}

export async function listNotifications(recipient, limit = 50) {
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 50, 100));
  if (databaseReady) {
    const records = await Notification.find({
      $or: [
        { recipient: new mongoose.Types.ObjectId(String(recipient)) },
        { recipient: { $exists: false }, userId: String(recipient) }
      ]
    }).sort({ createdAt: -1 }).limit(boundedLimit).lean();
    return records.map(notificationView);
  }
  return memoryNotifications
    .filter((notification) => String(notification.recipient || notification.userId) === String(recipient))
    .slice(0, boundedLimit)
    .map(notificationView);
}

export async function countUnreadNotifications(recipient) {
  if (databaseReady) {
    return Notification.countDocuments({
      $or: [
        { recipient: new mongoose.Types.ObjectId(String(recipient)), status: 'unread' },
        { recipient: { $exists: false }, userId: String(recipient), read: false }
      ]
    });
  }
  return memoryNotifications.filter((notification) =>
    String(notification.recipient || notification.userId) === String(recipient)
    && (notification.status || (notification.read ? 'read' : 'unread')) === 'unread'
  ).length;
}

export async function findNotificationForRecipient(id, recipient) {
  if (databaseReady) {
    if (!mongoose.isValidObjectId(id)) return null;
    const notification = await Notification.findOne({
      _id: id,
      $or: [
        { recipient: new mongoose.Types.ObjectId(String(recipient)) },
        { recipient: { $exists: false }, userId: String(recipient) }
      ]
    });
    return notification;
  }
  return memoryNotifications.find((notification) =>
    String(notification._id || notification.id) === String(id)
    && String(notification.recipient || notification.userId) === String(recipient)
  ) || null;
}

export async function updateNotificationForRecipient(id, recipient, updates) {
  const notification = await findNotificationForRecipient(id, recipient);
  if (!notification) return null;
  if (databaseReady) {
    Object.assign(notification, updates);
    if (updates.metadata) notification.markModified('metadata');
    if (updates.status) {
      notification.read = updates.status !== 'unread';
      notification.readAt = updates.status === 'unread' ? null : new Date();
    }
    await notification.save();
    return notificationView(notification);
  }
  Object.assign(notification, updates);
  if (updates.status) {
    notification.read = updates.status !== 'unread';
    notification.readAt = updates.status === 'unread' ? null : new Date();
  }
  return notificationView(notification);
}

export async function markAllNotificationsRead(recipient) {
  if (databaseReady) {
    const filter = {
      status: { $ne: 'actioned' },
      $or: [
        { recipient: new mongoose.Types.ObjectId(String(recipient)) },
        { recipient: { $exists: false }, userId: String(recipient) }
      ]
    };
    const result = await Notification.updateMany(filter, { $set: { status: 'read', read: true, readAt: new Date() } });
    return result.modifiedCount;
  }
  let changed = 0;
  for (const notification of memoryNotifications) {
    if (String(notification.recipient || notification.userId) === String(recipient) && notification.status === 'unread') {
      notification.status = 'read';
      notification.read = true;
      notification.readAt = new Date();
      changed += 1;
    }
  }
  return changed;
}

export async function deleteNotificationForRecipient(id, recipient) {
  if (databaseReady) {
    if (!mongoose.isValidObjectId(id)) return false;
    const result = await Notification.deleteOne({
      _id: id,
      $or: [
        { recipient: new mongoose.Types.ObjectId(String(recipient)) },
        { recipient: { $exists: false }, userId: String(recipient) }
      ]
    });
    return result.deletedCount === 1;
  }
  const index = memoryNotifications.findIndex((notification) =>
    String(notification._id || notification.id) === String(id)
    && String(notification.recipient || notification.userId) === String(recipient)
  );
  if (index < 0) return false;
  memoryNotifications.splice(index, 1);
  return true;
}
