import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, ArrowLeft, ArrowRight, CalendarDays, Check, ChevronDown, Plus,
  RotateCcw, Search, Sparkles, Target, Trash2, X
} from 'lucide-react';
import { SPRINT_DURATION_DAYS, formatDateRange, endDateForStart, isCalendarDate } from './sprintDates.js';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '';
const priorityLabels = { urgent: 'P0 Urgent', high: 'P1 High', medium: 'P2 Medium', low: 'P3 Low' };
const priorityClass = { urgent: 'priority-urgent', high: 'priority-high', medium: 'priority-medium', low: 'priority-low' };

// Sprint backlog groups reuse the board's status vocabulary so a task reads the same in both views.
const sprintGroups = [
  { id: 'todo', label: 'To Do', hint: 'Ready for dev' },
  { id: 'progress', label: 'In Progress', hint: 'Active execution' },
  { id: 'review', label: 'In Review / QA', hint: 'Validate and ship' },
  { id: 'done', label: 'Done', hint: 'Verified outcomes' }
];

const initials = (name = '') => name.split(' ').filter(Boolean).map((part) => part[0]).join('').slice(0, 2).toUpperCase() || '?';

// Only an active sprint (its date window contains today) can accept backlog items, so
// prefer it when the page opens instead of defaulting to the oldest sprint.
function pickSprintId(list, current) {
  if (current && list.some((sprint) => sprint.id === current)) return current;
  return list.find((sprint) => sprint.current?.state === 'active')?.id ?? list[0]?.id ?? null;
}

async function request(path, token, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    ...options
  });
  const body = await response.json().catch(() => null);
  // 502/504 come from the Vite proxy when the API process is down, not from the API itself.
  if (response.status === 502 || response.status === 503 || response.status === 504) {
    throw new Error('Cannot reach the LeadAI API. Start the backend with `npm run dev:backend` (port 4000), then retry.');
  }
  if (!response.ok) throw new Error(body?.error || `Request failed (${response.status})`);
  return body;
}

export default function SprintBacklog({ token }) {
  const [sprints, setSprints] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [sprintTasks, setSprintTasks] = useState([]);
  const [backlogTasks, setBacklogTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pendingKey, setPendingKey] = useState(null);
  const [editing, setEditing] = useState(null);
  const [query, setQuery] = useState('');
  const [priority, setPriority] = useState('all');

  const selected = useMemo(() => sprints.find((sprint) => sprint.id === selectedId) ?? null, [sprints, selectedId]);

  const loadSprints = useCallback(async () => {
    const list = await request('/api/sprints', token);
    setSprints(list);
    setSelectedId((current) => pickSprintId(list, current));
  }, [token]);

  // Sprint and product backlogs are fetched separately by the API, so a task can never
  // appear in both lists; this refetches both after every mutation.
  const refreshTasks = useCallback(async (sprintId) => {
    const [inSprint, backlog] = await Promise.all([
      sprintId ? request(`/api/sprints/${sprintId}/tasks`, token) : Promise.resolve([]),
      request('/api/backlog', token)
    ]);
    setSprintTasks(inSprint);
    setBacklogTasks(backlog);
  }, [token]);

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      setError('');
      try {
        const list = await request('/api/sprints', token);
        if (!active) return;
        setSprints(list);
        const nextId = pickSprintId(list, null);
        setSelectedId(nextId);
        const [inSprint, backlog] = await Promise.all([
          nextId ? request(`/api/sprints/${nextId}/tasks`, token) : Promise.resolve([]),
          request('/api/backlog', token)
        ]);
        if (!active) return;
        setSprintTasks(inSprint);
        setBacklogTasks(backlog);
      } catch (loadError) {
        if (active) setError(loadError.message);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [token]);

  async function switchSprint(sprintId) {
    setSelectedId(sprintId);
    setLoading(true);
    setError('');
    try {
      await refreshTasks(sprintId);
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoading(false);
    }
  }

  async function runMutation(taskKey, action) {
    setPendingKey(taskKey);
    setError('');
    try {
      await action();
      await refreshTasks(selectedId);
      await loadSprints();
    } catch (mutationError) {
      setError(mutationError.message);
      // Re-read authoritative state even on failure, so a rejected (or partially applied)
      // mutation can never leave these lists out of sync with the database.
      await refreshTasks(selectedId).catch(() => {});
      await loadSprints().catch(() => {});
    } finally {
      setPendingKey(null);
    }
  }

  const moveToSprint = (key) => runMutation(key, () => request(`/api/sprints/${selectedId}/tasks`, token, { method: 'POST', body: JSON.stringify({ key }) }));
  const removeFromSprint = (key) => runMutation(key, () => request(`/api/sprints/${selectedId}/tasks/${key}`, token, { method: 'DELETE' }));

  const matches = (task) => {
    const haystack = `${task.key} ${task.title} ${task.description} ${task.assignee}`.toLowerCase();
    return haystack.includes(query.toLowerCase()) && (priority === 'all' || task.priority === priority);
  };

  const visibleSprintTasks = sprintTasks.filter(matches);
  const visibleBacklog = backlogTasks.filter(matches);
  const selectedIsActive = selected?.current?.state === 'active';
  const totals = selected?.progress ?? { totalStoryPoints: 0, completedStoryPoints: 0, remainingStoryPoints: 0, progressPercent: 0 };

  return <section className="sb-page">
    <div className="sb-context-strip">
      <div className="sb-crumbs"><span>Project</span><ChevronDown size={13} /><strong>Sprint Backlog</strong></div>
      <div className="sb-selector">
        <label className="sb-select"><Target size={14} /><select value={selectedId ?? ''} onChange={(event) => switchSprint(event.target.value)} disabled={sprints.length === 0}>
          {sprints.length === 0 && <option value="">No sprints yet</option>}
          {sprints.map((sprint) => <option key={sprint.id} value={sprint.id}>{sprint.name}</option>)}
        </select><ChevronDown size={13} /></label>
        <button className="secondary-button" onClick={() => setEditing({ mode: 'create' })}><Plus size={15} /> New Sprint</button>
        <button className="secondary-button" disabled={!selected} onClick={() => setEditing({ mode: 'edit', sprint: selected })}><CalendarDays size={15} /> Edit Sprint</button>
      </div>
    </div>

    {error && <div className="sb-alert" role="alert"><AlertTriangle size={15} /><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss"><X size={14} /></button></div>}

    {loading && <div className="sb-loading">Loading sprint backlog...</div>}

    {!loading && sprints.length === 0 && <div className="sb-empty">
      <Target size={22} />
      <h2>No sprints yet</h2>
      <p>Create your first {SPRINT_DURATION_DAYS}-day sprint to start planning work out of the product backlog.</p>
      <button className="primary-button" onClick={() => setEditing({ mode: 'create' })}><Plus size={16} /> New Sprint</button>
    </div>}

    {!loading && selected && <>
      <section className="sb-hero">
        <div className="sb-hero-main">
          <div className="eyebrow">Sprint Backlog</div>
          <h1>{selected.name}</h1>
          <div className="sb-hero-meta">
            <span className="sb-chip"><CalendarDays size={13} /> {formatDateRange(selected.startDate, selected.endDate)}</span>
            <span className={`sb-chip sb-state-${selected.current?.state ?? 'upcoming'}`}>
              {selected.current?.state === 'active' ? `Day ${selected.current.day} of ${selected.current.total}` : selected.current?.state === 'upcoming' ? 'Upcoming' : 'Completed'}
            </span>
            <span className="sb-chip">{selected.durationDays ?? SPRINT_DURATION_DAYS} day sprint</span>
            {selected.current?.state === 'active' && <span className="sb-chip">{selected.current.remaining} days remaining</span>}
          </div>
          {selected.goal && <p className="sb-goal"><strong>Goal:</strong> {selected.goal}</p>}
        </div>
        <div className="sb-progress">
          <div className="sb-progress-head"><span>Commitment progress</span><strong>{totals.progressPercent}%</strong></div>
          <div className="sb-progress-bar"><span style={{ width: `${totals.progressPercent}%` }}></span></div>
          <div className="sb-progress-stats">
            <div><span>Total SP</span><strong>{totals.totalStoryPoints}</strong></div>
            <div><span>Completed</span><strong>{totals.completedStoryPoints}</strong></div>
            <div><span>Remaining</span><strong>{totals.remainingStoryPoints}</strong></div>
          </div>
        </div>
      </section>

      <section className="sb-filters">
        <label className="filter-search"><Search size={15} /><input placeholder="Filter sprint issues..." value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <select value={priority} onChange={(event) => setPriority(event.target.value)} aria-label="Filter by priority">
          <option value="all">Priority: All</option>
          {Object.entries(priorityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <span className="sb-filter-count">{visibleSprintTasks.length} in sprint · {visibleBacklog.length} in backlog</span>
      </section>

      {sprintGroups.map((group) => {
        const groupTasks = visibleSprintTasks.filter((task) => task.status === group.id);
        const groupPoints = groupTasks.reduce((sum, task) => sum + (Number(task.storyPoints) || 0), 0);
        return <section key={group.id} className="sb-group">
          <header className="sb-group-head">
            <div><span className={`sb-dot sb-dot-${group.id}`}></span><strong>{group.label}</strong><em>{group.hint}</em></div>
            <span className="sb-group-count">{groupTasks.length} issues · {groupPoints} SP</span>
          </header>
          {groupTasks.length === 0
            ? <div className="sb-empty-row">No issues in {group.label.toLowerCase()}</div>
            : <div className="sb-list">{groupTasks.map((task) => <SprintTaskRow key={task.key} task={task} busy={pendingKey === task.key} action="remove" onAction={removeFromSprint} disabled={task.status !== 'todo'} disabledReason="Only To Do tasks can return to the Product Backlog." />)}</div>}
        </section>;
      })}

      <section className="sb-group sb-backlog">
        <header className="sb-group-head">
          <div><ChevronDown size={15} /><strong>Product Backlog</strong><em>Unscheduled work · priority first, then oldest</em></div>
          <span className="sb-group-count">{backlogTasks.length} issues · {backlogTasks.reduce((sum, task) => sum + (Number(task.storyPoints) || 0), 0)} SP</span>
        </header>
        {!selectedIsActive && <div className="sb-backlog-note" role="status">
          <AlertTriangle size={14} />
          <span>{selected ? `"${selected.name}" is ${selected.current?.state === 'upcoming' ? 'upcoming' : 'completed'}. ` : ''}Only an active sprint can accept backlog items.</span>
          <button className="secondary-button" onClick={() => setEditing({ mode: 'create' })}><Plus size={14} /> New Sprint</button>
        </div>}
        {backlogTasks.length === 0
          ? <div className="sb-empty-row">Every task is committed to a sprint.</div>
          : <div className="sb-list">{visibleBacklog.map((task) => <SprintTaskRow key={task.key} task={task} busy={pendingKey === task.key} action="add" onAction={moveToSprint} disabled={!selectedIsActive} disabledReason="Select or create an active sprint first." />)}</div>}
      </section>
    </>}

    {editing && <SprintModal
      mode={editing.mode}
      sprint={editing.sprint}
      token={token}
      onClose={() => setEditing(null)}
      onSaved={async () => {
        setEditing(null);
        await loadSprints();
        await refreshTasks(selectedId);
      }}
    />}
  </section>;
}

function SprintTaskRow({ task, busy, action, onAction, disabled = false, disabledReason = '' }) {
  const labels = Array.isArray(task.labels) ? task.labels : [];
  const priority = priorityLabels[task.priority] ? task.priority : 'medium';
  return <article className={`sb-row ${busy ? 'is-busy' : ''}`}>
    <span className="sb-row-key">#{task.key}</span>
    <div className="sb-row-main">
      <h3>{task.title}</h3>
      <div className="sb-row-tags">
        {labels.map((label) => <span key={label} className="sb-tag">{label}</span>)}
        <span className={`priority ${priorityClass[priority]}`}>{priorityLabels[priority]}</span>
        <span className="sb-points">{task.storyPoints || 0} SP</span>
      </div>
    </div>
    <span className="sb-row-assignee"><i>{initials(task.assignee)}</i>{task.assignee}</span>
    {action === 'add'
      ? <button className="secondary-button sb-action" disabled={busy || disabled} title={disabled ? disabledReason : undefined} onClick={() => onAction(task.key)}><ArrowRight size={14} /> Move to Sprint</button>
      : <button className="secondary-button sb-action" disabled={busy || disabled} title={disabled ? disabledReason : undefined} onClick={() => onAction(task.key)}><ArrowLeft size={14} /> Return to Backlog</button>}
  </article>;
}

function SprintModal({ mode, sprint, token, onClose, onSaved }) {
  const initialStart = sprint?.startDate ?? '';
  const [name, setName] = useState(sprint?.name ?? '');
  const [goal, setGoal] = useState(sprint?.goal ?? '');
  const [startDate, setStartDate] = useState(initialStart);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const endDate = startDate && isCalendarDate(startDate) ? endDateForStart(startDate) : '';
  const range = formatDateRange(startDate, endDate);

  async function submit(event) {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      await request(mode === 'create' ? '/api/sprints' : `/api/sprints/${sprint.id}`, token, {
        method: mode === 'create' ? 'POST' : 'PATCH',
        body: JSON.stringify({ name, goal, startDate, endDate })
      });
      await onSaved();
    } catch (submitError) {
      setError(submitError.message);
    } finally {
      setSaving(false);
    }
  }

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !saving && onClose()}>
    <form className="task-modal sb-modal" onSubmit={submit}>
      <div className="modal-heading">
        <div><div className="eyebrow">{mode === 'create' ? 'New sprint' : 'Update sprint'}</div><h2>{mode === 'create' ? 'Create sprint' : 'Edit sprint'}</h2></div>
        <button type="button" className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={17} /></button>
      </div>
      {error && <div className="sb-alert" role="alert"><AlertTriangle size={15} /><span>{error}</span></div>}
      <label>Sprint name<input value={name} onChange={(event) => setName(event.target.value)} required autoFocus placeholder="e.g. Sprint 15 - Platform Hardening" /></label>
      <label>Sprint goal<textarea rows={3} value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="What does this sprint achieve?" /></label>
      <div className="form-grid">
        <label>Start date<input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} required /></label>
        <label>Duration<input value={`${SPRINT_DURATION_DAYS} days`} readOnly tabIndex={-1} /></label>
      </div>
      <p className="sb-modal-note">
        {isCalendarDate(startDate)
          ? <><Check size={13} /> {range} · Day 1 is the start date, Day {SPRINT_DURATION_DAYS} is {range.split(' - ')[1]}.</>
          : <><AlertTriangle size={13} /> Pick a start date; the end date and {SPRINT_DURATION_DAYS}-day window are derived from it.</>}
      </p>
      <div className="modal-actions">
        <button type="button" className="secondary-button" onClick={onClose}>Cancel</button>
        <button type="submit" className="primary-button" disabled={saving}>{saving ? <><RotateCcw size={15} /> Saving...</> : mode === 'create' ? <><Plus size={15} /> Create sprint</> : <><Check size={15} /> Save changes</>}</button>
      </div>
    </form>
  </div>;
}