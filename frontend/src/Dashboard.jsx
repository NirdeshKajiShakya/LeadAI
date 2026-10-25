import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, ArrowRight, ArrowUpRight, Bot, CalendarDays, CheckCircle2,
  CircleDot, GitBranch, LayoutGrid, Loader2, Plus, Send, Sparkles
} from 'lucide-react';
import { formatDateRange, isCalendarDate } from './sprintDates.js';
import { formatDate } from './formatDate.js';

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
  { id: 'ready', title: 'Ready for Dev', statuses: ['backlog', 'todo'] },
  { id: 'flight', title: 'In Flight', statuses: ['progress', 'review'] },
  { id: 'done', title: 'Done', statuses: ['done'] }
];

function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}

function shortDate(value) {
  return formatDate(value);
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
  onSelectBoard,
  onSummary,
  focusAiKey = 0
}) {
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);

  const [goal, setGoal] = useState('');
  const [generating, setGenerating] = useState(false);
  const [aiError, setAiError] = useState('');

  const aiInputRef = useRef(null);
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
    setSummary(null);
    onSummaryRef.current?.(null);
    const boardQuery = `?boardId=${encodeURIComponent(activeBoardId)}`;
    fetch(`${API_BASE_URL}/api/dashboard/summary${boardQuery}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(async (response) => {
        if (response.status === 401) {
          onSessionExpiredRef.current?.();
          return null;
        }
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error('Workspace summary unavailable.');
        return body;
      })
      .then((data) => {
        if (!cancelled) {
          setSummary(data);
          onSummaryRef.current?.(data);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSummary(null);
          onSummaryRef.current?.(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [token, refreshKey, activeBoardId]);

  useEffect(() => {
    if (!focusAiKey) return;
    const node = aiInputRef.current;
    if (!node) return;
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    node.focus({ preventScroll: true });
  }, [focusAiKey]);

  const stats = summary?.stats && typeof summary.stats === 'object' ? summary.stats : null;
  const activeSprint = summary?.activeSprint && typeof summary.activeSprint === 'object' ? summary.activeSprint : null;
  const summaryBoards = useMemo(() => (Array.isArray(summary?.boards) ? summary.boards : []), [summary]);
  const priorityTasks = useMemo(() => (Array.isArray(summary?.priorityTasks) ? summary.priorityTasks : []), [summary]);
  const allBoards = boards.length ? boards : summaryBoards;
  const activeBoard = allBoards.find((board) => String(board.id) === String(activeBoardId)) || allBoards[0] || null;
  const currentBoardId = activeBoardId || activeBoard?.id || '';
  const activeBoardName = activeBoard?.name || 'No board selected';
  const aiConfigured = summary?.ai?.configured;
  // The preview must only ever show tasks that belong to the board the header
  // says is selected. While no board exists we fall back to the summary list so
  // a brand new workspace still has a useful, real-data empty shell.
  const scopedTasks = useMemo(() => (
    (Array.isArray(boardTasks) ? boardTasks : []).filter((task) => !currentBoardId || String(task.boardId) === String(currentBoardId))
  ), [boardTasks, currentBoardId]);
  const previewTasks = currentBoardId ? scopedTasks : priorityTasks;
  const stages = useMemo(() => previewStages.map((stage) => {
    const tasks = previewTasks.filter((task) => stage.statuses.includes(task.status));
    return { ...stage, tasks };
  }), [previewTasks]);

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

      await onGeneratedBoard?.(body.board, body.tasksCreated);
    } catch (requestError) {
      const message = requestError.message || 'Could not generate a board. Please try again.';
      setAiError(message);
    } finally {
      setGenerating(false);
    }
  }

  const welcomeName = String(user?.name || '').trim().split(/\s+/)[0];
  const sprintForBoard = activeSprint && String(activeSprint.boardId || '') === String(currentBoardId)
    ? activeSprint
    : null;
  const activeSprintCount = sprintForBoard ? Number(stats?.activeSprints) || 0 : 0;
  const sprintProgress = Math.max(0, Math.min(100, Number(sprintForBoard?.progress?.progressPercent) || 0));
  const sprintDateRange = sprintForBoard && isCalendarDate(sprintForBoard.startDate) && isCalendarDate(sprintForBoard.endDate)
    ? formatDateRange(sprintForBoard.startDate, sprintForBoard.endDate)
    : '';
  const openTaskCount = Number.isFinite(Number(stats?.myOpenTasks))
    ? Number(stats.myOpenTasks)
    : previewTasks.filter((task) => task.status !== 'done').length;
  const inFlightCount = previewTasks.filter((task) => ['progress', 'review'].includes(task.status)).length;

  return (
    <div className="home-page workspace-dashboard">
      <section className="dashboard-welcome" aria-labelledby="home-title">
        <div>
          <span className="dashboard-eyebrow">Engineering workspace</span>
          <h1 id="home-title">Welcome back{welcomeName ? `, ${welcomeName}` : ''}</h1>
          <p>{activeBoard ? <>Working in <strong>{activeBoardName}</strong></> : 'Create a board to start organizing your work.'}</p>
        </div>
        <div className="dashboard-actions">
          <button type="button" className="home-secondary" onClick={onCreateBoard}><Plus size={15} /> New Board</button>
          <button type="button" className="home-primary" onClick={focusGenerator}><Sparkles size={15} /> Generate with AI</button>
        </div>
      </section>

      <section className="dashboard-metrics" aria-label="Workspace health">
        <button type="button" className="dashboard-metric" onClick={() => navigate('/backlog')}>
          <span className="dashboard-metric-icon is-indigo"><Activity size={17} /></span>
          <span className="dashboard-metric-copy">
            <span>Active sprints</span>
            <strong>{loading && !summary ? '—' : activeSprintCount}</strong>
            <small>{sprintForBoard ? `${sprintForBoard.name}${sprintDateRange ? ` · ${sprintDateRange}` : ''}` : 'No active sprint'}</small>
          </span>
          {sprintForBoard && <span className="dashboard-metric-progress">{sprintProgress}%</span>}
        </button>
        <button type="button" className="dashboard-metric" onClick={() => navigate('/board')}>
          <span className="dashboard-metric-icon is-cyan"><CircleDot size={17} /></span>
          <span className="dashboard-metric-copy">
            <span>Open tasks</span>
            <strong>{loading && !summary && !previewTasks.length ? '—' : openTaskCount}</strong>
            <small>{inFlightCount} in flight on this board</small>
          </span>
        </button>
        <div className="dashboard-metric dashboard-metric-workspace">
          <span className="dashboard-metric-icon is-violet"><LayoutGrid size={17} /></span>
          <span className="dashboard-metric-copy">
            <span>Boards</span>
            <strong>{allBoards.length}</strong>
            <small>Recent workspace boards</small>
          </span>
        </div>
      </section>

      <section className="dashboard-switcher" aria-labelledby="board-switcher-title">
        <div className="dashboard-section-heading">
          <div><span className="dashboard-eyebrow">Workspace</span><h2 id="board-switcher-title">Recent boards</h2></div>
          <button type="button" className="dashboard-text-action" onClick={() => navigate('/team')}>Manage boards <ArrowRight size={14} /></button>
        </div>
        <div className="dashboard-board-list">
          {allBoards.length ? allBoards.slice(0, 8).map((board) => (
            <button
              type="button"
              className={`dashboard-board-chip ${String(board.id) === String(currentBoardId) ? 'is-active' : ''}`}
              key={board.id}
              onClick={() => onSelectBoard?.(board.id)}
              aria-pressed={String(board.id) === String(currentBoardId)}
              title={`Switch to ${board.name}`}
            >
              <LayoutGrid size={15} />
              <span>{board.name}</span>
              {board.openTasks != null && <small>{board.openTasks} open</small>}
            </button>
          )) : (
            <div className="dashboard-inline-empty">
              <span>No boards yet</span>
              <button type="button" className="dashboard-text-action" onClick={onCreateBoard}>Create your first board <ArrowRight size={14} /></button>
            </div>
          )}
        </div>
      </section>

      <section className="dashboard-board-spotlight" aria-labelledby="board-spotlight-title">
        <div className="dashboard-section-heading">
          <div>
            <span className="dashboard-eyebrow">Active board</span>
            <h2 id="board-spotlight-title">{activeBoardName}</h2>
          </div>
          <button type="button" className="dashboard-text-action" onClick={() => onOpenBoard?.(activeBoard?.id)} disabled={!activeBoard?.id}>
            Open full board <ArrowUpRight size={15} />
          </button>
        </div>
        {activeBoard ? (
          <div className="dashboard-kanban-preview">
            {stages.map((stage) => (
              <div className="dashboard-preview-column" key={stage.id}>
                <div className="dashboard-preview-heading">
                  <span><i className={`is-${stage.id}`} />{stage.title}</span>
                  <strong>{stage.tasks.length}</strong>
                </div>
                <div className="dashboard-preview-tasks">
                  {stage.tasks.slice(0, 3).map((task) => (
                    <PreviewTaskCard key={`${task.boardId}-${task.key}`} task={task} onOpenTask={onOpenTask} />
                  ))}
                  {!stage.tasks.length && <div className="dashboard-column-empty">No tasks in this stage</div>}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="dashboard-empty">
            <LayoutGrid size={21} />
            <strong>Your workspace is ready for its first board</strong>
            <p>Create a board manually or ask Copilot to turn a project brief into a plan.</p>
            <button type="button" className="home-primary" onClick={onCreateBoard}><Plus size={14} /> Create a board</button>
          </div>
        )}
      </section>

      <section className="dashboard-copilot" aria-labelledby="home-ai-title">
        <div className="dashboard-copilot-heading">
          <span className="dashboard-copilot-icon"><Bot size={18} /></span>
          <div>
            <span className="dashboard-eyebrow">AI Copilot</span>
            <h2 id="home-ai-title">Ask Copilot. Watch Your Board Take Shape.</h2>
            <p>Describe the project or sprint you want to plan. Copilot creates a board and opens it when ready.</p>
          </div>
          {aiConfigured === false && <span className="dashboard-ai-status">AI unavailable</span>}
        </div>
        <form className="dashboard-prompt" onSubmit={generateBoard}>
          <Sparkles size={17} aria-hidden="true" />
          <input
            ref={aiInputRef}
            value={goal}
            onChange={(event) => { setGoal(event.target.value); if (aiError) setAiError(''); }}
            maxLength={2000}
            placeholder="e.g. Build an e-commerce checkout sprint"
            aria-label="Describe a project for the AI planner"
            disabled={generating || aiConfigured === false}
            required
          />
          <button type="submit" className="home-primary" disabled={generating || aiConfigured === false}>
            {generating ? <Loader2 size={15} className="home-spin" /> : <><span>Generate board</span><Send size={13} /></>}
          </button>
        </form>
        {aiError && <p className="dashboard-ai-error" role="alert">{aiError}</p>}
        {aiConfigured === false && <p className="dashboard-ai-note">AI generation is not configured on this server. You can still create a board manually.</p>}
      </section>
    </div>
  );

}
