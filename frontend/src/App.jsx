import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, AlertTriangle, ArrowRight, Bell, Bolt, Bot, CalendarDays, Check, ChevronDown,
  ChevronRight, Filter, LayoutGrid, List, Menu, MoreHorizontal, PanelLeftClose,
  PanelLeftOpen, Pencil, Plus, Search, Settings2, Sparkles, Target, UserRound, Users, X,
  Zap, LoaderCircle, Clock3, Mail, Shield, Trash2
} from 'lucide-react';
import SprintBacklog from './SprintBacklog.jsx';
import { ProfileEditPage, ProfilePage } from './Profile.jsx';
import Dashboard from './Dashboard.jsx';
import { isCalendarDate } from './sprintDates.js';
import SettingsPage from './SettingsPage.jsx';
import AuthScreen from './AuthScreen.jsx';
import VerifyEmailPage from './VerifyEmailPage.jsx';

const columns = [
  { id: 'backlog', label: 'Backlog', color: 'slate', hint: 'Shape the next move' },
  { id: 'todo', label: 'To Do', color: 'cyan', hint: 'Ready to pick up' },
  { id: 'progress', label: 'In Progress', color: 'violet', hint: 'Active execution' },
  { id: 'review', label: 'In Review / QA', color: 'blue', hint: 'Validate and ship' },
  { id: 'done', label: 'Done', color: 'green', hint: 'Verified outcomes' }
];
const priorityLabels = { urgent: 'P0 Urgent', high: 'P1 High', medium: 'P2 Medium', low: 'P3 Low' };
const priorityClass = { urgent: 'priority-urgent', high: 'priority-high', medium: 'priority-medium', low: 'priority-low' };

// Route metadata drives the shell instead of guessing from the pathname. Only
// workspace routes get board navigation; the task search only appears where it
// actually filters or leads to the board.
const ROUTES = {
  '/': { label: 'Home', group: 'Projects', workspace: true, search: true },
  '/board': { label: 'Kanban Board', group: 'Projects', workspace: true, search: true },
  '/backlog': { label: 'Sprint Backlog', group: 'Planning', workspace: true },
  '/automations': { label: 'Automations', group: 'Operations' },
  '/team': { label: 'Team & Workspace', group: 'Operations' },
  '/settings': { label: 'Settings', group: 'Operations' },
  '/profile': { label: 'Profile', group: 'Operations' },
  '/profile/edit': { label: 'Profile', group: 'Operations' }
};
function routeMetaOf(pathname) {
  return ROUTES[pathname] || { label: 'Page not found', group: '', workspace: false };
}
const SIDEBAR_STORAGE_KEY = 'leadai-sidebar-collapsed';
function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '';

function IconButton({ label, children, onClick, active = false }) {
  return <button className={`icon-button ${active ? 'is-active' : ''}`} aria-label={label} title={label} onClick={onClick}>{children}</button>;
}

function App() {
  const [pathname, setPathname] = useState(window.location.pathname);
  const [token, setToken] = useState(() => sessionStorage.getItem('leadai-session'));
  const [user, setUser] = useState(null);
  const [authError, setAuthError] = useState('');
  const [tasks, setTasks] = useState([]);
  const [boards, setBoards] = useState([]);
  const [activeBoardId, setActiveBoardId] = useState('');
  const [boardDialog, setBoardDialog] = useState(null);
  const [boardName, setBoardName] = useState('');
  const [boardBusy, setBoardBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [priority, setPriority] = useState('all');
  const [activeLabel, setActiveLabel] = useState('All');
  // The Copilot is a drawer with a dimming backdrop, so opening it is a user
  // choice: landing on the board with it covering the page made the board inert.
  const [copilotOpen, setCopilotOpen] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [modalStatus, setModalStatus] = useState('todo');
  const [editingTask, setEditingTask] = useState(null);
  const [viewMode, setViewMode] = useState('board');
  const [copilotInput, setCopilotInput] = useState('');
  const [copilotMessages, setCopilotMessages] = useState([
    { id: 'welcome', sender: 'assistant', role: 'assistant', text: 'Your board is synced. Ask me to create, triage, or summarize your work.', timestamp: Date.now() }
  ]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [dashboardRefresh, setDashboardRefresh] = useState(0);
  const [pendingTask, setPendingTask] = useState(null);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [homeAiFocus, setHomeAiFocus] = useState(0);
  const [aiConfigured, setAiConfigured] = useState(null);
  // The preference survives reloads; mobile uses a drawer regardless of it.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem(SIDEBAR_STORAGE_KEY) === 'true'; } catch { return false; }
  });
  const [isMobile, setIsMobile] = useState(() => (
    typeof window !== 'undefined' && window.matchMedia('(max-width: 900px)').matches
  ));
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const copilotButtonRef = useRef(null);
  const mobileNavButtonRef = useRef(null);
  const sidebarRef = useRef(null);

  // Copilot's status must be true on every page. The dashboard summary carries
  // the same flag, but it is only fetched on Home, which is how the drawer used
  // to claim "Connected" on a server with no AI provider.
  useEffect(() => {
    if (!token) { setAiConfigured(null); return undefined; }
    let cancelled = false;
    fetch(`${API_BASE_URL}/api/settings/env`, { headers: { Authorization: `Bearer ${token}` } })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => { if (!cancelled && payload) setAiConfigured(Boolean(payload.openrouterConfigured)); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [token]);

  // Closing returns focus to the control that opened the drawer, so a keyboard
  // user is not dropped at the top of the page.
  function closeCopilot() {
    setCopilotOpen(false);
    copilotButtonRef.current?.focus();
  }

  useEffect(() => {
    const handlePopState = () => {
      setPathname(window.location.pathname);
      const boardIdFromUrl = new URLSearchParams(window.location.search).get('boardId');
      if (boardIdFromUrl) setActiveBoardId(boardIdFromUrl);
    };
    window.addEventListener('popstate', handlePopState);
    const boardIdFromUrl = new URLSearchParams(window.location.search).get('boardId');
    if (boardIdFromUrl) setActiveBoardId(boardIdFromUrl);
    if (!token) {
      setLoading(false);
      return () => window.removeEventListener('popstate', handlePopState);
    }
    const authHeaders = { Authorization: `Bearer ${token}` };
    fetch(`${API_BASE_URL}/api/auth/current`, { headers: authHeaders })
      .then((response) => (response.ok ? response.json() : null))
      .then((profile) => setUser(profile))
      .catch(() => setUser(null));
    fetch(`${API_BASE_URL}/api/boards`, { headers: authHeaders })
      .then((response) => response.json())
      .then((list) => {
        setBoards(list);
        setActiveBoardId((current) => current || list[0]?.id || '');
      })
      .catch(() => setBoards([]));
    return () => window.removeEventListener('popstate', handlePopState);
  }, [token]);

  // One request per selected board. The previous version also fetched the default
  // board on mount, so every visit downloaded a board's tasks twice.
  useEffect(() => {
    if (!token) return undefined;
    if (!activeBoardId) {
      setTasks([]);
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    fetch(`${API_BASE_URL}/api/tasks?boardId=${encodeURIComponent(activeBoardId)}`, {
      headers: { Authorization: `Bearer ${token}` }
    }).then(async (response) => {
      if (response.status === 401) {
        sessionStorage.removeItem('leadai-session');
        setToken(null);
        return [];
      }
      if (!response.ok) return [];
      const data = await response.json();
      return Array.isArray(data) ? data : [];
    }).then((data) => { if (!cancelled) setTasks(data); })
      .catch(() => { if (!cancelled) setTasks([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token, activeBoardId]);

  useEffect(() => {
    setNotificationsOpen(false);
    // A new route starts at the top; without this a long Home page left the
    // next page scrolled halfway down with no visible heading.
    window.scrollTo(0, 0);
  }, [pathname]);

  useEffect(() => {
    const query = window.matchMedia('(max-width: 900px)');
    const handleChange = (event) => setIsMobile(event.matches);
    query.addEventListener('change', handleChange);
    return () => query.removeEventListener('change', handleChange);
  }, []);

  // The mobile drawer is modal: it traps Tab, closes on Escape, and gives focus
  // back to the menu button.
  useEffect(() => {
    if (!mobileNavOpen) return undefined;
    const panel = sidebarRef.current;
    const focusables = () => [...(panel?.querySelectorAll('button, a[href], select, input') || [])]
      .filter((element) => !element.disabled && element.offsetParent !== null);
    focusables()[0]?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    function handleKeyDown(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        setMobileNavOpen(false);
        mobileNavButtonRef.current?.focus();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusables();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [mobileNavOpen]);

  useEffect(() => {
    if (!isMobile) setMobileNavOpen(false);
  }, [isMobile]);

  useEffect(() => {
    if (!notificationsOpen) return undefined;
    function handlePointerDown(event) {
      if (event.target instanceof Element && !event.target.closest('.notification-wrap')) {
        setNotificationsOpen(false);
      }
    }
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [notificationsOpen]);

  useEffect(() => {
    if (!boards.length) {
      setActiveBoardId('');
    } else if (!boards.some((board) => board.id === activeBoardId)) {
      setActiveBoardId(boards[0].id);
    }
  }, [boards, activeBoardId]);

  // A dashboard task opens the existing board edit modal once that board's tasks
  // are loaded, so the task detail is always the real, server-backed record.
  useEffect(() => {
    if (!pendingTask || activeBoardId !== pendingTask.boardId) return;
    const task = tasks.find((item) => item.key === pendingTask.key);
    if (!task) return;
    setPendingTask(null);
    openEdit(task);
  }, [tasks, pendingTask, activeBoardId]);

  function switchBoard(boardId) {
    setActiveBoardId(boardId);
    // On Home the board selector is a workspace filter, not a navigation
    // control. Everywhere else it opens the board that was picked.
    if (pathname !== '/') navigate('/board');
  }

  async function signOut() {
    try {
      if (token) {
        await fetch(`${API_BASE_URL}/api/auth/signout`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` }
        });
      }
    } catch {
      // Clearing the local session is still the right outcome when the API is
      // unreachable; the token will simply expire on the server.
    }
    sessionStorage.removeItem('leadai-session');
    setNotificationsOpen(false);
    setToken(null);
    setUser(null);
  }

  function openBoardDialog(mode) {
    const activeBoard = boards.find((board) => board.id === activeBoardId);
    setBoardName(mode === 'rename' ? activeBoard?.name || '' : '');
    setBoardDialog(mode);
  }

  async function saveBoard(event) {
    event.preventDefault();
    if (!boardName.trim() || boardBusy) return;
    setBoardBusy(true);
    setAuthError('');
    try {
      const response = await fetch(`${API_BASE_URL}${boardDialog === 'rename' ? `/api/boards/${activeBoardId}` : '/api/boards'}`, {
        method: boardDialog === 'rename' ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: boardName.trim() })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Could not save board.');
      const listResponse = await fetch(`${API_BASE_URL}/api/boards`, { headers: { Authorization: `Bearer ${token}` } });
      const list = await listResponse.json();
      setBoards(list);
      if (boardDialog === 'create') {
        setActiveBoardId(payload.id);
        setDashboardRefresh((value) => value + 1);
      }
      setBoardDialog(null);
      setBoardName('');
    } catch (error) {
      setAuthError(error.message);
    } finally {
      setBoardBusy(false);
    }
  }

  function navigate(path) {
    window.history.pushState({}, '', path);
    setPathname(path);
    setMobileNavOpen(false);
  }

  function toggleSidebar() {
    setSidebarCollapsed((current) => {
      const next = !current;
      try { localStorage.setItem(SIDEBAR_STORAGE_KEY, String(next)); } catch { /* storage is optional */ }
      return next;
    });
  }

  function closeMobileNav() {
    setMobileNavOpen(false);
    mobileNavButtonRef.current?.focus();
  }

  function handleSessionExpired() {
    sessionStorage.removeItem('leadai-session');
    window.history.replaceState({}, '', '/');
    setPathname('/');
    setToken(null);
    setUser(null);
  }

  // One place for authenticated calls: an expired session signs the user out
  // instead of surfacing a misleading "could not save" error on every form.
  async function apiFetch(path, options = {}) {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      ...options,
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        Authorization: `Bearer ${token}`,
        ...(options.headers || {})
      }
    });
    if (response.status === 401) {
      handleSessionExpired();
      const expired = new Error('Your session expired. Please sign in again.');
      expired.status = 401;
      throw expired;
    }
    return response;
  }

  function openDashboardBoard(id) {
    if (!id) return;
    setActiveBoardId(id);
    navigate('/board');
  }

  function openDashboardTask(task) {
    if (!task?.key || !task.boardId) return;
    setPendingTask({ key: task.key, boardId: task.boardId });
    setActiveBoardId(task.boardId);
    navigate('/board');
  }

  async function handleGeneratedBoard(board) {
    if (!board?.id) return;
    try {
      const response = await fetch(`${API_BASE_URL}/api/boards`, { headers: { Authorization: `Bearer ${token}` } });
      if (response.ok) setBoards(await response.json());
    } catch {
      // The board route fetches its own data; navigation must not be blocked here.
    }
    openDashboardBoard(board.id);
  }

  const labels = useMemo(() => [...new Set(tasks.flatMap((task) => task.labels || []))].slice(0, 5), [tasks]);
  const filteredTasks = useMemo(() => tasks.filter((task) => {
    const matchesQuery = `${task.key} ${task.title} ${task.description} ${task.assignee}`.toLowerCase().includes(query.toLowerCase());
    const matchesPriority = priority === 'all' || task.priority === priority;
    const matchesLabel = activeLabel === 'All' || (task.labels || []).includes(activeLabel);
    return matchesQuery && matchesPriority && matchesLabel;
  }), [tasks, query, priority, activeLabel]);
  const completed = Array.isArray(tasks) ? tasks.filter((task) => task.status === 'done').length : 0;
  const inFlight = Array.isArray(tasks) ? tasks.filter((task) => task.status === 'progress').length : 0;
  const completionRate = Array.isArray(tasks) && tasks.length ? Math.round((completed / tasks.length) * 100) : 0;
  const activeBoard = boards.find((board) => board.id === activeBoardId) || null;
  const isHome = pathname === '/';
  const routeMeta = routeMetaOf(pathname);
  const sidebarIsCollapsed = sidebarCollapsed && !isMobile;
  const now = new Date();
  const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const overdueBoardTasks = tasks.filter((task) => (
    task.status !== 'done' && isCalendarDate(task.dueDate) && task.dueDate < todayIso
  ));
  // One progress number, one name, everywhere. Sprint completion is a
  // different metric and stays on the Sprint Backlog where it is scoped.
  const shellProgress = completionRate;

  function updateProfileUser(profile) {
    setUser((current) => ({ ...(current || {}), ...profile }));
  }

  async function updateTask(key, data) {
    const previous = tasks.find((task) => task.key === key) ?? null;
    setTasks((current) => current.map((task) => task.key === key ? { ...task, ...data } : task));
    try {
      const response = await apiFetch(`/api/tasks/${key}`, { method: 'PATCH', body: JSON.stringify(data) });
      if (response.ok) return;
      const payload = await response.json().catch(() => null);
      setAuthError(payload?.error || `Could not update the task (HTTP ${response.status}).`);
    } catch (error) {
      setAuthError(error.status === 401 ? error.message : 'Could not reach the server. The task was not updated.');
    }
    // Roll the optimistic change back to the last server-confirmed value so a rejected
    // transition never leaves the board showing a move that the API refused.
    setTasks((current) => current.map((task) => task.key === key && previous ? previous : task));
  }

  async function createTask(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const estimate = Number(form.get('estimateHours'));
    const payload = { title: form.get('title'), description: form.get('description'), status: modalStatus, priority: form.get('priority'), labels: [form.get('label') || 'General'], assigneeId: form.get('assigneeId') || null, assignee: form.get('assignee') || null, dueDate: form.get('dueDate') || null, boardId: activeBoardId, estimateHours: Number.isFinite(estimate) ? estimate : 0 };
    try {
      const response = await apiFetch('/api/tasks', { method: 'POST', body: JSON.stringify(payload) });
      const task = await response.json().catch(() => ({}));
      if (!response.ok) return setAuthError(task.error || 'Could not create task.');
      setTasks((current) => [...current, task]);
      setShowModal(false);
    } catch (error) {
      setAuthError(error.status === 401 ? error.message : 'Could not reach the server. The task was not created.');
    }
  }

  function openCreate(status) {
    setEditingTask(null);
    setModalStatus(status);
    setShowModal(true);
  }

  function openEdit(task) {
    setEditingTask(task);
    setModalStatus(task.status);
    setShowModal(true);
  }

  async function saveTask(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const estimate = Number(form.get('estimateHours'));
    const payload = {
      title: form.get('title'),
      description: form.get('description'),
      status: modalStatus,
      priority: form.get('priority'),
      labels: [form.get('label') || 'General'],
      assigneeId: form.get('assigneeId') || null,
      assignee: form.get('assignee') || null,
      dueDate: form.get('dueDate') || null,
      boardId: activeBoardId,
      estimateHours: Number.isFinite(estimate) ? estimate : 0
    };
    try {
      const response = await apiFetch(`/api/tasks/${editingTask.key}`, { method: 'PATCH', body: JSON.stringify(payload) });
      const task = await response.json().catch(() => ({}));
      if (!response.ok) return setAuthError(task.error || 'Could not update task.');
      setTasks((current) => current.map((item) => item.key === task.key ? task : item));
      setShowModal(false);
      setEditingTask(null);
    } catch (error) {
      setAuthError(error.status === 401 ? error.message : 'Could not reach the server. The task was not updated.');
    }
  }

  async function deleteTask(task) {
    if (!window.confirm(`Delete "${task.title}"? This cannot be undone.`)) return;
    try {
      const response = await apiFetch(`/api/tasks/${task.key}`, { method: 'DELETE' });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        return setAuthError(payload.error || 'Could not delete task.');
      }
      setTasks((current) => current.filter((item) => item.key !== task.key));
    } catch (error) {
      setAuthError(error.status === 401 ? error.message : 'Could not reach the server. The task was not deleted.');
    }
  }

  if (pathname === '/verify-email') {
    const next = token ? '/' : '/signin';
    return <VerifyEmailPage
      signedIn={Boolean(token)}
      onContinue={() => {
        window.history.replaceState({}, '', next);
        setPathname(next);
      }}
    />;
  }

  if (!token) {
    return <AuthScreen onAuthenticated={(nextToken) => { sessionStorage.setItem('leadai-session', nextToken); setToken(nextToken); }} />;
  }

  async function sendCopilot(event) {
    event.preventDefault();
    const message = copilotInput.trim();
    if (!message || isAnalyzing) return;

    setCopilotMessages((current) => [...current, {
      id: `user-${Date.now()}`,
      sender: 'user',
      role: 'user',
      text: message,
      timestamp: Date.now(),
    }]);
    setCopilotInput('');
    setIsAnalyzing(true);

    try {
      const response = await fetch(`${API_BASE_URL}/api/copilot/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ message, boardId: activeBoardId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Copilot request failed.');
      if (data.action?.type === 'created' || data.action?.type === 'updated' || data.action?.type === 'created_many' || data.action?.type === 'updated_many') {
        const refreshed = await fetch(`${API_BASE_URL}/api/tasks?boardId=${encodeURIComponent(activeBoardId)}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (refreshed.ok) setTasks(await refreshed.json());
      }
      setCopilotMessages((current) => [...current, {
        id: `assistant-${Date.now()}`,
        sender: 'assistant',
        role: 'assistant',
        text: data.reply,
        timestamp: Date.now(),
      }]);
    } catch (error) {
      console.error('Copilot API error:', error);
      // Add error message
      setCopilotMessages((current) => [...current, {
        id: `assistant-error-${Date.now()}`,
        sender: 'assistant',
        role: 'assistant',
        text: `Sorry, I encountered an error: ${error.message}. Please try again later.`,
        timestamp: Date.now(),
      }]);
    } finally {
      setIsAnalyzing(false);
    }
  }

  function handleDrop(event, status) {
    event.preventDefault();
    const key = event.dataTransfer.getData('text/plain');
    if (key) updateTask(key, { status });
  }

  return <div className={`app-shell ${sidebarIsCollapsed ? 'is-sidebar-collapsed' : ''}`}>
    <a className="skip-link" href="#main-content">Skip to main content</a>
    <header className="topbar">
      <button
        ref={mobileNavButtonRef}
        type="button"
        className="mobile-nav-button"
        aria-label={mobileNavOpen ? 'Close navigation' : 'Open navigation'}
        aria-expanded={mobileNavOpen}
        aria-controls="app-sidebar"
        onClick={() => setMobileNavOpen((open) => !open)}
      >
        {mobileNavOpen ? <X size={18} /> : <Menu size={18} />}
      </button>
      <button className="brand-lockup" onClick={() => navigate('/')} aria-label="LeadAI home"><div className="logo-mark" aria-hidden="true"><span></span><span></span><span></span></div><strong>LeadAI</strong></button>
      <div className="topbar-actions">
        {routeMeta.search && <label className="global-search"><Search size={15} aria-hidden="true" /><input placeholder="Search tasks..." aria-label="Search tasks" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && isHome) { event.preventDefault(); navigate('/board'); } }} /></label>}
        <div className="notification-wrap">
          <IconButton label={overdueBoardTasks.length ? `Notifications: ${overdueBoardTasks.length} overdue` : 'Notifications'} active={notificationsOpen} onClick={() => setNotificationsOpen((open) => !open)}>
            <Bell size={16} />
            {overdueBoardTasks.length > 0 && <span className="home-notification-dot" aria-hidden="true" />}
          </IconButton>
          {notificationsOpen && (
            <>
              <section className="home-notifications" role="dialog" aria-label="Notifications">
                <header>
                  <div>
                    <strong>Notifications</strong>
                    <span>{overdueBoardTasks.length ? `${overdueBoardTasks.length} overdue on ${activeBoard?.name || 'this board'}` : `No overdue tasks on ${activeBoard?.name || 'this board'}`}</span>
                  </div>
                  <button type="button" onClick={() => setNotificationsOpen(false)} aria-label="Close notifications"><X size={14} /></button>
                </header>
                {overdueBoardTasks.length ? (
                  <ul>
                    {overdueBoardTasks.slice(0, 4).map((task) => (
                      <li key={task.key}>
                        <button type="button" onClick={() => { setNotificationsOpen(false); openDashboardTask(task); }}>
                          <span className="home-notification-icon"><AlertTriangle size={13} aria-hidden="true" /></span>
                          <span><strong>{task.key} · {task.title}</strong><small>Due {task.dueDate} · {task.assignee || 'Unassigned'}</small></span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="home-notifications-empty"><Check size={14} aria-hidden="true" /> You are clear. No overdue tasks on this board.</p>
                )}
                <footer><button type="button" onClick={() => { setNotificationsOpen(false); navigate('/backlog'); }}>Open sprint backlog <ArrowRight size={12} aria-hidden="true" /></button></footer>
              </section>
            </>
          )}
        </div>
        <button type="button" className="text-button" onClick={signOut}>Sign Out</button>
        <button type="button" className="profile-avatar" aria-label={user?.name ? `${initialsOf(user.name)} — your profile` : 'Your profile'} title="Your profile" onClick={() => navigate('/profile')}>{user?.avatar ? <img src={user.avatar} alt="" /> : <span aria-hidden="true">{initialsOf(user?.name)}</span>}<span className="profile-status-dot" aria-hidden="true" /></button>
      </div>
    </header>
    <div className="workspace-layout">
      <aside
        ref={sidebarRef}
        id="app-sidebar"
        className={`sidebar ${sidebarIsCollapsed ? 'is-collapsed' : ''} ${mobileNavOpen ? 'is-mobile-open' : ''}`}
        aria-label="Primary navigation"
        inert={isMobile && !mobileNavOpen ? true : undefined}
      >
        <div className="sidebar-header">
          <span className="sidebar-heading">{isMobile ? 'Navigation' : 'Workspace'}</span>
          <button
            type="button"
            className="sidebar-toggle"
            onClick={isMobile ? closeMobileNav : toggleSidebar}
            aria-label={isMobile ? 'Close navigation' : sidebarIsCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={isMobile ? undefined : !sidebarIsCollapsed}
            aria-controls="app-sidebar"
            title={isMobile ? 'Close navigation' : sidebarIsCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {isMobile ? <X size={17} /> : sidebarIsCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
          </button>
        </div>
        <nav className="sidebar-nav" aria-label="Sections">
          <div className="nav-section"><div className="nav-label">Projects</div><NavItem active={pathname === '/'} onClick={() => navigate('/')} icon={<LayoutGrid size={16} />} label="Home" /><NavItem active={pathname === '/board'} onClick={() => navigate('/board')} icon={<Target size={16} />} label="Kanban Board" /><NavItem active={pathname === '/backlog'} onClick={() => navigate('/backlog')} icon={<List size={16} />} label="Sprint Backlog" /></div>
          <div className="nav-section"><div className="nav-label">Operations</div><NavItem active={pathname === '/automations'} onClick={() => navigate('/automations')} icon={<Sparkles size={16} />} label="Automations" /><NavItem active={pathname === '/team'} onClick={() => navigate('/team')} icon={<Users size={16} />} label="Team & Workspace" /><NavItem active={pathname === '/settings'} onClick={() => navigate('/settings')} icon={<Settings2 size={16} />} label="Settings" /><NavItem active={pathname === '/profile' || pathname === '/profile/edit'} onClick={() => navigate('/profile')} icon={<UserRound size={16} />} label="Profile" /></div>
        </nav>
        <div className="sidebar-footer"><div className="quota-card"><div className="quota-copy"><span>Board completion</span><strong>{shellProgress}%</strong></div><div className="quota-bar" role="progressbar" aria-label="Board completion" aria-valuemin={0} aria-valuemax={100} aria-valuenow={shellProgress}><span style={{ width: `${shellProgress}%` }} /></div></div><div className={`ai-active ${aiConfigured === false ? 'is-offline' : ''}`}><span aria-hidden="true"></span>{aiConfigured === false ? 'AI Copilot Offline' : aiConfigured ? 'AI Copilot Active' : 'AI Copilot'}<Zap size={14} aria-hidden="true" /></div></div>
      </aside>
      {isMobile && mobileNavOpen && <button type="button" className="mobile-nav-backdrop" aria-label="Close navigation" onClick={closeMobileNav} tabIndex={-1} />}
      <main className="main-content" id="main-content" tabIndex={-1}>
        {routeMeta.workspace && <div className="workspace-bar">
          <nav className="workspace-crumbs" aria-label="Breadcrumb">
            <span>Workspace</span><ChevronRight size={12} aria-hidden="true" />
            <span>{routeMeta.group}</span><ChevronRight size={12} aria-hidden="true" />
            <strong aria-current="page">{routeMeta.label}</strong>
          </nav>
          <div className="workspace-controls">
            <label className="board-name-control">
              <span className="workspace-dot" aria-hidden="true"></span>
              <select value={activeBoardId} onChange={(event) => switchBoard(event.target.value)} aria-label="Current kanban board" disabled={!boards.length}>
                <option value="">{boards.length ? 'Select a board' : 'No boards yet'}</option>
                {boards.map((board) => <option key={board.id} value={board.id}>{board.name}</option>)}
              </select>
              <ChevronDown size={13} aria-hidden="true" />
            </label>
            {boards.find((board) => board.id === activeBoardId)?.isOwner && <button type="button" className="board-edit-button" onClick={() => openBoardDialog('rename')} aria-label="Rename current board" title="Rename current board"><Pencil size={13} /></button>}
            <button type="button" className="board-control-button" onClick={() => openBoardDialog('create')} aria-label="New board" title="New board"><Plus size={14} aria-hidden="true" /> <span>New board</span></button>
          </div>
        </div>}
        <div className={`page-body ${isHome ? 'is-home-body' : ''}`}>
          {authError && <div className="form-error" role="alert">{authError}<button type="button" onClick={() => setAuthError('')} aria-label="Dismiss error"><X size={13} /></button></div>}
          {pathname === '/' ? <Dashboard
            token={token}
            user={user}
            refreshKey={dashboardRefresh}
            navigate={navigate}
            onOpenBoard={openDashboardBoard}
            onOpenTask={openDashboardTask}
            onCreateBoard={() => openBoardDialog('create')}
            onGeneratedBoard={handleGeneratedBoard}
            onSessionExpired={handleSessionExpired}
            activeBoardId={activeBoardId}
            boards={boards}
            boardTasks={tasks}
            focusAiKey={homeAiFocus}
          /> : pathname === '/backlog' ? <SprintBacklog token={token} /> : pathname === '/team' ? <BoardManager token={token} boards={boards} setBoards={setBoards} activeBoardId={activeBoardId} navigate={navigate} /> : pathname === '/profile' ? <ProfilePage token={token} navigate={navigate} /> : pathname === '/profile/edit' ? <ProfileEditPage token={token} navigate={navigate} onUserChange={updateProfileUser} /> : pathname === '/settings' ? <SettingsPage token={token} user={user} navigate={navigate} onSignOut={signOut} /> : pathname !== '/board' ? <RoutePage pathname={pathname} navigate={navigate} user={user} /> : boards.length === 0 ? <BoardEmptyState onCreate={() => openBoardDialog('create')} onManage={() => navigate('/team')} /> : <>
          <section className="page-heading"><div><div className="eyebrow">Your workspace</div><h1>{activeBoard?.name || (user?.name ? `${user.name}'s board` : 'My board')}</h1><p>Organize your work, track progress, and keep everything moving.</p></div><div className="heading-actions"><button type="button" ref={copilotButtonRef} className="secondary-button" aria-expanded={copilotOpen} onClick={() => setCopilotOpen(!copilotOpen)}><Bot size={15} /> {copilotOpen ? 'Hide' : 'Show'} Copilot</button><button className="primary-button" onClick={() => openCreate('todo')}><Plus size={16} /> Add Task</button></div></section>
          <div className="metric-badges board-metrics"><Metric label="Total" value={`${tasks.length} Tasks`} /><Metric label="In Flight" value={inFlight} dot="cyan" /><Metric label="Completed" value={completed} dot="green" /></div>
          <section className="control-bar"><label className="filter-search"><Search size={15} /><input placeholder="Filter tasks, branches, tickets..." value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Filter tasks" /></label><div className="avatar-stack"><span>{initialsOf(user?.name)}</span></div><div className="label-filters"><button className={activeLabel === 'All' ? 'selected' : ''} onClick={() => setActiveLabel('All')}>All ({tasks.length})</button>{labels.map((label) => <button key={label} className={activeLabel === label ? 'selected' : ''} onClick={() => setActiveLabel(label)}><i></i>{label}</button>)}</div><div className="view-controls"><Filter size={14} /><select aria-label="Filter by priority" value={priority} onChange={(event) => setPriority(event.target.value)}><option value="all">Priority: All</option><option value="urgent">P0 - Urgent</option><option value="high">P1 - High</option><option value="medium">P2 - Medium</option><option value="low">P3 - Low</option></select><IconButton label="Kanban view" active={viewMode === 'board'} onClick={() => setViewMode('board')}><LayoutGrid size={16} /></IconButton><IconButton label="List view" active={viewMode === 'list'} onClick={() => setViewMode('list')}><List size={16} /></IconButton></div></section>
          <div className="board-layout"><section className={viewMode === 'list' ? 'task-list-view' : 'board-canvas'}>{loading ? <div className="loading-state">Loading your sprint board...</div> : viewMode === 'list' ? <TaskList tasks={filteredTasks} onMove={updateTask} onEdit={openEdit} onDelete={deleteTask} /> : columns.map((column) => <BoardColumn key={column.id} column={column} tasks={filteredTasks.filter((task) => task.status === column.id)} onDrop={handleDrop} onAdd={() => openCreate(column.id)} onMove={updateTask} onEdit={openEdit} onDelete={deleteTask} />)}</section></div>{copilotOpen && (<><div className="copilot-backdrop is-open" onClick={closeCopilot}></div><aside className="copilot is-open" role="dialog" aria-modal="true" aria-labelledby="copilot-title"><Copilot messages={copilotMessages} input={copilotInput} setInput={setCopilotInput} onSubmit={sendCopilot} onClose={closeCopilot} isAnalyzing={isAnalyzing} aiConfigured={aiConfigured} /></aside></>)}
          {showModal && <TaskModal status={modalStatus} task={editingTask} onClose={() => { setShowModal(false); setEditingTask(null); }} onSubmit={editingTask ? saveTask : createTask} assignees={boards.find((board) => board.id === activeBoardId)?.members?.map((member) => member.name) || (user?.name ? [user.name] : [])} />}
          </>}
          {boardDialog && <BoardDialog mode={boardDialog} name={boardName} setName={setBoardName} busy={boardBusy} onClose={() => setBoardDialog(null)} onSubmit={saveBoard} />}
        </div>
      </main>
    </div>
  </div>;
}

function NavItem({ icon, label, active, onClick }) {
  return <button
    type="button"
    className={`nav-item ${active ? 'active' : ''}`}
    aria-label={label}
    aria-current={active ? 'page' : undefined}
    data-tooltip={label}
    onClick={onClick}
  >{icon}<span>{label}</span></button>;
}
function Metric({ label, value, dot, icon }) { return <div className="metric"><span>{dot && <i className={`metric-dot ${dot}`}></i>}{icon}{label}</span><strong>{value}</strong></div>; }
function BoardColumn({ column, tasks, onDrop, onAdd, onMove, onEdit, onDelete }) { return <div className={`board-column column-${column.color}`} onDragOver={(event) => event.preventDefault()} onDrop={(event) => onDrop(event, column.id)}><div className="column-header"><div><span className="column-title"><i></i>{column.label}<b>{tasks.length}</b></span><small>{column.hint}</small></div><IconButton label={`Add task to ${column.label}`} onClick={onAdd}><Plus size={17} /></IconButton></div><div className="task-list">{tasks.map((task) => <TaskCard key={task.key} task={task} onMove={onMove} onEdit={onEdit} onDelete={onDelete} />)}{tasks.length === 0 && <div className="empty-column">Drop work here</div>}</div></div>; }
function formatDue(value) {
  if (!value) return 'Unscheduled';
  // Parse date-only values in local time; `new Date('2026-10-19')` is UTC and
  // renders as the previous day west of Greenwich.
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
function TaskCard({ task, onMove, onEdit, onDelete }) { return <article className={`task-card ${task.status === 'done' ? 'is-done' : ''}`} draggable onDragStart={(event) => event.dataTransfer.setData('text/plain', task.key)}><div className="task-topline"><span className="task-key">#{task.key}</span><span className={`priority ${priorityClass[task.priority]}`}>{priorityLabels[task.priority]}</span></div><h3>{task.title}</h3><p>{task.description}</p><div className="task-labels">{(task.labels || []).map((label) => <span key={label}>{label}</span>)}</div>{task.aiSuggested && <div className="ai-note"><Sparkles size={12} /> AI suggested</div>}<div className="task-footer"><div className="task-footer-details"><span className="assignee"><i>{initialsOf(task.assignee)}</i><b>{task.assignee}</b></span><span className="task-meta"><CalendarDays size={13} />{task.dueDate ? formatDue(task.dueDate) : 'No due date'}</span></div><div className="task-footer-actions"><select className="status-select" aria-label={`Move ${task.key}`} value={task.status} onChange={(event) => onMove(task.key, { status: event.target.value })}>{columns.map((column) => <option key={column.id} value={column.id}>{column.label}</option>)}</select><button type="button" className="task-menu" aria-label={`Edit ${task.key}`} onClick={() => onEdit(task)}><MoreHorizontal size={15} /></button><button type="button" className="task-menu" aria-label={`Delete ${task.key}`} onClick={() => onDelete(task)}><Trash2 size={14} /></button></div></div></article>; }
function TaskList({ tasks, onMove, onEdit, onDelete }) { return <div className="task-table"><div className="task-table-head"><span>Task</span><span>Status</span><span>Priority</span><span>Assignee</span><span>Due</span><span>Actions</span></div>{tasks.length ? tasks.map((task) => <div className="task-table-row" key={task.key}><div><strong>#{task.key}</strong><span>{task.title}</span></div><select aria-label={`Status for ${task.key}`} value={task.status} onChange={(event) => onMove(task.key, { status: event.target.value })}>{columns.map((column) => <option key={column.id} value={column.id}>{column.label}</option>)}</select><span className={`priority ${priorityClass[task.priority]}`}>{priorityLabels[task.priority]}</span><span>{task.assignee}</span><span>{task.dueDate}</span><span className="row-actions"><button type="button" onClick={() => onEdit(task)}>Edit</button><button type="button" onClick={() => onDelete(task)}>Delete</button></span></div>) : <div className="empty-column">No tasks match the current filters.</div>}</div>; }
function BoardEmptyState({ onCreate, onManage }) {
  return <section className="board-empty-state"><div className="board-empty-icon"><LayoutGrid size={25} /></div><div className="eyebrow">Your workspace is ready</div><h1>Create your first kanban board</h1><p>Boards keep projects, tasks, and collaborators organized. Create one now to start planning your work.</p><div className="board-empty-actions"><button className="primary-button" onClick={onCreate}><Plus size={16} /> Create a board</button><button className="secondary-button" onClick={onManage}>Open board management</button></div></section>;
}
function BoardDialog({ mode, name, setName, busy, onClose, onSubmit }) {
  const isRename = mode === 'rename';
  const dialogRef = useRef(null);
  const nameRef = useRef(null);
  useDialogKeyboard(dialogRef, onClose);
  // React's autoFocus is not reliable here, and a modal that opens without
  // moving focus leaves a keyboard user tabbing behind the backdrop.
  useEffect(() => { nameRef.current?.focus(); }, []);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}><form ref={dialogRef} className="task-modal board-dialog" role="dialog" aria-modal="true" aria-labelledby="board-modal-title" onSubmit={onSubmit}><div className="modal-heading"><div><div className="eyebrow">{isRename ? 'Board settings' : 'New board'}</div><h2 id="board-modal-title">{isRename ? 'Rename board' : 'Create a board'}</h2></div><button type="button" className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={17} /></button></div><p className="board-dialog-copy">{isRename ? 'Choose a name that helps your team recognize this workspace.' : 'Give your new workspace a clear name. You can invite collaborators after it is created.'}</p><label>Board name<input ref={nameRef} value={name} onChange={(event) => setName(event.target.value)} maxLength={120} placeholder="e.g. Website launch" required /></label><div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button type="submit" className="primary-button" disabled={busy}>{busy ? 'Saving...' : isRename ? 'Save name' : 'Create board'}</button></div></form></div>;
}
function Copilot({ messages, input, setInput, onSubmit, onClose, isAnalyzing, aiConfigured }) {
  const streamRef = useRef(null);
  const panelRef = useRef(null);
  const composerRef = useRef(null);
  const offline = aiConfigured === false;
  useDialogKeyboard(panelRef, onClose);

  useEffect(() => {
    // A disabled composer cannot take focus, so an offline drawer starts on its
    // first working control (Close) instead of leaving focus behind the scrim.
    const composer = composerRef.current;
    if (composer && !composer.disabled) composer.focus();
    else panelRef.current?.querySelector('button')?.focus();
  }, []);

  useEffect(() => {
    const stream = streamRef.current;
    if (stream) stream.scrollTo({ top: stream.scrollHeight, behavior: 'smooth' });
  }, [messages, isAnalyzing]);

  const formatTime = (timestamp) => {
    if (!timestamp) return 'Just now';
    const diff = Date.now() - timestamp;
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    return `${Math.floor(diff / 3600000)}h ago`;
  };

  function handleKeyDown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  return <div className="copilot-content" ref={panelRef}>
    <div className="copilot-header">
      <div className="copilot-title"><span className="copilot-icon"><Bot size={17} /></span><div><strong id="copilot-title">LeadAI Copilot</strong><small className={offline ? 'is-offline' : ''}><i aria-hidden="true" />{offline ? 'No AI provider configured' : 'Connected'}</small></div></div>
      <div className="copilot-actions">{!offline && <span className="copilot-live-badge">Live</span>}<IconButton label="Close Copilot" onClick={onClose}><X size={16} /></IconButton></div>
    </div>
    <div className="chat-stream" ref={streamRef} aria-live="polite">
      {offline && (
        <div className="chat-message assistant">
          <span className="message-icon"><Sparkles size={13} /></span>
          <div className="chat-bubble"><p>Copilot needs an AI provider before it can answer. An administrator can add one in Settings; the board keeps working without it.</p><small>LeadAI Copilot</small></div>
        </div>
      )}
      {messages.filter((message) => !(offline && message.id === 'welcome')).map((message) => <div key={message.id} className={`chat-message ${message.sender || message.role}`}>
        {message.sender === 'assistant' || message.role === 'assistant' ? <span className="message-icon"><Sparkles size={13} /></span> : null}
        <div className="chat-bubble"><p>{message.text}</p><small>{message.sender === 'assistant' || message.role === 'assistant' ? 'LeadAI Copilot' : formatTime(message.timestamp)}</small></div>
      </div>)}
      {isAnalyzing && <div className="chat-message assistant thinking-message"><span className="message-icon"><Sparkles size={13} /></span><div className="chat-bubble"><span>LeadAI Copilot is thinking</span><span className="thinking-dots"><i></i><i></i><i></i></span></div></div>}
    </div>
    <form className="copilot-input" onSubmit={onSubmit}>
      <div className={`copilot-status ${offline ? 'is-offline' : ''}`}>{offline ? <AlertTriangle size={12} /> : <Check size={12} />} {offline ? 'An administrator can connect an AI provider in Settings' : 'Board context is current'}</div>
      <div className="copilot-composer"><textarea ref={composerRef} rows="1" aria-label="Message LeadAI Copilot" placeholder={offline ? 'Copilot is unavailable until an AI provider is configured' : 'Ask me to create, move, or update a task...'} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={handleKeyDown} disabled={isAnalyzing || offline} /><button type="submit" aria-label="Send Copilot message" disabled={isAnalyzing || offline || !input.trim()}>{isAnalyzing ? <LoaderCircle className="spin" size={17} /> : <ArrowRight size={17} />}</button></div>
      <small>Enter to send · Shift+Enter for a new line</small>
    </form>
  </div>;
}
function BoardManager({ token, boards, setBoards, navigate }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [modal, setModal] = useState(null);
  const [selectedBoard, setSelectedBoard] = useState(null);
  const [menuBoardId, setMenuBoardId] = useState(null);
  const [stats, setStats] = useState({});
  const [busy, setBusy] = useState(false);
  const authHeaders = { Authorization: `Bearer ${token}` };
  async function request(path, options = {}) {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(options.headers || {}) }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'Board request failed.');
    return body;
  }
  async function refresh() { setBoards(await request('/api/boards')); }
  // The dashboard summary already aggregates every accessible board, so one
  // request replaces the previous one-per-board task download.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/api/dashboard/summary`, { headers: authHeaders });
        if (!response.ok) return;
        const summary = await response.json();
        if (cancelled) return;
        const entries = (summary.boards || []).map((board) => [board.id, {
          total: board.totalTasks || 0,
          done: Math.max(0, (board.totalTasks || 0) - (board.openTasks || 0)),
          updatedAt: board.updatedAt ? new Date(board.updatedAt).getTime() : 0
        }]);
        setStats(Object.fromEntries(entries));
      } catch {
        // The cards still render with zeroed stats if the summary is unavailable.
      }
    })();
    return () => { cancelled = true; };
  }, [boards]);
  async function create(event) {
    event.preventDefault();
    if (!name.trim()) return;
    try { setBusy(true); await request('/api/boards', { method: 'POST', body: JSON.stringify({ name: name.trim() }) }); setName(''); setError(''); setModal(null); await refresh(); }
    catch (requestError) { setError(requestError.message); }
    finally { setBusy(false); }
  }
  async function rename(board) {
    const nextName = window.prompt('New board name', board.name);
    if (!nextName?.trim()) return;
    try { await request(`/api/boards/${board.id}`, { method: 'PATCH', body: JSON.stringify({ name: nextName.trim() }) }); setError(''); await refresh(); }
    catch (requestError) { setError(requestError.message); }
  }
  async function remove(board) {
    if (!window.confirm(`Delete "${board.name}" and its tasks? This cannot be undone.`)) return;
    try { await request(`/api/boards/${board.id}`, { method: 'DELETE' }); setError(''); setMenuBoardId(null); await refresh(); }
    catch (requestError) { setError(requestError.message); }
  }
  async function invite(event) {
    event.preventDefault();
    if (!selectedBoard) return;
    try { setBusy(true); await request(`/api/boards/${selectedBoard.id}/members`, { method: 'POST', body: JSON.stringify({ email: email.trim() }) }); setEmail(''); setError(''); setModal(null); await refresh(); }
    catch (requestError) { setError(requestError.message); }
    finally { setBusy(false); }
  }
  const owned = boards.filter((board) => board.isOwner);
  const shared = boards.filter((board) => !board.isOwner);
  const initials = (person) => String(person.name || person.email || '?').split(/\s+/).map((part) => part[0]).slice(0, 2).join('').toUpperCase();
  const formatActive = (timestamp) => timestamp ? `${Math.max(1, Math.round((Date.now() - timestamp) / 86400000))}d ago` : 'No activity yet';
  const renderCard = (board) => {
    const stat = stats[board.id] || { total: 0, done: 0, updatedAt: 0 };
    const percent = stat.total ? Math.round((stat.done / stat.total) * 100) : 0;
    return <article className="team-board-card" key={board.id}>
      <div className="team-board-card-head"><span className={`team-role-badge ${board.isOwner ? 'is-owner' : ''}`}>{board.isOwner ? 'Owner' : 'Member'}</span><div className="team-menu-wrap"><button className="team-icon-button" onClick={() => setMenuBoardId(menuBoardId === board.id ? null : board.id)} aria-label={`Actions for ${board.name}`}><MoreHorizontal size={18} /></button>{menuBoardId === board.id && <div className="team-action-menu"><button onClick={() => rename(board)}><Pencil size={14} /> Rename</button>{board.isOwner && <button className="is-danger" onClick={() => remove(board)}><Trash2 size={14} /> Delete</button>}</div>}</div></div>
      <button className="team-board-open" onClick={() => navigate(`/board?boardId=${encodeURIComponent(board.id)}`)}><h3>{board.name}</h3><p>{board.isOwner ? 'Your workspace board for focused delivery.' : 'A board shared with you for collaboration.'}</p><div className="team-board-meta"><span><Users size={14} /> {board.memberIds.length} member{board.memberIds.length === 1 ? '' : 's'}</span><span><Clock3 size={14} /> {formatActive(stat.updatedAt)}</span></div></button>
      <div className="team-board-footer"><div className="team-member-stack">{(board.members || []).slice(0, 4).map((member) => <span key={member.id} title={member.email}>{initials(member)}</span>)}{board.members?.length > 4 && <span className="is-more">+{board.members.length - 4}</span>}</div><span className="team-completion"><Check size={13} /> {percent}% complete</span></div>
      {board.isOwner && <button className="team-invite-link" onClick={() => { setSelectedBoard(board); setModal('invite'); }}><Mail size={14} /> Add member</button>}
    </article>;
  };
  return <section className="route-page team-page"><div className="team-page-header"><div><div className="eyebrow">Team & Workspace</div><h1>Workspace & Boards</h1><p>Organize ownership, collaboration, and delivery from one focused space.</p></div><button className="primary-button" onClick={() => setModal('create')}><Plus size={16} /> New board</button></div>
    {error && <div className="form-error" role="alert">{error}</div>}
    <section className="team-section"><div className="team-section-heading"><div><h2>My Boards</h2><p>Boards you own and manage.</p></div><span>{owned.length} board{owned.length === 1 ? '' : 's'}</span></div><div className="team-board-grid">{owned.length ? owned.map(renderCard) : <div className="team-empty">Create your first board to get started.</div>}</div></section>
    <section className="team-section"><div className="team-section-heading"><div><h2>Shared Boards</h2><p>Boards where you collaborate as a member.</p></div><span>{shared.length} board{shared.length === 1 ? '' : 's'}</span></div><div className="team-board-grid">{shared.length ? shared.map(renderCard) : <div className="team-empty">Shared boards will appear here when someone invites you.</div>}</div></section>
    <section className="team-members-card"><div className="team-section-heading"><div><h2>Team Members</h2><p>People with access to your owned boards.</p></div><Users size={18} /></div><div className="team-member-table">{owned.flatMap((board) => (board.members || []).map((member) => ({ ...member, boardName: board.name, boardId: board.id }))).map((member) => <div className="team-member-row" key={`${member.boardId}-${member.id}`}><span className="team-table-avatar">{initials(member)}</span><div><strong>{member.name}</strong><small>{member.email}</small></div><span className="team-member-board">{member.boardName}</span><span className="team-member-role"><Shield size={13} /> Member</span></div>)}{!owned.some((board) => board.members?.length) && <div className="team-empty">No teammates have been added yet.</div>}</div></section>
    {modal && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setModal(null)}><div className="team-modal" role="dialog" aria-modal="true" aria-labelledby="team-modal-title"><div className="modal-heading"><div><div className="eyebrow">{modal === 'create' ? 'Workspace setup' : 'Board access'}</div><h2 id="team-modal-title">{modal === 'create' ? 'Create a new board' : `Add a member to ${selectedBoard?.name}`}</h2></div><button className="team-icon-button" onClick={() => setModal(null)} aria-label="Close dialog"><X size={17} /></button></div>{modal === 'create' ? <form onSubmit={create}><label>Board name<input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} placeholder="e.g. Product launch" autoFocus required /></label><div className="team-modal-actions"><button type="button" className="secondary-button" onClick={() => setModal(null)}>Cancel</button><button className="primary-button" disabled={busy}><Plus size={15} /> Create board</button></div></form> : <form onSubmit={invite}><label>Email address<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="teammate@example.com" autoFocus required /></label><small className="team-modal-hint">They need an existing LeadAI account. Every member can edit this board.</small><div className="team-modal-actions"><button type="button" className="secondary-button" onClick={() => setModal(null)}>Cancel</button><button className="primary-button" disabled={busy}><Mail size={15} /> Add member</button></div></form>}</div></div>}
  </section>;
}
function RoutePage({ pathname, navigate, user }) {
  const displayName = user?.name || 'your account';
  const pages = {
    '/automations': ['Automations', 'Rules that move and label work without you touching the board.', 'Not available yet'],
    '/backlog': ['Backlog', 'Work that has not been started yet lives here.', 'Move items to To Do when you are ready'],
    '/team': ['Team & Workspace', 'Invite teammates to collaborate on shared boards.', 'Solo workspace'],
    '/settings': ['Settings', 'Control your account and workspace preferences.', 'Signed in'],
    '/profile': [user?.name || 'Your profile', user?.email || 'Manage your account details.', 'Member']
  };
  if (pathname === '/automations') {
    return <section className="route-page"><div className="route-hero"><div className="eyebrow">LeadAI workspace</div><h1>Automations</h1><p>Rules that move and label work without you touching the board.</p><span className="route-status"><Activity size={13} /> Not available yet</span></div><div className="route-grid"><div className="route-card"><Sparkles size={18} /><h2>Automations are not built yet</h2><p>Nothing is being automated for {displayName} today. Work moves when you move it — drag a card or use the status menu on the board.</p><button type="button" className="secondary-button" onClick={() => navigate('/board')}>Open the kanban board <ArrowRight size={14} /></button></div></div></section>;
  }
  const page = pages[pathname] || ['Page not found', 'This route is not configured yet.', 'Return to the active board'];
  return <section className="route-page"><div className="route-hero"><div className="eyebrow">LeadAI workspace</div><h1>{page[0]}</h1><p>{page[1]}</p><span className="route-status"><Activity size={13} /> {page[2]}</span></div><div className="route-grid"><div className="route-card"><LayoutGrid size={18} /><h2>This page is not ready</h2><p>The address you opened is not part of {displayName}'s workspace yet.</p><button type="button" className="secondary-button" onClick={() => navigate('/board')}>Back to the board <ArrowRight size={14} /></button></div></div></section>;
}
// Dialogs dismiss with Escape and keep Tab inside themselves, which is what
// keyboard users reach for first.
function useDialogKeyboard(dialogRef, onClose) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Captured during the first render: by the time an effect runs, an autoFocus
  // input has already taken focus, and the trigger would be lost.
  const [opener] = useState(() => (typeof document === 'undefined' ? null : document.activeElement));
  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === 'Escape') { onCloseRef.current(); return; }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll('button, input, select, textarea, [href]')]
        .filter((element) => !element.disabled && element.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      if (opener instanceof HTMLElement && document.contains(opener)) opener.focus();
    };
  }, [dialogRef]);
}

function TaskModal({ status, task, onClose, onSubmit, assignees }) {
  const options = assignees && assignees.length ? assignees : ['Unassigned'];
  const dialogRef = useRef(null);
  const titleRef = useRef(null);
  useDialogKeyboard(dialogRef, onClose);
  // React's autoFocus was not reliably moving focus off the trigger, so the
  // first field is focused once the dialog is actually in the DOM.
  useEffect(() => { titleRef.current?.focus(); }, []);
  const [dueDate, setDueDate] = useState(/^\d{4}-\d{2}-\d{2}$/.test(task?.dueDate || '') ? task.dueDate : '');
  function chooseDueDate(value) {
    if (value === 'none') return setDueDate('');
    const date = new Date();
    if (value === 'today') return setDueDate(date.toISOString().slice(0, 10));
    date.setDate(date.getDate() + Number(value));
    setDueDate(date.toISOString().slice(0, 10));
  }
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <form ref={dialogRef} className="task-modal" role="dialog" aria-modal="true" aria-labelledby="task-modal-title" onSubmit={onSubmit}>
      <div className="modal-heading"><div><div className="eyebrow">{task ? 'Edit work' : 'New work'}</div><h2 id="task-modal-title">{task ? 'Edit task' : 'Create task'}</h2><p className="modal-subtitle">Capture the outcome, urgency, owner, and delivery date in one place.</p></div><IconButton label="Close dialog" onClick={onClose}><X size={17} /></IconButton></div>
      <label>Task title<input name="title" ref={titleRef} required defaultValue={task?.title || ''} placeholder="e.g. Add rate limiting to API gateway" /></label>
      <label>Description<textarea name="description" rows="4" defaultValue={task?.description || ''} placeholder="What needs to be done, and what does done look like?" /></label>
      <div className="form-grid"><label>Priority<select name="priority" defaultValue={task?.priority || 'medium'}><option value="urgent">P0 Urgent</option><option value="high">P1 High</option><option value="medium">P2 Medium</option><option value="low">P3 Low</option></select></label><label>Assignee<select name="assignee" defaultValue={task?.assignee || 'Unassigned'}><option>Unassigned</option>{options.filter((name) => name !== 'Unassigned').map((name) => <option key={name}>{name}</option>)}</select></label></div>
      <div className="form-grid"><label>Label<input name="label" defaultValue={task?.labels?.[0] || ''} placeholder="Frontend, API, Design..." /></label><div className="date-field"><label htmlFor="task-due-date">Due date</label><div className="date-input-row"><input id="task-due-date" name="dueDate" type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} aria-label="Due date" /><select value="" onChange={(event) => chooseDueDate(event.target.value)} aria-label="Choose due date shortcut"><option value="">Choose date</option><option value="today">Today</option><option value="1">Tomorrow</option><option value="7">Next week</option><option value="none">No due date</option></select></div></div></div>
      <div className="ai-planning-hint"><Sparkles size={15} /><span><strong>AI-ready fields</strong> Copilot can infer descriptions, priorities, owners, and date-only deadlines from a project brief.</span></div>
      <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button type="submit" className="primary-button">{task ? 'Save changes' : <><Plus size={15} /> Add to {columns.find((column) => column.id === status)?.label}</>}</button></div>
    </form>
  </div>;
}

export default App;

