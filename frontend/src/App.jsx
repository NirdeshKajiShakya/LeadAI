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
const avatars = { 'Sarah Chen': 'SC', 'Alex Rivera': 'AR', 'Devin Vance': 'DV', 'Elena Rostova': 'ER', 'Marcus Brody': 'MB', Unassigned: '?' };
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '';

function IconButton({ label, children, onClick, active = false }) {
  return <button className={`icon-button ${active ? 'is-active' : ''}`} aria-label={label} title={label} onClick={onClick}>{children}</button>;
}

function App() {
  const [pathname, setPathname] = useState(window.location.pathname);
  const [tasks, setTasks] = useState([]);
  const [query, setQuery] = useState('');
  const [priority, setPriority] = useState('all');
  const [activeLabel, setActiveLabel] = useState('All');
  const [copilotOpen, setCopilotOpen] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [modalStatus, setModalStatus] = useState('todo');
  const [copilotInput, setCopilotInput] = useState('');
  const [copilotMessages, setCopilotMessages] = useState([
    { role: 'assistant', text: 'I found 2 high-priority tasks in In Progress approaching tomorrow\'s cutoff. I can draft subtasks or recommend a rebalance.' },
    { role: 'assistant', text: 'The board is synced. Ask me to create, triage, or move work.' }
  ]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const handlePopState = () => setPathname(window.location.pathname);
    window.addEventListener('popstate', handlePopState);
    fetch(`${API_BASE_URL}/api/tasks`).then((response) => response.json()).then(setTasks).catch(() => setTasks([])).finally(() => setLoading(false));
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

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

  async function updateTask(key, data) {
    setTasks((current) => current.map((task) => task.key === key ? { ...task, ...data } : task));
    await fetch(`${API_BASE_URL}/api/tasks/${key}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  }

  async function createTask(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const payload = { title: form.get('title'), description: form.get('description'), status: modalStatus, priority: form.get('priority'), labels: [form.get('label') || 'General'], assignee: form.get('assignee') || 'Unassigned', dueDate: form.get('dueDate') || 'Unscheduled' };
    const response = await fetch(`${API_BASE_URL}/api/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const task = await response.json();
    setTasks((current) => [...current, task]);
    setShowModal(false);
  }

  function sendCopilot(event) {
    event.preventDefault();
    const message = copilotInput.trim();
    if (!message) return;
    setCopilotMessages((current) => [...current, { role: 'user', text: message }, { role: 'assistant', text: message.toLowerCase().includes('create') ? 'I prepared a new task draft from that request. Review the details and add it to the board when ready.' : 'I\'ll keep that in the sprint context. The current board has a healthy 94% velocity projection.' }]);
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
      <div className="workspace-picker"><span className="workspace-dot"></span> Acme Core Sprint <ChevronDown size={13} /></div>
      <div className="topbar-actions">
        <label className="global-search"><Search size={15} /><input placeholder="Search tasks, comments, agents..." value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <IconButton label="Notifications"><Bell size={16} /></IconButton><button className="text-button" onClick={() => navigate('/signin')}>Sign In</button><button className="signup-button" onClick={() => navigate('/signin')}>Sign Up</button><button className="profile-avatar" onClick={() => navigate('/profile')}>SC<span></span></button>
      </div>
    </header>
    <div className="workspace-layout">
      <aside className="sidebar">
        <div className="mobile-menu"><Menu size={18} /></div>
        <div className="nav-section"><div className="nav-label">Workspace</div><NavItem active={pathname === '/'} onClick={() => navigate('/')} icon={<LayoutGrid size={15} />} label="Home" /><NavItem active={pathname === '/board'} onClick={() => navigate('/board')} icon={<Target size={15} />} label="Kanban Board" badge="Live" /><NavItem active={pathname === '/backlog'} onClick={() => navigate('/backlog')} icon={<List size={15} />} label="Sprint Backlog" /></div>
        <div className="nav-section"><div className="nav-label">Operations</div><NavItem active={pathname === '/automations'} onClick={() => navigate('/automations')} icon={<Sparkles size={15} />} label="Automations" /><NavItem active={pathname === '/team'} onClick={() => navigate('/team')} icon={<Users size={15} />} label="Team & Workspace" /><NavItem active={pathname === '/settings'} onClick={() => navigate('/settings')} icon={<Settings2 size={15} />} label="Settings" /></div>
        <div className="sidebar-footer"><div className="quota-copy"><span>Storage Quota</span><strong>14.2 / 20 GB</strong></div><div className="quota-bar"><span></span></div><div className="ai-active"><span></span> AI Copilot Active <Zap size={14} /></div></div>
      </aside>
      <main className="main-content">
        {pathname !== '/' && pathname !== '/board' ? <RoutePage pathname={pathname} navigate={navigate} /> : <>
        <div className="context-strip"><div className="breadcrumbs"><span>Project</span><ChevronDown size={13} /><strong>Sprint 14</strong><span className="live-pill"><i></i> AI Live Sync</span><small>Last analyzed 2m ago</small></div><div className="metric-badges"><Metric label="Total" value={`${tasks.length} Tasks`} /><Metric label="In Flight" value={inFlight} dot="cyan" /><Metric label="AI Suggested" value={tasks.filter((task) => task.aiSuggested).length} icon={<Sparkles size={13} />} /><Metric label="Velocity" value="94%" icon={<Activity size={13} />} /></div></div>
        <section className="page-heading"><div><div className="eyebrow">Q3 Product Engineering / Sprint 14</div><h1>Q3 Product Engineering Sprint 14 <span>Week 2/2</span></h1><p>Target release: Core Orchestration engine v2.4 with fallback matrix.</p></div><div className="heading-actions"><button className="secondary-button" onClick={() => setCopilotOpen(true)}><Bolt size={15} /> AI Auto-Triage <b>2 pending</b></button><button className="secondary-button" onClick={() => setCopilotOpen(!copilotOpen)}><Bot size={15} /> {copilotOpen ? 'Hide' : 'Show'} Copilot</button><button className="primary-button" onClick={() => { setModalStatus('todo'); setShowModal(true); }}><Plus size={16} /> Add Task</button></div></section>
        <section className="control-bar"><label className="filter-search"><Search size={15} /><input placeholder="Filter tasks, branches, tickets..." value={query} onChange={(event) => setQuery(event.target.value)} /></label><div className="avatar-stack">{Object.values(avatars).slice(0, 4).map((avatar) => <span key={avatar}>{avatar}</span>)}<b>+4</b></div><div className="label-filters"><button className={activeLabel === 'All' ? 'selected' : ''} onClick={() => setActiveLabel('All')}>All ({tasks.length})</button>{labels.map((label) => <button key={label} className={activeLabel === label ? 'selected' : ''} onClick={() => setActiveLabel(label)}><i></i>{label}</button>)}</div><div className="view-controls"><Filter size={14} /><select value={priority} onChange={(event) => setPriority(event.target.value)}><option value="all">Priority: All</option><option value="urgent">P0 - Urgent</option><option value="high">P1 - High</option><option value="medium">P2 - Medium</option><option value="low">P3 - Low</option></select><IconButton label="Kanban view" active><LayoutGrid size={16} /></IconButton><IconButton label="List view"><List size={16} /></IconButton></div></section>
        <div className={`board-layout ${copilotOpen ? '' : 'copilot-closed'}`}><section className="board-canvas">{loading ? <div className="loading-state">Loading your sprint board...</div> : columns.map((column) => <BoardColumn key={column.id} column={column} tasks={filteredTasks.filter((task) => task.status === column.id)} onDrop={handleDrop} onAdd={() => { setModalStatus(column.id); setShowModal(true); }} onMove={updateTask} />)}</section>{copilotOpen && <Copilot messages={copilotMessages} input={copilotInput} setInput={setCopilotInput} onSubmit={sendCopilot} onClose={() => setCopilotOpen(false)} />}</div>
        <section className="velocity-panel"><div><div className="eyebrow">Battle-tested velocity</div><h2>Trusted by 10,000+ engineers at fast-growing tech startups</h2></div><div className="velocity-stats"><div><strong>99.4%</strong><span>On-time sprint completion</span></div><div><strong>4.2x</strong><span>Faster ticket creation</span></div><div><strong>0 Friction</strong><span>Automated status tracking</span></div></div></section>
        {showModal && <TaskModal status={modalStatus} onClose={() => setShowModal(false)} onSubmit={createTask} />}
        </>}
      </main>
    </div>
  </div>;
}

function NavItem({ icon, label, active, badge, onClick }) { return <button className={`nav-item ${active ? 'active' : ''}`} onClick={onClick}>{icon}<span>{label}</span>{badge && <em>{badge}</em>}</button>; }
function Metric({ label, value, dot, icon }) { return <div className="metric"><span>{dot && <i className={`metric-dot ${dot}`}></i>}{icon}{label}</span><strong>{value}</strong></div>; }
function BoardColumn({ column, tasks, onDrop, onAdd, onMove }) { return <div className={`board-column column-${column.color}`} onDragOver={(event) => event.preventDefault()} onDrop={(event) => onDrop(event, column.id)}><div className="column-header"><div><span className="column-title"><i></i>{column.label}<b>{tasks.length}</b></span><small>{column.hint}</small></div><IconButton label={`Add task to ${column.label}`} onClick={onAdd}><Plus size={17} /></IconButton></div><div className="task-list">{tasks.map((task) => <TaskCard key={task.key} task={task} onMove={onMove} />)}{tasks.length === 0 && <div className="empty-column">Drop work here</div>}</div></div>; }
function TaskCard({ task, onMove }) { return <article className={`task-card ${task.status === 'done' ? 'is-done' : ''}`} draggable onDragStart={(event) => event.dataTransfer.setData('text/plain', task.key)}><div className="task-topline"><span className="task-key">#{task.key}</span><span className={`priority ${priorityClass[task.priority]}`}>{priorityLabels[task.priority]}</span></div><h3>{task.title}</h3><p>{task.description}</p><div className="task-labels">{task.labels.map((label) => <span key={label}>{label}</span>)}</div>{task.aiSuggested && <div className="ai-note"><Sparkles size={12} /> Skill matched to {task.assignee}</div>}<div className="task-footer"><span className="assignee"><i>{avatars[task.assignee] || '?'}</i>{task.assignee}</span><span className="task-meta"><CalendarDays size={13} />{task.dueDate}</span><button className="task-menu" aria-label={`Move ${task.key}`} onClick={() => onMove(task.key, { status: task.status === 'done' ? 'backlog' : 'done' })}><MoreHorizontal size={15} /></button></div></article>; }
function Copilot({ messages, input, setInput, onSubmit, onClose }) { return <aside className="copilot"><div className="copilot-header"><div className="copilot-title"><span className="copilot-icon"><Bot size={17} /><i></i></span><div><strong>LeadAI Copilot <b>LIVE</b></strong><small>Sync: Sprint 14 Board</small></div></div><div className="copilot-actions"><span>Claude 3.5 Sonnet <ChevronDown size={12} /></span><IconButton label="Close Copilot" onClick={onClose}><X size={16} /></IconButton></div></div><div className="copilot-context"><span><Activity size={13} /> {messages.length + 26} tasks analyzed</span><button><Activity size={12} /> Re-analyze</button></div><div className="chat-stream">{messages.map((message, index) => <div key={`${message.text}-${index}`} className={`chat-message ${message.role}`}><span className="message-icon">{message.role === 'assistant' ? <Sparkles size={13} /> : 'SC'}</span><div><p>{message.text}</p><small>{message.role === 'assistant' ? 'LeadAI Copilot' : 'Just now'}</small></div></div>)}<div className="suggestion"><Check size={14} /><span>Board context is current</span><em>94% confidence</em></div></div><form className="copilot-input" onSubmit={onSubmit}><input placeholder="Ask LeadAI to create tasks, triage..." value={input} onChange={(event) => setInput(event.target.value)} /><button aria-label="Send Copilot message"><ArrowRight size={17} /></button><small>Press Enter to execute</small></form></aside>; }
function RoutePage({ pathname, navigate }) {
  const pages = {
    '/backlog': ['Sprint Backlog', 'Shape upcoming work before it reaches the active board.', '12 backlog items · 68 story points'],
    '/automations': ['Automations & AI Agent Triggers', 'Configure deterministic webhooks and local agents for autonomous triage.', '4 active workflows · 312 successful runs'],
    '/team': ['Team Workspace', 'See contributors, skills, and sprint capacity in one shared view.', '12 contributors · 94.2% skill coverage'],
    '/settings': ['Settings', 'Control the LeadAI engine, integrations, and workspace defaults.', 'Local engine connected · 32k token context'],
    '/profile': ['Sarah Chen', 'Staff Platform & Distributed Systems Engineer', 'Profile synced · Copilot affinity index 98.4'],
    '/signin': ['Welcome to LeadAI', 'Sign in to your engineering workspace and continue the sprint.', 'Local-first workspace · secure by default']
  };
  const page = pages[pathname] || ['Page not found', 'This route is not configured yet.', 'Return to the active board'];
  const isSignIn = pathname === '/signin';
  return <section className={`route-page ${isSignIn ? 'auth-page' : ''}`}><div className="route-hero"><div className="eyebrow">LeadAI workspace</div><h1>{page[0]}</h1><p>{page[1]}</p><span className="route-status"><Activity size={13} /> {page[2]}</span></div>{isSignIn ? <form className="auth-card" onSubmit={(event) => { event.preventDefault(); navigate('/'); }}><label>Work email<input type="email" required defaultValue="sarah.chen@acme.dev" /></label><label>Password<input type="password" required defaultValue="leadai-demo" /></label><button className="primary-button" type="submit">Sign in to workspace <ArrowRight size={15} /></button><button className="text-button" type="button" onClick={() => navigate('/profile')}>Continue as Sarah Chen</button></form> : <div className="route-grid"><div className="route-card"><Sparkles size={18} /><h2>Connected to your sprint</h2><p>LeadAI keeps this workspace ready for the next decision. Use the board or open another workspace view from the sidebar.</p><button className="secondary-button" onClick={() => navigate('/')}>Open Kanban Board <ArrowRight size={14} /></button></div><div className="route-card"><Target size={18} /><h2>Next recommended action</h2><p>Review the two high-priority items in progress before the next cutoff.</p><button className="secondary-button" onClick={() => navigate('/board')}>Review active work <ArrowRight size={14} /></button></div></div>}</section>;
}
function TaskModal({ status, onClose, onSubmit }) { return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><form className="task-modal" onSubmit={onSubmit}><div className="modal-heading"><div><div className="eyebrow">New sprint work</div><h2>Create task</h2></div><IconButton label="Close dialog" onClick={onClose}><X size={17} /></IconButton></div><label>Task title<input name="title" autoFocus required placeholder="e.g. Add rate limiting to API gateway" /></label><label>Description<textarea name="description" rows="3" placeholder="What does done look like?" /></label><div className="form-grid"><label>Priority<select name="priority" defaultValue="medium"><option value="urgent">P0 Urgent</option><option value="high">P1 High</option><option value="medium">P2 Medium</option><option value="low">P3 Low</option></select></label><label>Assignee<select name="assignee" defaultValue="Unassigned"><option>Unassigned</option><option>Sarah Chen</option><option>Alex Rivera</option><option>Devin Vance</option><option>Elena Rostova</option></select></label></div><div className="form-grid"><label>Label<input name="label" placeholder="Frontend" /></label><label>Due date<input name="dueDate" placeholder="Oct 18" /></label></div><div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button type="submit" className="primary-button"><Plus size={15} /> Add to {columns.find((column) => column.id === status)?.label}</button></div></form></div>; }

export default App;
