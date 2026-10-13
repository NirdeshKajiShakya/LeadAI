import { useEffect, useMemo, useState } from 'react';
import {
  Activity, ArrowRight, Bell, Bolt, Bot, CalendarDays, Check, ChevronDown, CircleHelp,
  Filter, LayoutGrid, List, Menu, MessageSquare, MoreHorizontal, Plus, Search, Settings2,
  Sparkles, Target, Users, X, Zap
} from 'lucide-react';

const columns = [
  { id: 'backlog', label: 'Backlog', color: 'slate', hint: 'Shape the next move' },
  { id: 'todo', label: 'To Do', color: 'cyan', hint: 'Ready to pick up' },
  { id: 'progress', label: 'In Progress', color: 'violet', hint: 'Active execution' },
  { id: 'review', label: 'In Review / QA', color: 'blue', hint: 'Validate and ship' },
  { id: 'done', label: 'Done', color: 'green', hint: 'Verified outcomes' }
];
const priorityLabels = { urgent: 'P0 Urgent', high: 'P1 High', medium: 'P2 Medium', low: 'P3 Low' };
const priorityClass = { urgent: 'priority-urgent', high: 'priority-high', medium: 'priority-medium', low: 'priority-low' };
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
  const [authMode, setAuthMode] = useState('signin');
  const [authError, setAuthError] = useState('');
  const [tasks, setTasks] = useState([]);
  const [query, setQuery] = useState('');
  const [priority, setPriority] = useState('all');
  const [activeLabel, setActiveLabel] = useState('All');
  const [copilotOpen, setCopilotOpen] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [modalStatus, setModalStatus] = useState('todo');
  const [copilotInput, setCopilotInput] = useState('');
  const [copilotMessages, setCopilotMessages] = useState([
    { role: 'assistant', text: 'Your board is synced. Ask me to create, triage, or summarize your work.' }
  ]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const handlePopState = () => setPathname(window.location.pathname);
    window.addEventListener('popstate', handlePopState);
    if (!token) {
      setLoading(false);
      return () => window.removeEventListener('popstate', handlePopState);
    }
    const authHeaders = { Authorization: `Bearer ${token}` };
    fetch(`${API_BASE_URL}/api/auth/current`, { headers: authHeaders })
      .then((response) => (response.ok ? response.json() : null))
      .then((profile) => setUser(profile))
      .catch(() => setUser(null));
    fetch(`${API_BASE_URL}/api/tasks`, { headers: authHeaders }).then(async (response) => {
      if (response.status === 401) {
        sessionStorage.removeItem('leadai-session');
        setToken(null);
        return [];
      }
      return response.json();
    }).then(setTasks).catch(() => setTasks([])).finally(() => setLoading(false));
    return () => window.removeEventListener('popstate', handlePopState);
  }, [token]);

  function navigate(path) {
    window.history.pushState({}, '', path);
    setPathname(path);
  }

  const labels = useMemo(() => [...new Set(tasks.flatMap((task) => task.labels))].slice(0, 5), [tasks]);
  const filteredTasks = useMemo(() => tasks.filter((task) => {
    const matchesQuery = `${task.key} ${task.title} ${task.description} ${task.assignee}`.toLowerCase().includes(query.toLowerCase());
    const matchesPriority = priority === 'all' || task.priority === priority;
    const matchesLabel = activeLabel === 'All' || task.labels.includes(activeLabel);
    return matchesQuery && matchesPriority && matchesLabel;
  }), [tasks, query, priority, activeLabel]);
  const completed = tasks.filter((task) => task.status === 'done').length;
  const inFlight = tasks.filter((task) => task.status === 'progress').length;
  const completionRate = tasks.length ? Math.round((completed / tasks.length) * 100) : 0;
  const workspaceName = user?.name ? `${user.name}'s workspace` : 'My workspace';

  async function updateTask(key, data) {
    setTasks((current) => current.map((task) => task.key === key ? { ...task, ...data } : task));
    const response = await fetch(`${API_BASE_URL}/api/tasks/${key}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(data) });
    if (!response.ok) setTasks((current) => current.map((task) => task.key === key ? { ...task, ...data } : task));
  }

  async function createTask(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const payload = { title: form.get('title'), description: form.get('description'), status: modalStatus, priority: form.get('priority'), labels: [form.get('label') || 'General'], assignee: form.get('assignee') || 'Unassigned', dueDate: form.get('dueDate') || 'Unscheduled' };
    const response = await fetch(`${API_BASE_URL}/api/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(payload) });
    const task = await response.json();
    if (!response.ok) return setAuthError(task.error || 'Could not create task.');
    setTasks((current) => [...current, task]);
    setShowModal(false);
  }

  async function authenticate(event) {
    event.preventDefault();
    setAuthError('');
    const form = new FormData(event.currentTarget);
    const endpoint = authMode === 'signup' ? '/api/auth/signup' : '/api/auth/signin';
    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: form.get('email'), password: form.get('password'), name: form.get('name') })
    });
    const payload = await response.json();
    if (!response.ok) return setAuthError(payload.error || 'Authentication failed.');
    if (authMode === 'signup') {
      setAuthMode('signin');
      return setAuthError('Account created. Sign in to continue.');
    }
    sessionStorage.setItem('leadai-session', payload.token);
    setToken(payload.token);
  }

  if (!token) return <AuthScreen mode={authMode} setMode={setAuthMode} error={authError} onSubmit={authenticate} />;

  function sendCopilot(event) {
    event.preventDefault();
    const message = copilotInput.trim();
    if (!message) return;
    setCopilotMessages((current) => [...current, { role: 'user', text: message }, { role: 'assistant', text: message.toLowerCase().includes('create') ? 'I prepared a new task draft from that request. Review the details and add it to the board when ready.' : 'Got it. I have noted that against your current board context.' }]);
    setCopilotInput('');
  }

  function handleDrop(event, status) {
    event.preventDefault();
    const key = event.dataTransfer.getData('text/plain');
    if (key) updateTask(key, { status });
  }

  return <div className="app-shell">
    <header className="topbar">
      <button className="brand-lockup" onClick={() => navigate('/')}><div className="logo-mark"><span></span><span></span><span></span></div><strong>LeadAI</strong></button>
      <div className="workspace-picker"><span className="workspace-dot"></span> {user ? `${user.name}'s workspace` : 'My workspace'} <ChevronDown size={13} /></div>
      <div className="topbar-actions">
        <label className="global-search"><Search size={15} /><input placeholder="Search tasks, comments, agents..." value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <IconButton label="Notifications"><Bell size={16} /></IconButton>        <button className="text-button" onClick={async () => { await fetch(`${API_BASE_URL}/api/auth/signout`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }); sessionStorage.removeItem('leadai-session'); setToken(null); setUser(null); }}>Sign Out</button><button className="profile-avatar" onClick={() => navigate('/profile')}>{initialsOf(user?.name)}<span></span></button>
      </div>
    </header>
    <div className="workspace-layout">
      <aside className="sidebar">
        <div className="mobile-menu"><Menu size={18} /></div>
        <div className="nav-section"><div className="nav-label">Workspace</div><NavItem active={pathname === '/'} onClick={() => navigate('/')} icon={<LayoutGrid size={15} />} label="Home" /><NavItem active={pathname === '/board'} onClick={() => navigate('/board')} icon={<Target size={15} />} label="Kanban Board" badge="Live" /><NavItem active={pathname === '/backlog'} onClick={() => navigate('/backlog')} icon={<List size={15} />} label="Sprint Backlog" /></div>
        <div className="nav-section"><div className="nav-label">Operations</div><NavItem active={pathname === '/automations'} onClick={() => navigate('/automations')} icon={<Sparkles size={15} />} label="Automations" /><NavItem active={pathname === '/team'} onClick={() => navigate('/team')} icon={<Users size={15} />} label="Team & Workspace" /><NavItem active={pathname === '/settings'} onClick={() => navigate('/settings')} icon={<Settings2 size={15} />} label="Settings" /></div>
        <div className="sidebar-footer"><div className="quota-copy"><span>Tasks on your board</span><strong>{tasks.length} total</strong></div><div className="quota-bar"><span></span></div><div className="ai-active"><span></span> AI Copilot Active <Zap size={14} /></div></div>
      </aside>
      <main className="main-content">
        {pathname !== '/' && pathname !== '/board' ? <RoutePage pathname={pathname} navigate={navigate} user={user} /> : <>
        <div className="context-strip"><div className="breadcrumbs"><span>Workspace</span><ChevronDown size={13} /><strong>{workspaceName}</strong><span className="live-pill"><i></i> Synced</span></div><div className="metric-badges"><Metric label="Total" value={`${tasks.length} Tasks`} /><Metric label="In Flight" value={inFlight} dot="cyan" /><Metric label="Completed" value={completed} dot="green" /><Metric label="Completion" value={`${completionRate}%`} icon={<Activity size={13} />} /></div></div>
        <section className="page-heading"><div><div className="eyebrow">Your workspace</div><h1>{user?.name ? `${user.name}'s board` : 'My board'}</h1><p>Organize your work, track progress, and keep everything moving.</p></div><div className="heading-actions"><button className="secondary-button" onClick={() => setCopilotOpen(true)}><Bolt size={15} /> AI Auto-Triage</button><button className="secondary-button" onClick={() => setCopilotOpen(!copilotOpen)}><Bot size={15} /> {copilotOpen ? 'Hide' : 'Show'} Copilot</button><button className="primary-button" onClick={() => { setModalStatus('todo'); setShowModal(true); }}><Plus size={16} /> Add Task</button></div></section>
        <section className="control-bar"><label className="filter-search"><Search size={15} /><input placeholder="Filter tasks, branches, tickets..." value={query} onChange={(event) => setQuery(event.target.value)} /></label><div className="avatar-stack"><span>{initialsOf(user?.name)}</span></div><div className="label-filters"><button className={activeLabel === 'All' ? 'selected' : ''} onClick={() => setActiveLabel('All')}>All ({tasks.length})</button>{labels.map((label) => <button key={label} className={activeLabel === label ? 'selected' : ''} onClick={() => setActiveLabel(label)}><i></i>{label}</button>)}</div><div className="view-controls"><Filter size={14} /><select value={priority} onChange={(event) => setPriority(event.target.value)}><option value="all">Priority: All</option><option value="urgent">P0 - Urgent</option><option value="high">P1 - High</option><option value="medium">P2 - Medium</option><option value="low">P3 - Low</option></select><IconButton label="Kanban view" active><LayoutGrid size={16} /></IconButton><IconButton label="List view"><List size={16} /></IconButton></div></section>
        <div className={`board-layout ${copilotOpen ? '' : 'copilot-closed'}`}><section className="board-canvas">{loading ? <div className="loading-state">Loading your sprint board...</div> : columns.map((column) => <BoardColumn key={column.id} column={column} tasks={filteredTasks.filter((task) => task.status === column.id)} onDrop={handleDrop} onAdd={() => { setModalStatus(column.id); setShowModal(true); }} onMove={updateTask} />)}</section>{copilotOpen && <Copilot messages={copilotMessages} input={copilotInput} setInput={setCopilotInput} onSubmit={sendCopilot} onClose={() => setCopilotOpen(false)} />}</div>
        <section className="velocity-panel"><div><div className="eyebrow">Your progress</div><h2>Here is how your board is tracking right now</h2></div><div className="velocity-stats"><div><strong>{tasks.length}</strong><span>Total tasks</span></div><div><strong>{inFlight}</strong><span>In progress</span></div><div><strong>{completed}</strong><span>Completed</span></div></div></section>
        {showModal && <TaskModal status={modalStatus} onClose={() => setShowModal(false)} onSubmit={createTask} assignees={user?.name ? [user.name] : []} />}
        </>}
      </main>
    </div>
  </div>;
}

function NavItem({ icon, label, active, badge, onClick }) { return <button className={`nav-item ${active ? 'active' : ''}`} onClick={onClick}>{icon}<span>{label}</span>{badge && <em>{badge}</em>}</button>; }
function AuthScreen({ mode, setMode, error, onSubmit }) {
  const signup = mode === 'signup';
  return <main className="auth-screen"><div className="auth-panel"><div className="logo-mark"><span></span><span></span><span></span></div><div className="eyebrow">LeadAI workspace</div><h1>{signup ? 'Create your account' : 'Welcome back'}</h1><p>{signup ? 'Start shaping clearer work for your team.' : 'Sign in to continue to your sprint board.'}</p><form onSubmit={onSubmit}>{signup && <label>Name<input name="name" autoComplete="name" maxLength="80" /></label>}<label>Email<input name="email" type="email" autoComplete="email" required /></label><label>Password<input name="password" type="password" minLength="8" maxLength="128" autoComplete={signup ? 'new-password' : 'current-password'} required /></label>{error && <div className="form-error" role="alert">{error}</div>}<button className="primary-button" type="submit">{signup ? 'Create account' : 'Sign in'} <ArrowRight size={15} /></button></form><button className="auth-switch" onClick={() => setMode(signup ? 'signin' : 'signup')}>{signup ? 'Already have an account? Sign in' : 'Need an account? Sign up'}</button></div></main>;
}
function Metric({ label, value, dot, icon }) { return <div className="metric"><span>{dot && <i className={`metric-dot ${dot}`}></i>}{icon}{label}</span><strong>{value}</strong></div>; }
function BoardColumn({ column, tasks, onDrop, onAdd, onMove }) { return <div className={`board-column column-${column.color}`} onDragOver={(event) => event.preventDefault()} onDrop={(event) => onDrop(event, column.id)}><div className="column-header"><div><span className="column-title"><i></i>{column.label}<b>{tasks.length}</b></span><small>{column.hint}</small></div><IconButton label={`Add task to ${column.label}`} onClick={onAdd}><Plus size={17} /></IconButton></div><div className="task-list">{tasks.map((task) => <TaskCard key={task.key} task={task} onMove={onMove} />)}{tasks.length === 0 && <div className="empty-column">Drop work here</div>}</div></div>; }
function TaskCard({ task, onMove }) { return <article className={`task-card ${task.status === 'done' ? 'is-done' : ''}`} draggable onDragStart={(event) => event.dataTransfer.setData('text/plain', task.key)}><div className="task-topline"><span className="task-key">#{task.key}</span><span className={`priority ${priorityClass[task.priority]}`}>{priorityLabels[task.priority]}</span></div><h3>{task.title}</h3><p>{task.description}</p><div className="task-labels">{task.labels.map((label) => <span key={label}>{label}</span>)}</div>{task.aiSuggested && <div className="ai-note"><Sparkles size={12} /> AI suggested</div>}<div className="task-footer"><span className="assignee"><i>{initialsOf(task.assignee)}</i>{task.assignee}</span><span className="task-meta"><CalendarDays size={13} />{task.dueDate}</span><button className="task-menu" aria-label={`Move ${task.key}`} onClick={() => onMove(task.key, { status: task.status === 'done' ? 'backlog' : 'done' })}><MoreHorizontal size={15} /></button></div></article>; }
function Copilot({ messages, input, setInput, onSubmit, onClose }) { return <aside className="copilot"><div className="copilot-header"><div className="copilot-title"><span className="copilot-icon"><Bot size={17} /><i></i></span><div><strong>LeadAI Copilot <b>LIVE</b></strong><small>Your workspace</small></div></div><div className="copilot-actions"><IconButton label="Close Copilot" onClick={onClose}><X size={16} /></IconButton></div></div><div className="copilot-context"><span><Activity size={13} /> {messages.length} messages</span><button><Activity size={12} /> Re-analyze</button></div><div className="chat-stream">{messages.map((message, index) => <div key={`${message.text}-${index}`} className={`chat-message ${message.role}`}><span className="message-icon">{message.role === 'assistant' ? <Sparkles size={13} /> : 'You'}</span><div><p>{message.text}</p><small>{message.role === 'assistant' ? 'LeadAI Copilot' : 'Just now'}</small></div></div>)}<div className="suggestion"><Check size={14} /><span>Board context is current</span></div></div><form className="copilot-input" onSubmit={onSubmit}><input placeholder="Ask LeadAI to create tasks, triage..." value={input} onChange={(event) => setInput(event.target.value)} /><button aria-label="Send Copilot message"><ArrowRight size={17} /></button><small>Press Enter to execute</small></form></aside>; }
function RoutePage({ pathname, navigate, user }) {
  const displayName = user?.name || 'your account';
  const pages = {
    '/backlog': ['Backlog', 'Work that has not been started yet lives here.', 'Move items to To Do when you are ready'],
    '/automations': ['Automations', 'Configure rules that keep your board organized automatically.', 'Set up your first rule'],
    '/team': ['Team & Workspace', 'Invite teammates to collaborate on shared boards.', 'Solo workspace'],
    '/settings': ['Settings', 'Control your account and workspace preferences.', 'Signed in'],
    '/profile': [user?.name || 'Your profile', user?.email || 'Manage your account details.', 'Member'],
    '/signin': ['Welcome to LeadAI', 'Sign in to your workspace and pick up where you left off.', 'Secure by default']
  };
  const page = pages[pathname] || ['Page not found', 'This route is not configured yet.', 'Return to the active board'];
  const isSignIn = pathname === '/signin';
  return <section className={`route-page ${isSignIn ? 'auth-page' : ''}`}><div className="route-hero"><div className="eyebrow">LeadAI workspace</div><h1>{page[0]}</h1><p>{page[1]}</p><span className="route-status"><Activity size={13} /> {page[2]}</span></div>{isSignIn ? <form className="auth-card" onSubmit={(event) => { event.preventDefault(); navigate('/'); }}><label>Work email<input type="email" required placeholder="you@example.com" /></label><label>Password<input type="password" required placeholder="Your password" /></label><button className="primary-button" type="submit">Sign in to workspace <ArrowRight size={15} /></button></form> : <div className="route-grid"><div className="route-card"><Sparkles size={18} /><h2>Your board is ready</h2><p>Everything you create here belongs to {displayName}. Open the board to start capturing work.</p><button className="secondary-button" onClick={() => navigate('/')}>Open Kanban Board <ArrowRight size={14} /></button></div><div className="route-card"><Target size={18} /><h2>Keep work moving</h2><p>Use the board to organize tasks by status and track them from backlog to done.</p><button className="secondary-button" onClick={() => navigate('/board')}>Review active work <ArrowRight size={14} /></button></div></div>}</section>;
}
function TaskModal({ status, onClose, onSubmit, assignees }) { const options = assignees && assignees.length ? assignees : ['Unassigned']; return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><form className="task-modal" onSubmit={onSubmit}><div className="modal-heading"><div><div className="eyebrow">New work</div><h2>Create task</h2></div><IconButton label="Close dialog" onClick={onClose}><X size={17} /></IconButton></div><label>Task title<input name="title" autoFocus required placeholder="e.g. Add rate limiting to API gateway" /></label><label>Description<textarea name="description" rows="3" placeholder="What does done look like?" /></label><div className="form-grid"><label>Priority<select name="priority" defaultValue="medium"><option value="urgent">P0 Urgent</option><option value="high">P1 High</option><option value="medium">P2 Medium</option><option value="low">P3 Low</option></select></label><label>Assignee<select name="assignee" defaultValue="Unassigned"><option>Unassigned</option>{options.filter((name) => name !== 'Unassigned').map((name) => <option key={name}>{name}</option>)}</select></label></div><div className="form-grid"><label>Label<input name="label" placeholder="Frontend" /></label><label>Due date<input name="dueDate" placeholder="Oct 18" /></label></div><div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button type="submit" className="primary-button"><Plus size={15} /> Add to {columns.find((column) => column.id === status)?.label}</button></div></form></div>; }

export default App;
