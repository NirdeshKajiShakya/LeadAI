import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, AlertTriangle, ArrowRight, ArrowUpRight, Bot, CalendarDays, Check,
  CheckCircle2, CircleDot, Filter, GitBranch, LayoutGrid, Loader2, Moon,
  MoreHorizontal, Plus, Send, Sparkles, Zap
} from 'lucide-react';
import { formatDateRange, isCalendarDate } from './sprintDates.js';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '';

const statusLabels = {
  backlog: 'Backlog',
  todo: 'To Do',
  progress: 'In Progress',
  review: 'In Review',
  done: 'Done'
};

const priorityMeta = {
  urgent: { label: 'P0 • Urgent', tone: 'danger' },
  high: { label: 'P1 • High', tone: 'cyan' },
  medium: { label: 'P2 • Normal', tone: 'muted' },
  low: { label: 'P3 • Low', tone: 'muted' }
};

const previewStages = [
  {
    id: 'ready',
    title: <>Ready<br />For Dev</>,
    statuses: ['backlog', 'todo'],
    limit: 2,
    hint: 'Backlog + To Do'
  },
  {
    id: 'flight',
    title: <>In<br />Flight</>,
    statuses: ['progress', 'review'],
    limit: 2,
    hint: 'Active execution'
  },
  {
    id: 'done',
    title: <>Done /<br />Verified</>,
    statuses: ['done'],
    limit: 1,
    hint: 'Verified outcomes',
    insight: true
  }
];

const features = [
  {
    id: 'dark',
    icon: Moon,
    tone: 'lavender',
    title: 'Deep Dark & Charcoal UX',
    body: 'Engineered for minimal eye fatigue during extended terminal and IDE sessions with customizable matte slate-gray surfaces.',
    foot: 'Zero bright white flashes',
    footIcon: <i className="home-feature-dot" />
  },
  {
    id: 'ai',
    icon: Bot,
    tone: 'cyan',
    title: 'Context-Aware AI Assistant',
    body: 'Chat directly with your sprint backlog. Generate acceptance criteria, split epics into atomic subtasks, and trace dependencies.',
    foot: 'Board & sprint context',
    footIcon: <Check size={12} />
  },
  {
    id: 'workflow',
    icon: Zap,
    tone: 'green',
    title: 'Automated Workflow Triggers',
    body: 'Move work through Backlog, To Do, In Progress, Review, and Done in one click. Board state stays in sync with the tasks your team updates.',
    foot: 'One-click stage moves',
    footIcon: <Check size={12} />
  },
  {
    id: 'velocity',
    icon: Activity,
    tone: 'cyan',
    title: 'Sprint Velocity Intelligence',
    body: 'Track real sprint progress, task completion, and overdue work from the same board your team uses every day.',
    foot: 'Live sprint progress',
    footIcon: <Activity size={12} />
  }
];

function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}

function shortDate(value) {
  if (!value) return '';
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function badgeForTask(task) {
  if (task.status === 'done') return { label: 'Shipped', tone: 'green' };
  if (task.status === 'review') return { label: 'Reviewing', tone: 'cyan' };
  if (task.aiSuggested) return { label: 'AI Generated', tone: 'cyan' };
  if (task.status === 'todo') return { label: 'Queued', tone: 'lavender' };
  if (task.status === 'backlog') return { label: 'Backlog', tone: 'muted' };
  return priorityMeta[task.priority] || priorityMeta.medium;
}

function previewToneForTask(task) {
  if (task.status === 'done') return 'green';
  if (task.status === 'review' || task.aiSuggested || task.priority === 'high') return 'cyan';
  if (task.priority === 'urgent') return 'danger';
  return 'muted';
}

function PreviewTaskCard({ task, onOpenTask }) {
  const badge = badgeForTask(task);
  const tone = previewToneForTask(task);
  const label = Array.isArray(task.labels) ? task.labels[0] : '';
  const assigned = task.assignee && task.assignee !== 'Unassigned';
  const due = shortDate(task.dueDate);

  return (
    <button
      type="button"
      className={`home-preview-card ${task.status === 'done' ? 'is-done' : ''} ${task.aiSuggested ? 'is-ai' : ''}`}
      onClick={() => onOpenTask?.(task)}
      aria-label={`Open task ${task.key}: ${task.title}`}
    >
      <span className="home-preview-top">
        <span className={`home-preview-key ${tone === 'cyan' ? 'is-cyan' : ''}`}>#{task.key}</span>
        <span className={`home-preview-badge is-${badge.tone}`}>
          {task.aiSuggested && <Sparkles size={10} aria-hidden="true" />}
          {badge.label}
        </span>
      </span>
      <strong className="home-preview-title">{task.title}</strong>
      {task.aiSuggested && task.description && (
        <span className="home-preview-note">{task.description}</span>
      )}
      <span className="home-preview-foot">
        <span className="home-preview-meta">
          {label ? <><GitBranch size={11} aria-hidden="true" />{label}</> : <><CircleDot size={11} aria-hidden="true" />{statusLabels[task.status] || task.status}</>}
        </span>
        {assigned ? (
          <span className="home-mini-avatar" title={task.assignee}>{initialsOf(task.assignee)}</span>
        ) : due ? (
          <span className="home-preview-due"><CalendarDays size={11} aria-hidden="true" />{due}</span>
        ) : (
          <span className="home-preview-due">Unassigned</span>
        )}
      </span>
    </button>
  );
}

function SprintInsight({ activeSprint, navigate }) {
  const progress = activeSprint?.progress || {};
  const percent = Math.max(0, Math.min(100, Number(progress.progressPercent) || 0));
  const detail = activeSprint
    ? `${progress.completed || 0} of ${progress.total || 0} tasks complete${progress.totalStoryPoints ? ` · ${progress.completedStoryPoints || 0}/${progress.totalStoryPoints} story points` : ''}.`
    : 'No active sprint yet. Plan one to track real progress here.';

  return (
    <div className="home-insight">
      <div className="home-insight-head">
        <Activity size={15} aria-hidden="true" />
        <strong>{activeSprint ? 'Sprint Insight' : 'Sprint Not Started'}</strong>
      </div>
      <p>{detail}</p>
      <div
        className="home-insight-bar"
        role="progressbar"
        aria-label="Sprint progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <span style={{ width: `${percent}%` }} />
      </div>
      <button type="button" onClick={() => navigate('/backlog')}>
        {activeSprint ? 'Open sprint' : 'Plan a sprint'} <ArrowRight size={12} aria-hidden="true" />
      </button>
    </div>
  );
}

function SectionHead({ kicker, title, copy, centered = true, id }) {
  return (
    <header className={`home-section-head ${centered ? 'is-centered' : ''}`}>
      <span className="home-kicker">{kicker}</span>
      <h2 id={id}>{title}</h2>
      {copy && <p>{copy}</p>}
    </header>
  );
}

export default function Dashboard({
  token,
  user,
  refreshKey = 0,
  navigate,
  onOpenBoard,
  onOpenTask,
  onCreateBoard,
  onGeneratedBoard,
  onSessionExpired,
  activeBoardId = '',
  boards = [],
  boardTasks = [],
  onSummary,
  focusAiKey = 0
}) {
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  const [goal, setGoal] = useState('');
  const [messages, setMessages] = useState([
    {
      id: 'welcome',
      role: 'assistant',
      text: 'Describe what you are building. I will turn the brief into a prioritised board with tasks you can refine.'
    }
  ]);
  const [generating, setGenerating] = useState(false);
  const [aiError, setAiError] = useState('');

  const aiInputRef = useRef(null);
  const threadRef = useRef(null);
  const onSummaryRef = useRef(onSummary);
  const onSessionExpiredRef = useRef(onSessionExpired);

  useEffect(() => {
    onSummaryRef.current = onSummary;
  }, [onSummary]);

  useEffect(() => {
    onSessionExpiredRef.current = onSessionExpired;
  }, [onSessionExpired]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    fetch(`${API_BASE_URL}/api/dashboard/summary`, { headers: { Authorization: `Bearer ${token}` } })
      .then(async (response) => {
        if (response.status === 401) {
          onSessionExpiredRef.current?.();
          return null;
        }
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || `Could not load your workspace (HTTP ${response.status}).`);
        return body;
      })
      .then((data) => {
        if (!cancelled && data) {
          setSummary(data);
          onSummaryRef.current?.(data);
        }
      })
      .catch((requestError) => {
        if (!cancelled) setError(requestError.message || 'Could not reach the LeadAI API. Start the backend, then retry.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [token, refreshKey, reloadKey]);

  useEffect(() => {
    if (!focusAiKey) return;
    const node = aiInputRef.current;
    if (!node) return;
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    node.focus({ preventScroll: true });
  }, [focusAiKey]);

  useEffect(() => {
    if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [messages, generating, aiError]);

  const stats = summary?.stats || null;
  const activeSprint = summary?.activeSprint || null;
  const summaryBoards = useMemo(() => summary?.boards || [], [summary]);
  const priorityTasks = useMemo(() => summary?.priorityTasks || [], [summary]);
  const allBoards = boards.length ? boards : summaryBoards;
  const activeBoard = allBoards.find((board) => String(board.id) === String(activeBoardId)) || allBoards[0] || null;
  const currentBoardId = activeBoardId || activeBoard?.id || '';
  const activeBoardName = activeBoard?.name || 'No board selected';
  const aiConfigured = summary?.ai?.configured;
  // The preview must only ever show tasks that belong to the board the header
  // says is selected. While no board exists we fall back to the summary list so
  // a brand new workspace still has a useful, real-data empty shell.
  const scopedTasks = useMemo(() => (
    (boardTasks || []).filter((task) => !currentBoardId || String(task.boardId) === String(currentBoardId))
  ), [boardTasks, currentBoardId]);
  const previewTasks = currentBoardId ? scopedTasks : priorityTasks;
  const openPreviewTasks = previewTasks.filter((task) => task.status !== 'done').length;

  const stages = useMemo(() => previewStages.map((stage) => {
    const tasks = previewTasks.filter((task) => stage.statuses.includes(task.status));
    return { ...stage, tasks, total: tasks.length };
  }), [previewTasks]);

  const sprintRange = activeSprint && isCalendarDate(activeSprint.startDate) && isCalendarDate(activeSprint.endDate)
    ? formatDateRange(activeSprint.startDate, activeSprint.endDate)
    : '';

  const proofBoards = allBoards.slice(0, 4);
  const proofMetrics = [
    {
      id: 'sprint',
      value: stats ? `${stats.sprintProgress}%` : '—',
      label: 'Sprint Completion',
      description: activeSprint
        ? `${activeSprint.progress?.completed || 0} of ${activeSprint.progress?.total || 0} tasks complete${sprintRange ? ` · ${sprintRange}` : ''}.`
        : 'No active sprint. Plan one from the Sprint Backlog to start tracking.',
      tone: 'lavender',
      onClick: () => navigate('/backlog')
    },
    {
      id: 'boards',
      value: stats ? stats.boards : '—',
      label: 'Active Boards',
      description: stats
        ? `${stats.myOpenTasks} open task${stats.myOpenTasks === 1 ? '' : 's'} assigned to you across your workspace.`
        : 'Loading workspace summary…',
      tone: 'cyan',
      onClick: () => navigate('/team')
    },
    {
      id: 'overdue',
      value: stats ? stats.overdueTasks : '—',
      label: 'Overdue Tasks',
      description: stats
        ? stats.overdueTasks
          ? 'Past a real due date and still open. Clear the blockers from your board.'
          : 'Nothing is overdue across your boards right now.'
        : 'Loading workspace summary…',
      tone: 'green',
      onClick: () => navigate('/board')
    }
  ];

  function focusGenerator() {
    const node = aiInputRef.current;
    if (!node) return;
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    node.focus({ preventScroll: true });
  }

  async function generateBoard(event) {
    event.preventDefault();
    if (generating) return;
    const trimmedGoal = goal.trim();
    if (trimmedGoal.length < 10) {
      setAiError('Describe the project in at least 10 characters so the planner has enough context.');
      aiInputRef.current?.focus();
      return;
    }

    const userMessage = { id: `user-${Date.now()}`, role: 'user', text: trimmedGoal };
    setMessages((current) => [...current, userMessage]);
    setGoal('');
    setAiError('');
    setGenerating(true);

    try {
      const response = await fetch(`${API_BASE_URL}/api/ai/boards`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ goal: trimmedGoal })
      });
      if (response.status === 401) {
        onSessionExpired?.();
        return;
      }
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `Board generation failed (HTTP ${response.status}).`);
      if (!body.board?.id) throw new Error('The server did not confirm a created board, so nothing was opened.');

      setMessages((current) => [...current, {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        text: `Created “${body.board.name}” with ${body.tasksCreated} task${body.tasksCreated === 1 ? '' : 's'}. Opening the board now.`
      }]);
      await onGeneratedBoard?.(body.board, body.tasksCreated);
    } catch (requestError) {
      const message = requestError.message || 'Could not generate a board. Please try again.';
      setAiError(message);
      setMessages((current) => [...current, {
        id: `assistant-error-${Date.now()}`,
        role: 'assistant',
        tone: 'error',
        text: message
      }]);
    } finally {
      setGenerating(false);
    }
  }

  function resetChat() {
    setMessages([{
      id: 'welcome',
      role: 'assistant',
      text: 'Describe what you are building. I will turn the brief into a prioritised board with tasks you can refine.'
    }]);
    setGoal('');
    setAiError('');
    aiInputRef.current?.focus();
  }

  function applySuggestion(text) {
    setGoal(text);
    setAiError('');
    aiInputRef.current?.focus();
  }

  const sprintBoard = activeBoard?.activeSprint?.name || (activeSprint && String(activeSprint.boardId || '') === String(currentBoardId) ? activeSprint.name : '');
  const suggestions = currentBoardId
    ? [`Plan the next sprint for ${activeBoardName}`, `Draft a launch checklist for ${activeBoardName}`]
    : ['Plan a new product board', 'Draft a launch checklist'];

  return (
    <div className="home-page">
      {/* 1. Hero ---------------------------------------------------------- */}
      <section className="home-hero" aria-labelledby="home-title">
        <div className="home-hero-copy">
          <span className="home-eyebrow">
            <i aria-hidden="true" />
            Introducing LeadAI • Autonomous Sprint Management
          </span>
          <h1 id="home-title">The Intelligent Kanban Board Built for Modern Engineering Teams</h1>
          <p className="home-hero-sub">
            Your workspace is live. Generate a sprint-ready board from a brief, then track every task from backlog to done.
          </p>
          <div className="home-hero-actions">
            <button type="button" className="home-primary" onClick={focusGenerator}>
              <Sparkles size={13} aria-hidden="true" /> Generate Board with AI
            </button>
            <button type="button" className="home-secondary" onClick={() => navigate('/board')}>
              <LayoutGrid size={13} aria-hidden="true" /> Open Kanban Board
            </button>
          </div>
        </div>

        <div className="home-mockup">
          <div className="home-mockup-toolbar">
            <div className="home-toolbar-left">
              <span className="home-workspace-dots" aria-hidden="true"><i /><i /><i /></span>
              <span className="home-toolbar-title">
                {sprintBoard || activeBoardName}
                {(sprintBoard || activeSprint) && <em> • active cycle</em>}
              </span>
            </div>
            <div className="home-toolbar-right">
              <span className="home-live-pill"><i aria-hidden="true" />{openPreviewTasks} open</span>
              {activeBoard ? (
                <>
                  <button type="button" className="home-toolbar-btn" onClick={() => navigate('/board')}>
                    <Filter size={11} aria-hidden="true" /> Board filters
                  </button>
                  <button type="button" className="home-toolbar-more" onClick={() => navigate('/board')} aria-label="Open the full kanban board" title="Open the full kanban board">
                    <MoreHorizontal size={14} aria-hidden="true" />
                  </button>
                </>
              ) : (
                <button type="button" className="home-toolbar-btn" onClick={onCreateBoard}>
                  <Plus size={11} aria-hidden="true" /> New board
                </button>
              )}
            </div>
          </div>

          {activeBoard ? (
            <div className="home-mockup-grid">
              {stages.map((stage) => (
                <div className="home-preview-column" key={stage.id}>
                  <div className="home-column-head">
                    <span className="home-column-title">{stage.title}</span>
                    <span className="home-column-hint" title={stage.hint}>
                      <MoreHorizontal size={12} aria-hidden="true" />
                      {stage.total} {stage.total === 1 ? 'task' : 'tasks'}
                    </span>
                    <button type="button" className="home-column-more" onClick={() => navigate('/board')} aria-label={`Open the full board from ${stage.hint}`} title="Open full board">
                      <MoreHorizontal size={14} aria-hidden="true" />
                    </button>
                  </div>
                  <div className="home-column-body">
                    {stage.tasks.slice(0, stage.limit).map((task) => (
                      <PreviewTaskCard key={`${task.boardId}-${task.key}`} task={task} onOpenTask={onOpenTask} />
                    ))}
                    {!stage.tasks.length && (
                      <div className="home-empty-column">
                        <CircleDot size={14} aria-hidden="true" />
                        <span>No tasks in this stage</span>
                      </div>
                    )}
                    {stage.insight && <SprintInsight activeSprint={activeSprint} navigate={navigate} />}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="home-mockup-empty">
              <span className="home-mockup-empty-icon"><LayoutGrid size={24} aria-hidden="true" /></span>
              <strong>No board selected yet</strong>
              <p>Create a board to see real tasks here, or let AI draft the first plan for you.</p>
              <div>
                <button type="button" className="home-primary" onClick={onCreateBoard}><Plus size={13} aria-hidden="true" /> Create a board</button>
                <button type="button" className="home-secondary" onClick={focusGenerator}><Sparkles size={13} aria-hidden="true" /> Generate with AI</button>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* 2. Feature highlights ------------------------------------------- */}
      <section className="home-section home-features" aria-labelledby="home-features-title">
        <SectionHead
          id="home-features-title"
          kicker="Purpose-Built Infrastructure"
          title="Engineered for High-Velocity Product Teams"
          copy="No bloated configuration wizards. Zero lag. High-density tactical instrumentation built to stay out of your team’s way."
        />
        <div className="home-feature-grid">
          {features.map((feature) => {
            const Icon = feature.icon;
            return (
              <article className="home-feature" key={feature.id}>
                <span className={`home-feature-icon is-${feature.tone}`}><Icon size={19} aria-hidden="true" /></span>
                <h3>{feature.title}</h3>
                <p>{feature.body}</p>
                <span className="home-feature-foot">{feature.footIcon}<span>{feature.foot}</span></span>
              </article>
            );
          })}
        </div>
      </section>

      {/* 3. Interactive AI assistant ------------------------------------- */}
      <section className="home-section home-ai" id="home-ai" aria-labelledby="home-ai-title">
        <SectionHead
          id="home-ai-title"
          kicker="Live AI Planning"
          title="Ask Copilot. Watch Your Board Take Shape."
          copy="Describe the project in plain language. LeadAI drafts a prioritised board you can refine, review, and ship."
        />
        <div className="home-ai-panel">
          <div className="home-ai-chat">
            <header className="home-ai-chat-head">
              <span className="home-ai-avatar-tile"><Bot size={17} aria-hidden="true" /></span>
              <div>
                <strong>LeadAI Copilot</strong>
                <span className={aiConfigured === false ? 'is-offline' : ''}><i aria-hidden="true" />{aiConfigured === false ? 'AI planning offline' : 'Ready for sprint commands'}</span>
              </div>
              <button
                type="button"
                className="home-ai-expand"
                onClick={() => onOpenBoard?.(activeBoard?.id)}
                disabled={!activeBoard?.id}
                aria-label="Open the board and its Copilot"
                title="Open the board and its Copilot"
              >
                <ArrowUpRight size={15} aria-hidden="true" />
              </button>
            </header>

            <div className="home-ai-thread" ref={threadRef} role="log" aria-live="polite" aria-label="AI planning conversation">
              {aiConfigured === false && (
                <div className="home-ai-notice" role="status">
                  <AlertTriangle size={15} aria-hidden="true" />
                  <div>
                    <strong>AI planning is not configured on this server.</strong>
                    <p>The API is missing a provider key, so generation cannot run. Create a board manually and keep working.</p>
                    <button type="button" onClick={onCreateBoard}><Plus size={12} aria-hidden="true" /> Create board manually</button>
                  </div>
                </div>
              )}

              {messages.map((message) => (
                <div className={`home-ai-message is-${message.role}`} key={message.id}>
                  {message.role === 'assistant' && <span className="home-ai-msg-avatar">AI</span>}
                  <div className={`home-ai-bubble ${message.tone === 'error' ? 'is-error' : ''}`}>
                    <p>{message.text}</p>
                  </div>
                  {message.role === 'user' && <span className="home-ai-msg-user">{initialsOf(user?.name)}</span>}
                </div>
              ))}

              {generating && (
                <div className="home-ai-message is-assistant">
                  <span className="home-ai-msg-avatar">AI</span>
                  <div className="home-ai-bubble is-typing">
                    <Loader2 size={13} className="home-spin" aria-hidden="true" />
                    <span>Drafting a board from your brief…</span>
                  </div>
                </div>
              )}

              {!generating && messages.length <= 1 && (
                <div className="home-ai-suggestions">
                  {suggestions.map((suggestion) => (
                    <button type="button" key={suggestion} onClick={() => applySuggestion(suggestion)}>{suggestion}</button>
                  ))}
                </div>
              )}
            </div>

            {aiError && <p className="home-ai-error" role="alert">{aiError}</p>}

            <form className="home-ai-form" onSubmit={generateBoard}>
              <input
                ref={aiInputRef}
                value={goal}
                onChange={(event) => { setGoal(event.target.value); if (aiError) setAiError(''); }}
                maxLength={2000}
                placeholder="Describe a project or sprint goal…"
                aria-label="Describe a project for the AI planner"
                disabled={generating}
                required
              />
              <button type="submit" className="home-ai-send" disabled={generating} aria-label="Generate a board from this brief">
                {generating ? <Loader2 size={13} className="home-spin" aria-hidden="true" /> : <><span>Send</span><Send size={10} aria-hidden="true" /></>}
              </button>
            </form>
          </div>

          <div className="home-ai-board">
            <header className="home-ai-board-head">
              <span className="home-ai-board-title">
                <Activity size={15} aria-hidden="true" />
                Live board · {activeBoardName}
              </span>
              <span className={`home-ai-sync ${previewTasks.length ? 'is-active' : 'is-empty'}`}>
                {previewTasks.length ? 'Sync Active' : activeBoard ? 'No tasks' : 'No board'}
              </span>
            </header>

            <div className="home-ai-board-list">
              {previewTasks.slice(0, 3).map((task) => {
                const badge = badgeForTask(task);
                const icon = task.status === 'done'
                  ? <CheckCircle2 size={15} aria-hidden="true" />
                  : task.status === 'progress' || task.status === 'review'
                    ? <Activity size={15} aria-hidden="true" />
                    : <CircleDot size={15} aria-hidden="true" />;
                return (
                  <button
                    type="button"
                    key={`${task.boardId}-${task.key}`}
                    className="home-ai-task"
                    onClick={() => onOpenTask?.(task)}
                    aria-label={`Open task ${task.key}: ${task.title}`}
                  >
                    <span className={`home-ai-task-icon is-${badge.tone}`}>{icon}</span>
                    <span className="home-ai-task-copy">
                      <strong>{task.key}: {task.title}</strong>
                      <span>
                        {task.assignee && task.assignee !== 'Unassigned' ? `Assignee: ${task.assignee}` : 'Unassigned'}
                        {task.labels?.[0] ? ` • ${task.labels[0]}` : ` • ${statusLabels[task.status] || task.status}`}
                      </span>
                    </span>
                    <span className={`home-ai-task-badge is-${badge.tone}`}>{badge.label}</span>
                  </button>
                );
              })}

              {!previewTasks.length && (
                <div className="home-ai-board-empty">
                  <CircleDot size={16} aria-hidden="true" />
                  <strong>{activeBoard ? 'This board has no tasks yet' : 'No board selected'}</strong>
                  <p>{activeBoard ? 'Add work on the board or generate a plan with the Copilot on the left.' : 'Create a board to see live tasks here.'}</p>
                  <button type="button" onClick={activeBoard ? () => navigate('/board') : onCreateBoard}>
                    {activeBoard ? 'Open board' : 'Create board'} <ArrowRight size={12} aria-hidden="true" />
                  </button>
                </div>
              )}
            </div>

            <footer className="home-ai-board-foot">
              <span><Zap size={12} aria-hidden="true" /> Live from your active board</span>
              <div>
                <button type="button" onClick={() => onOpenBoard?.(activeBoard?.id)} disabled={!activeBoard?.id}>Open board</button>
                <button type="button" onClick={resetChat}>Reset chat</button>
              </div>
            </footer>
          </div>
        </div>
      </section>

      {/* 4. Social proof & real metrics ---------------------------------- */}
      <section className="home-section home-proof" aria-labelledby="home-proof-title">
        <div className="home-proof-panel">
          <div className="home-proof-head">
            <div className="home-proof-copy">
              <span className="home-kicker">Workspace Signals</span>
              <h2 id="home-proof-title">Your workspace, measured in real work</h2>
            </div>
            <div className="home-proof-brands" aria-label="Your boards">
              {proofBoards.map((board) => (
                <button
                  type="button"
                  key={board.id}
                  className="home-proof-brand"
                  onClick={() => onOpenBoard?.(board.id)}
                  title={`Open ${board.name}`}
                >
                  <LayoutGrid size={18} aria-hidden="true" />
                  <span>{board.name}</span>
                </button>
              ))}
              {!proofBoards.length && (
                <button type="button" className="home-proof-brand is-empty" onClick={onCreateBoard}>
                  <Plus size={18} aria-hidden="true" />
                  <span>No boards yet</span>
                </button>
              )}
            </div>
          </div>

          {error && (
            <div className="home-proof-alert" role="alert">
              <AlertTriangle size={15} aria-hidden="true" />
              <span>{error}</span>
              <button type="button" onClick={() => setReloadKey((value) => value + 1)}>Retry</button>
            </div>
          )}

          <div className="home-proof-stats" aria-busy={loading}>
            {proofMetrics.map((metric) => (
              <button
                type="button"
                className={`home-proof-stat is-${metric.tone}`}
                key={metric.id}
                onClick={metric.onClick}
                aria-label={`${metric.label}: ${metric.value}. ${metric.description}`}
              >
                <strong className="home-proof-value">{metric.value}</strong>
                <span className="home-proof-label">{metric.label}</span>
                <p className="home-proof-desc">{metric.description}</p>
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* 5. CTA banner ---------------------------------------------------- */}
      <section className="home-section home-cta" aria-labelledby="home-cta-title">
        <div className="home-cta-banner">
          <div className="home-cta-content">
            <span className="home-cta-badge"><Sparkles size={12} aria-hidden="true" /> AI-assisted planning • Real workspace data</span>
            <h2 id="home-cta-title">Ready to supercharge your agile workflow?</h2>
            <p>Generate a sprint-ready board from a brief, or create one manually and shape it with your team.</p>
            <div className="home-cta-actions">
              <button type="button" className="home-primary" onClick={focusGenerator}>
                <Sparkles size={13} aria-hidden="true" /> Generate Board with AI
              </button>
              <button type="button" className="home-secondary" onClick={onCreateBoard}>
                <Plus size={13} aria-hidden="true" /> Create a board
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
