import { useEffect, useState } from 'react';
import { Bell, Clock, Check, Link, X } from 'lucide-react';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '';

const TYPE_LABELS = {
  task_assigned: 'Task assigned',
  task_status_changed: 'Task status updated',
  member_joined: 'Team member joined',
  member_left: 'Team member left',
  task_due_soon: 'Task due soon',
};

const TYPE_ICONS = {
  task_assigned: <span className="n-type-dot assigned"></span>,
  task_status_changed: <span className="n-type-dot status"></span>,
  member_joined: <span className="n-type-dot joined"></span>,
  member_left: <span className="n-type-dot left"></span>,
  task_due_soon: <span className="n-type-dot due"></span>,
};

export default function BellNotifications() {
  const [unreadCount, setUnreadCount] = useState(0);
  const [notifications, setNotifications] = useState([]);
  const [isOpen, setIsOpen] = useState(false);
  const [token, setToken] = useState(null);
  const [empty, setEmpty] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Get auth token from sessionStorage
  useEffect(() => {
    const stored = sessionStorage.getItem('leadai-session');
    if (stored) setToken(stored);
  }, []);

  // Fetch full notification list
  const fetchNotifications = async () => {
    if (!token) return;
    setRefreshing(true);
    try {
      const response = await fetch(`${API_BASE_URL}/api/notifications`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.ok) {
        const data = await response.json();
        const list = Array.isArray(data.notifications) ? data.notifications : [];
        setNotifications(list);
        setUnreadCount(data.total ?? list.filter((n) => !n.read).length);
        setEmpty(list.length === 0);
      }
    } catch (error) {
      console.warn('[bell] Failed to fetch notifications:', error);
      setEmpty(true);
    } finally {
      setRefreshing(false);
    }
  };

  // Fetch unread count
  const fetchUnreadCount = async () => {
    if (!token) return;
    try {
      const response = await fetch(`${API_BASE_URL}/api/notifications/unread`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.ok) {
        const data = await response.json();
        setUnreadCount(data.total ?? 0);
      }
    } catch (error) {
      console.warn('[bell] Failed to fetch unread count:', error);
    }
  };

  useEffect(() => {
    if (!token) return;
    fetchUnreadCount();
    const timeoutId = setInterval(fetchUnreadCount, 25000);
    return () => clearInterval(timeoutId);
  }, [token]);

  useEffect(() => {
    if (!token) return;
    fetchNotifications();
    const timeoutId = setInterval(fetchNotifications, 30000);
    return () => clearInterval(timeoutId);
  }, [token]);

  // Mark single notification as read
  const markAsRead = async (notificationId) => {
    if (!token) return;
    try {
      await fetch(`${API_BASE_URL}/api/notifications/${notificationId}/read`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` },
      });
      setNotifications((list) =>
        list.map((n) => (n._id === notificationId ? { ...n, read: true, readAt: new Date() } : n))
      );
      setUnreadCount((c) => Math.max(0, c - 1));
    } catch (error) {
      console.error('[bell] Failed to mark notification as read:', error);
    }
  };

  // Mark all notifications as read
  const markAllRead = async () => {
    if (!token) return;
    try {
      await fetch(`${API_BASE_URL}/api/notifications/read-all`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` },
      });
      setNotifications((list) =>
        list.map((n) => ({ ...n, read: true, readAt: new Date() }))
      );
      setUnreadCount(0);
    } catch (error) {
      console.error('[bell] Failed to mark all notifications as read:', error);
    }
  };

  // Handle outside click
  const handleOutsideClick = (event) => {
    if (event.target.closest('.n-bell-wrap')) return;
    setIsOpen(false);
  };

  useEffect(() => {
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  if (!token) return null;

  const handleBellClick = (e) => {
    e.stopPropagation();
    setIsOpen((prev) => !prev);
  };

  const typeIcon = (type) => TYPE_ICONS[type] || <span className="n-type-dot default"></span>;
  const typeText = (type) => TYPE_LABELS[type] || type;

  const formatTime = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };

  return (
    <div className="n-bell-wrap" onClick={(e) => e.stopPropagation()}>
      <button className="n-bell-btn" aria-label="Notifications" title="Notifications" onClick={handleBellClick}>
        <Bell size={16} className="n-bell-icon" />
        {unreadCount > 0 && <span className="n-unread-badge">{unreadCount}</span>}
      </button>
      {isOpen && (
        <div className="n-dropdown">
          <div className="n-dropdown-head">
            <span className="n-dropdown-title">Notifications</span>
            <div className="n-dropdown-actions">
              <button className="n-refresh-btn" onClick={(e) => { e.stopPropagation(); fetchNotifications(); }} aria-label="Refresh" disabled={refreshing}>
                {refreshing ? <span style={{fontSize:12, width:14, height:14, border:'2px solid currentColor', borderRadius:'50%', borderRightColor:'transparent', animation:'n-spin .8s linear infinite'}}></span> : <X size={12} />}
              </button>
              <button className="n-close-btn" onClick={(e) => { e.stopPropagation(); setIsOpen(false); }} aria-label="Close">
                <X size={14} />
              </button>
            </div>
          </div>
          {(empty || notifications.length === 0) ? (
            <div className="n-empty">
              <div className="n-empty-icon"><Clock size={24} /></div>
              <p className="n-empty-text">No notifications yet</p>
              <p className="n-empty-sub">You’ll see updates here when you’re assigned a task, a task status changes, or a teammate joins your team.</p>
            </div>
          ) : (
            <>
              <div className="n-list">
                {notifications.map((n) => (
                  <div key={n._id || n.id} className={`n-item${n.read ? '' : ' n-unread'}`} onClick={() => { if (!n.read) markAsRead(n._id); }}>
                    <div className="n-item-left">{typeIcon(n.type)}</div>
                    <div className="n-item-right">
                      <div className="n-item-head">
                        <span className="n-item-title">{typeText(n.type)}</span>
                        <span className="n-item-time">{formatTime(n.createdAt)}</span>
                        {!n.read && <span className="n-dot"></span>}
                      </div>
                      <p className="n-item-body">{n.body}</p>
                      {n.link && (
                        <a className="n-item-link" href={n.link} target="_blank" rel="noopener noreferrer">
                          <Link size={12} /> View
                        </a>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              <div className="n-footer">
                <button className="n-mark-all" onClick={(e) => { e.stopPropagation(); markAllRead(); }}>
                  <Check size={14} /> Mark all read
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
