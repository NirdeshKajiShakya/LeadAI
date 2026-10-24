import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, AlertTriangle, ArrowRight, CalendarDays, CheckCircle2, CircleDot,
  LayoutGrid, Loader2, Plus, Send, Sparkles
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

const priorityShort = { urgent: 'P0', high: 'P1', medium: 'P2', low: 'P3' };

// Three truthful buckets of the selected board. Each group is a real status
// filter, not a decorative stage.
const stages = [
  { id: 'ready', title: 'Backlog & To Do', tone: 'ready', statuses: ['backlog', 'todo'] },
  { id: 'flight', title: 'In progress', tone: 'flight', statuses: ['progress', 'review'] },
  { id: 'done', title: 'Done', tone: 'done', statuses: ['done'] }
];

const STAGE_TASK_LIMIT = 3;
const NEXT_TASK_LIMIT = 4;

function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}

function todayIsoDate() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function shortDate(value) {
  if (!value) return '';
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function taskFlag(task, today) {
  if (isCalendarDate(task.dueDate) && task.dueDate < today && task.status !== 'done') {
    return { label: 'Overdue', tone: 'danger' };
  }
  if (task.dueDate === today && task.status !== 'done') return { label: 'Due today', tone: 'warn' };
  if (task.aiSuggested) return { label: 'AI', tone: 'ai' };
  return null;
}

function BoardTask({ task, today, onOpenTask }) {
  const flag = taskFlag(task, today);
  const owner = task.assignee && task.assignee !== 'Unassigned' ? task.assignee : '';

  return (
    <button
      type="button"
      className="home-task"
      onClick={() => onOpenTask?.(task)}
    >
      <span className="visually-hidden">Open task </span>
      <span className="home-task-top">
        <span className="home-task-key">#{task.key}</span>
        {flag && <span className={`home-task-flag is-${flag.tone}`}>{flag.label}</span>}
      </span>
      <span className="home-task-title">{task.title}</span>
      <span className="home-task-meta">
        {isCalendarDate(task.dueDate)
          ? <><CalendarDays size={11} aria-hidden="true" /><span>{shortDate(task.dueDate)}</span></>
          : <><CircleDot size={11} aria-hidden="true" /><span>{owner || statusLabels[task.status] || task.status}</span></>}
        {isCalendarDate(task.dueDate) && owner && <><span aria-hidden="true">·</span><span>{owner}</span></>}
      </span>
    </button>
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
  focusAiKey = 0
}) {
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  const [goal, setGoal] = useState('');
  const [messages, setMessages] = useState([{
    id: 'welcome',
    role: 'assistant',
    text: 'Describe what you are building. I will turn the brief into a prioritised board with tasks you can refine.'
  }]);
  const [generating, setGenerating] = useState(false);
  const [aiError, setAiError] = useState('');

  const aiInputRef = useRef(null);
  const threadRef = useRef(null);
  const onSessionExpiredRef = useRef(onSessionExpired);

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
        if (!cancelled && data) setSummary(data);
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
  const allBoards = boards.length ? boards : summaryBoards;
  const activeBoard = allBoards.find((board) => String(board.id) === String(activeBoardId)) || allBoards[0] || null;
  const currentBoardId = activeBoardId || activeBoard?.id || '';
  const aiConfigured = summary?.ai?.configured;
  const aiOffline = aiConfigured === false;
  const today = todayIsoDate();

  // Only tasks that belong to the board named in the header are shown here.
  const scopedTasks = useMemo(() => (
    (boardTasks || []).filter((task) => !currentBoardId || String(task.boardId) === String(currentBoardId))
  ), [boardTasks, currentBoardId]);

  const doneCount = scopedTasks.filter((task) => task.status === 'done').length;
  const openCount = scopedTasks.length - doneCount;
  const overdueOnBoard = scopedTasks.filter((task) => (
    task.status !== 'done' && isCalendarDate(task.dueDate) && task.dueDate < today
  )).length;

  const stageGroups = useMemo(() => stages.map((stage) => {
    const tasks = scopedTasks.filter((task) => stage.statuses.includes(task.status));
    return { ...stage, tasks, total: tasks.length };
  }), [scopedTasks]);

  const upNext = useMemo(() => (
    scopedTasks
      .filter((task) => task.status !== 'done' && isCalendarDate(task.dueDate))
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || String(a.key).localeCompare(String(b.key)))
      .slice(0, NEXT_TASK_LIMIT)
  ), [scopedTasks]);

  const sprintTotal = activeSprint?.progress?.total || 0;
  const sprintDone = activeSprint?.progress?.completed || 0;
  const sprintPercent = sprintTotal
    ? Math.max(0, Math.min(100, Number(activeSprint?.progress?.progressPercent) || 0))
    : 0;
  const sprintRange = activeSprint && isCalendarDate(activeSprint.startDate) && isCalendarDate(activeSprint.endDate)
    ? formatDateRange(activeSprint.startDate, activeSprint.endDate)
    : '';

  const boardName = activeBoard?.name || '';
  const displayName = String(user?.name || '').trim().split(/\s+/)[0] || '';
  const heading = boardName || (displayName ? `${displayName}'s workspace` : 'Your workspace');
  const subtitle = activeBoard
    ? `${openCount} open task${openCount === 1 ? '' : 's'} · ${overdueOnBoard} overdue · ${doneCount} done on ${boardName}.`
    : 'Create your first board to start planning real work.';

  const metrics = [
    {
      id: 'open',
      label: 'Open tasks',
      icon: <CircleDot size={12} aria-hidden="true" />,
      tone: 'accent',
      value: activeBoard ? openCount : '—',
      note: activeBoard
        ? `${scopedTasks.length} task${scopedTasks.length === 1 ? '' : 's'} on this board`
        : 'No board selected yet',
      onClick: () => (activeBoard ? onOpenBoard?.(activeBoard.id) : onCreateBoard?.())
    },
    {
      id: 'overdue',
      label: 'Overdue',
      icon: <AlertTriangle size={12} aria-hidden="true" />,
      tone: stats?.overdueTasks ? 'danger' : 'green',
      value: stats ? stats.overdueTasks : '—',
      note: stats
        ? (stats.overdueTasks ? 'Past due and still open' : 'Nothing overdue')
        : 'Loading workspace totals…',
      onClick: () => navigate('/board')
    },
    {
      id: 'sprint',
      label: 'Sprint progress',
      icon: <Activity size={12} aria-hidden="true" />,
      tone: 'cyan',
      value: sprintTotal ? `${sprintPercent}%` : '—',
      note: activeSprint
        ? (sprintTotal ? `${sprintDone} of ${sprintTotal} tasks done` : `${activeSprint.name} has no tasks yet`)
        : 'No active sprint',
      onClick: () => navigate('/backlog')
    },
    {
      id: 'boards',
      label: 'Boards',
      icon: <LayoutGrid size={12} aria-hidden="true" />,
      tone: 'accent',
      value: stats ? stats.boards : '—',
      note: stats
        ? `${stats.myOpenTasks} open task${stats.myOpenTasks === 1 ? '' : 's'} assigned to you`
        : 'Loading workspace totals…',
      onClick: () => navigate('/team')
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
    if (generating || aiOffline) return;
    const trimmedGoal = goal.trim();
    if (trimmedGoal.length < 10) {
      setAiError('Describe the project in at least 10 characters so the planner has enough context.');
      aiInputRef.current?.focus();
      return;
    }

    setMessages((current) => [...current, { id: `user-${Date.now()}`, role: 'user', text: trimmedGoal }]);
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

  const suggestions = activeBoard
    ? [`Plan the next sprint for ${boardName}`, `Draft a launch checklist for ${boardName}`]
    : ['Plan a new product board', 'Draft a launch checklist for a marketing site'];

  return (
    <div className="home-page">
      <header className="home-head">
        <div className="home-head-copy">
          <span className="home-eyebrow"><span className="home-eyebrow-dot" aria-hidden="true" />Workspace overview</span>
          <h1>{heading}</h1>
          <p className="home-head-sub">{subtitle}</p>
        </div>
        <div className="home-head-actions">
          <button type="button" className="home-button" onClick={focusGenerator}>
            <Sparkles size={14} aria-hidden="true" /> Plan with AI
          </button>
          <button
            type="button"
            className="home-button is-primary"
            onClick={() => (activeBoard ? onOpenBoard?.(activeBoard.id) : onCreateBoard?.())}
          >
            {activeBoard
              ? <><LayoutGrid size={14} aria-hidden="true" /> Open board</>
              : <><Plus size={14} aria-hidden="true" /> Create board</>}
          </button>
        </div>
      </header>

      {error && (
        <div className="home-banner" role="alert">
          <AlertTriangle size={15} aria-hidden="true" />
          <span>{error}</span>
          <button type="button" onClick={() => setReloadKey((value) => value + 1)}>Retry</button>
        </div>
      )}

      <section className="home-stats" aria-label="Workspace totals" aria-busy={loading}>
        {metrics.map((metric) => (
          <button
            type="button"
            key={metric.id}
            className={`home-stat is-${metric.tone}`}
            onClick={metric.onClick}
          >
            <span className="home-stat-label">{metric.icon}{metric.label}</span>
            <strong className="home-stat-value">{metric.value}</strong>
            <span className="home-stat-note">{metric.note}</span>
          </button>
        ))}
      </section>

      <div className="home-columns">
        <section className="home-panel home-snapshot" aria-labelledby="home-snapshot-title">
          <header className="home-panel-head">
            <div>
              <h2 id="home-snapshot-title">Board snapshot</h2>
              <p>{activeBoard ? `Real work on ${boardName}` : 'No board yet — create one to see it here'}</p>
            </div>
            {activeBoard && (
              <button type="button" className="home-link" onClick={() => onOpenBoard?.(activeBoard.id)}>
                Open board <ArrowRight size={12} aria-hidden="true" />
              </button>
            )}
          </header>

          {loading && !summary ? (
            <div className="home-skeleton" role="status" aria-label="Loading board snapshot">
              <span /><span /><span />
            </div>
          ) : (
            <div className="home-stages">
              {stageGroups.map((stage) => (
                <div className={`home-stage is-${stage.tone}`} key={stage.id}>
                  <div className="home-stage-head">
                    <span className="home-stage-dot" aria-hidden="true" />
                    <strong>{stage.title}</strong>
                    <em>{stage.total}</em>
                  </div>
                  <div className="home-stage-body">
                    {stage.tasks.slice(0, STAGE_TASK_LIMIT).map((task) => (
                      <BoardTask key={`${task.boardId}-${task.key}`} task={task} today={today} onOpenTask={onOpenTask} />
                    ))}
                    {!stage.tasks.length && (
                      <p className="home-stage-empty">
                        <CircleDot size={13} aria-hidden="true" />
                        {activeBoard ? 'Nothing here yet' : 'Create a board first'}
                      </p>
                    )}
                    {stage.tasks.length > STAGE_TASK_LIMIT && (
                      <p className="home-stage-empty">
                        +{stage.tasks.length - STAGE_TASK_LIMIT} more on the board
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <aside className="home-side">
          <section className="home-panel home-sprint" aria-labelledby="home-sprint-title">
            <header className="home-panel-head">
              <div>
                <h2 id="home-sprint-title">Sprint</h2>
                <p>{activeSprint ? (activeSprint.current ? 'Active cycle' : 'Upcoming cycle') : 'No cycle running'}</p>
              </div>
            </header>

            {activeSprint ? (
              <>
                <p className="home-sprint-name">{activeSprint.name}</p>
                {sprintRange && <p className="home-sprint-range">{sprintRange}</p>}
                <div className="home-sprint-progress">
                  <strong>{sprintTotal ? `${sprintPercent}%` : '—'}</strong>
                  <span>{sprintTotal ? `${sprintDone}/${sprintTotal} done` : 'not measured'}</span>
                </div>
                <div
                  className="home-meter"
                  role="progressbar"
                  aria-label="Sprint completion"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={sprintPercent}
                >
                  <span style={{ width: `${sprintPercent}%` }} />
                </div>
                <div className="home-sprint-meta">
                  <span>{sprintTotal ? `${sprintTotal - sprintDone} remaining` : 'Commit tasks to measure progress'}</span>
                  {activeSprint.boardName && <span>{activeSprint.boardName}</span>}
                </div>
                <div className="home-sprint-foot">
                  <button type="button" className="home-link" onClick={() => navigate('/backlog')}>
                    Open sprint <ArrowRight size={12} aria-hidden="true" />
                  </button>
                </div>
              </>
            ) : (
              <div className="home-sprint-empty">
                <p>No sprint is active. Plan one to group real work into a cycle and track completion here.</p>
                <button type="button" className="home-button" onClick={() => navigate('/backlog')}>
                  Plan a sprint <ArrowRight size={13} aria-hidden="true" />
                </button>
              </div>
            )}
          </section>

          <section className="home-panel home-next" aria-labelledby="home-next-title">
            <header className="home-panel-head">
              <div>
                <h2 id="home-next-title">Up next</h2>
                <p>Open tasks with a due date, soonest first</p>
              </div>
            </header>

            {upNext.length ? (
              <ul className="home-next-list">
                {upNext.map((task) => {
                  const overdue = task.dueDate < today;
                  return (
                    <li className="home-next-item" key={`${task.boardId}-${task.key}`}>
                      <button type="button" onClick={() => onOpenTask?.(task)}>
                        <span className={`home-next-dot is-${task.priority}`} aria-hidden="true" />
                        <span className="home-next-copy">
                          <span className="home-next-title"><span className="visually-hidden">Open task </span>{task.title}</span>
                          <span className="home-next-meta">
                            #{task.key} · {priorityShort[task.priority] || 'P2'} · {statusLabels[task.status] || task.status}
                          </span>
                        </span>
                        <span className={`home-next-due ${overdue ? 'is-overdue' : ''}`}>{shortDate(task.dueDate)}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="home-next-empty">
                <CheckCircle2 size={14} aria-hidden="true" />
                {activeBoard
                  ? 'No open task has a due date on this board. Add dates on the board to see them here.'
                  : 'Create a board and add dated tasks to plan your week.'}
              </p>
            )}
          </section>
        </aside>
      </div>

      <section className="home-panel home-ai" id="home-ai" aria-labelledby="home-ai-title">
        <header className="home-panel-head">
          <div>
            <h2 id="home-ai-title">Plan a board with AI</h2>
            <p>Describe the project in plain language. LeadAI drafts the board and its tasks, then opens it for review.</p>
          </div>
          <span className={`home-ai-status ${aiOffline ? 'is-offline' : ''}`}>
            <i aria-hidden="true" />
            {aiOffline ? 'AI provider not configured' : aiConfigured ? 'AI planner ready' : 'Checking AI status…'}
          </span>
        </header>

        <div className="home-ai-thread" ref={threadRef} role="log" aria-live="polite" aria-label="AI planning conversation">
          {aiOffline && (
            <div className="home-ai-notice" role="status">
              <AlertTriangle size={15} aria-hidden="true" />
              <div>
                <strong>AI planning is not configured on this server.</strong>
                <p>An administrator can add a provider in Settings. You can still create a board and add tasks manually.</p>
                <button type="button" onClick={onCreateBoard}>
                  <Plus size={12} aria-hidden="true" /> Create board manually
                </button>
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

          {!generating && !aiOffline && messages.length <= 1 && (
            <div className="home-ai-suggestions">
              {suggestions.map((suggestion) => (
                <button
                  type="button"
                  key={suggestion}
                  onClick={() => { setGoal(suggestion); setAiError(''); aiInputRef.current?.focus(); }}
                >
                  {suggestion}
                </button>
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
            placeholder={aiOffline ? 'AI planning is unavailable until a provider is configured' : 'Describe a project, product or sprint goal…'}
            aria-label="Describe a project for the AI planner"
            disabled={generating || aiOffline}
            required
          />
          <button type="submit" className="home-ai-send" disabled={generating || aiOffline || !goal.trim()} aria-label="Generate a board from this brief">
            {generating
              ? <Loader2 size={14} className="home-spin" aria-hidden="true" />
              : <><span>Generate</span><Send size={11} aria-hidden="true" /></>}
          </button>
        </form>
      </section>
    </div>
  );
}
