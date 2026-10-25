import { useCallback, useEffect, useState } from 'react';
import { Bell, Check, Clock3, X } from 'lucide-react';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '';

const TYPE_ICONS = {
  board_invite: 'BI',
  task_assigned: 'TA',
  task_review: 'RV',
  sprint_started: 'SP',
  system: 'SY'
};

export default function BellNotifications({ token, onInvitationAccepted }) {
  const [unreadCount, setUnreadCount] = useState(0);
  const [notifications, setNotifications] = useState([]);
  const [isOpen, setIsOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const request = useCallback(async (path, options = {}) => {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {})
      }
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(body?.error || `Notification request failed (${response.status}).`);
    return body;
  }, [token]);

  const fetchNotifications = useCallback(async () => {
    if (!token) return;
    setRefreshing(true);
    try {
      const data = await request('/api/notifications');
      const list = Array.isArray(data.notifications) ? data.notifications : [];
      setNotifications(list);
      setUnreadCount(Number(data.unreadCount ?? list.filter((item) => item.status === 'unread' || !item.read).length));
      setError('');
    } catch (fetchError) {
      console.error('[notifications] Failed to load notifications:', fetchError);
      setError(fetchError.message);
    } finally {
      setRefreshing(false);
    }
  }, [request, token]);

  useEffect(() => {
    fetchNotifications();
    const interval = window.setInterval(fetchNotifications, 30_000);
    return () => window.clearInterval(interval);
  }, [fetchNotifications]);

  useEffect(() => {
    if (!isOpen) return undefined;
    function closeOnOutsideClick(event) {
      if (event.target instanceof Element && !event.target.closest('.n-bell-wrap')) setIsOpen(false);
    }
    document.addEventListener('pointerdown', closeOnOutsideClick);
    return () => document.removeEventListener('pointerdown', closeOnOutsideClick);
  }, [isOpen]);

  const updateRead = async (notification) => {
    if (notification.status !== 'unread' && notification.read) return;
    try {
      await request(`/api/notifications/${encodeURIComponent(notification._id)}/read`, { method: 'PATCH' });
      setNotifications((current) => current.map((item) => item._id === notification._id
        ? { ...item, status: 'read', read: true }
        : item));
      setUnreadCount((count) => Math.max(0, count - 1));
    } catch (readError) {
      console.error('[notifications] Failed to mark notification as read:', readError);
      setError(readError.message);
    }
  };

  const markAllRead = async () => {
    try {
      await request('/api/notifications/read-all', { method: 'PATCH' });
      setNotifications((current) => current.map((item) => item.status === 'actioned'
        ? item
        : { ...item, status: 'read', read: true }));
      setUnreadCount(0);
      setError('');
    } catch (readError) {
      console.error('[notifications] Failed to mark all notifications as read:', readError);
      setError(readError.message);
    }
  };

  const dismiss = async (notification) => {
    try {
      await request(`/api/notifications/${encodeURIComponent(notification._id)}`, { method: 'DELETE' });
      setNotifications((current) => current.filter((item) => item._id !== notification._id));
      if (notification.status === 'unread' || !notification.read) setUnreadCount((count) => Math.max(0, count - 1));
      setError('');
    } catch (deleteError) {
      console.error('[notifications] Failed to dismiss notification:', deleteError);
      setError(deleteError.message);
    }
  };

  const respondToInvite = async (notification, action) => {
    try {
      await request('/api/boards/invite/respond', {
        method: 'POST',
        body: JSON.stringify({ notificationId: notification._id, action })
      });
      if (action === 'accept' && onInvitationAccepted) {
        try {
          await onInvitationAccepted();
        } catch (refreshError) {
          console.error('[notifications] Invitation was accepted but boards could not refresh:', refreshError);
          setError(`Invitation accepted. Reload to refresh your boards: ${refreshError.message}`);
        }
      }
      await fetchNotifications();
    } catch (actionError) {
      console.error('[notifications] Failed to respond to board invitation:', actionError);
      setError(actionError.message);
    }
  };

  const formatTime = (value) => {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const minutes = Math.floor((Date.now() - date.getTime()) / 60_000);
    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };

  if (!token) return null;
  return (
    <div className="n-bell-wrap">
      <button
        type="button"
        className="n-bell-btn"
        aria-label={`Notifications${unreadCount ? `, ${unreadCount} unread` : ''}`}
        aria-expanded={isOpen}
        onClick={() => setIsOpen((open) => !open)}
      >
        <Bell size={16} className="n-bell-icon" />
        {unreadCount > 0 && <span className="n-unread-badge">{unreadCount > 99 ? '99+' : unreadCount}</span>}
      </button>
      {isOpen && (
        <section className="n-dropdown" role="dialog" aria-label="Notifications">
          <header className="n-dropdown-head">
            <div>
              <strong className="n-dropdown-title">Notifications</strong>
              <span className="n-dropdown-count">{unreadCount ? `${unreadCount} unread` : 'All caught up'}</span>
            </div>
            <button type="button" className="n-close-btn" onClick={() => setIsOpen(false)} aria-label="Close notifications">
              <X size={14} />
            </button>
          </header>
          {error && <p className="n-error" role="alert">{error}</p>}
          <div className="n-list" aria-busy={refreshing}>
            {notifications.length ? notifications.map((notification) => {
              const isPendingInvite = notification.type === 'board_invite'
                && notification.metadata?.inviteStatus === 'pending';
              return (
                <article
                  key={notification._id}
                  className={`n-item${notification.status === 'unread' || !notification.read ? ' n-unread' : ''}`}
                  onClick={() => !isPendingInvite && updateRead(notification)}
                >
                  <span className={`n-item-icon n-icon-${notification.type || 'system'}`} aria-hidden="true">
                    {TYPE_ICONS[notification.type] || 'N'}
                  </span>
                  <div className="n-item-right">
                    <div className="n-item-head">
                      <strong className="n-item-title">{notification.title || notification.type}</strong>
                      <time className="n-item-time">{formatTime(notification.createdAt)}</time>
                    </div>
                    <p className="n-item-body">{notification.message || notification.body}</p>
                    {isPendingInvite ? (
                      <div className="n-invite-actions">
                        <button type="button" className="n-accept-button" onClick={() => respondToInvite(notification, 'accept')}>Accept</button>
                        <button type="button" className="n-decline-button" onClick={() => respondToInvite(notification, 'decline')}>Decline</button>
                      </div>
                    ) : notification.type === 'board_invite' ? (
                      <span className="n-invite-result">
                        {notification.metadata?.inviteStatus === 'accepted' ? 'Invitation accepted' : 'Invitation declined'}
                      </span>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className="n-dismiss-button"
                    aria-label={`Dismiss ${notification.title || 'notification'}`}
                    onClick={() => dismiss(notification)}
                  >
                    <X size={14} />
                  </button>
                </article>
              );
            }) : (
              <div className="n-empty">
                <Clock3 size={21} />
                <strong>No notifications yet</strong>
                <span>Board invitations and task updates will show up here.</span>
              </div>
            )}
          </div>
          {notifications.length > 0 && (
            <footer className="n-footer">
              <button type="button" className="n-mark-all" onClick={markAllRead} disabled={!unreadCount}>
                <Check size={14} /> Mark all as read
              </button>
              <button type="button" className="n-refresh-btn" onClick={fetchNotifications} disabled={refreshing} aria-label="Refresh notifications">
                <span className={refreshing ? 'n-refresh-spin' : ''}>↻</span>
              </button>
            </footer>
          )}
        </section>
      )}
    </div>
  );
}
