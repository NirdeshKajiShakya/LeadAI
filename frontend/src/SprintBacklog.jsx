import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowLeft, ArrowRight, CalendarDays, Check, ChevronDown, Plus,
  RotateCcw, Search, Sparkles, Target, Trash2, X
} from 'lucide-react';
import { SPRINT_DURATION_DAYS, formatDateRange, endDateForStart, isCalendarDate } from './sprintDates.js';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '';
const storyPointOptions = [0, 1, 2, 3, 5, 8, 13];
const validStoryPointSet = new Set(storyPointOptions);
const safeStoryPoints = (value) => Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 100 ? Number(value) : 0;
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

// Prefer an active sprint, but still select the first existing sprint when there is no
// active one so changing boards never hides that board's upcoming or completed sprints.
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

export default function SprintBacklog({ token, activeBoardId = '', activeBoardName = '' }) {
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
  const [aiPlannerOpen, setAiPlannerOpen] = useState(false);
  const [aiGoal, setAiGoal] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState('');
  const activeBoardIdRef = useRef(activeBoardId);
  activeBoardIdRef.current = activeBoardId;

  const selected = useMemo(() => sprints.find((sprint) =>
    sprint.id === selectedId && String(sprint.boardId || '') === String(activeBoardId)
  ) ?? null, [activeBoardId, sprints, selectedId]);
  const boardScope = activeBoardId ? `?boardId=${encodeURIComponent(activeBoardId)}` : '';

  const loadSprints = useCallback(async (preferredId = null) => {
    if (!activeBoardId) {
      setSprints([]);
      setSelectedId(null);
      return null;
    }
    const response = await request(`/api/sprints?boardId=${encodeURIComponent(activeBoardId)}`, token);
    if (String(activeBoardIdRef.current) !== String(activeBoardId)) return null;
    const list = response.filter((sprint) => String(sprint.boardId || '') === String(activeBoardId));
    setSprints(list);
    const nextId = pickSprintId(list, preferredId);
    setSelectedId(nextId);
    return nextId;
  }, [activeBoardId, token]);

  // Sprint and product backlogs are fetched separately by the API, so a task can never
  // appear in both lists; this refetches both after every mutation.
  const refreshTasks = useCallback(async (sprintId) => {
    if (String(activeBoardIdRef.current) !== String(activeBoardId)) return;
    if (!activeBoardId) {
      setSprintTasks([]);
      setBacklogTasks([]);
      return;
    }
    const [responseSprintTasks, responseBacklog] = await Promise.all([
      sprintId ? request(`/api/sprints/${sprintId}/tasks${boardScope}`, token) : Promise.resolve([]),
      request(`/api/backlog${boardScope}`, token)
    ]);
    if (String(activeBoardIdRef.current) !== String(activeBoardId)) return;
    setSprintTasks(responseSprintTasks.filter((task) => String(task.boardId || '') === String(activeBoardId)));
    setBacklogTasks(responseBacklog.filter((task) => String(task.boardId || '') === String(activeBoardId)));
  }, [activeBoardId, boardScope, token]);

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      setError('');
      setSprints([]);
      setSelectedId(null);
      setSprintTasks([]);
      setBacklogTasks([]);
      setEditing(null);
      setAiPlannerOpen(false);
      setAiGoal('');
      setAiError('');
      if (!activeBoardId) {
        setLoading(false);
        return;
      }
      try {
        const responseSprints = await request(`/api/sprints${boardScope}`, token);
        const list = responseSprints.filter((sprint) => String(sprint.boardId || '') === String(activeBoardId));
        if (!active) return;
        setSprints(list);
        const nextId = pickSprintId(list, null);
        setSelectedId(nextId);
        const [responseSprintTasks, responseBacklog] = await Promise.all([
          nextId ? request(`/api/sprints/${nextId}/tasks${boardScope}`, token) : Promise.resolve([]),
          request(`/api/backlog${boardScope}`, token)
        ]);
        if (!active) return;
        setSprintTasks(responseSprintTasks.filter((task) => String(task.boardId || '') === String(activeBoardId)));
        setBacklogTasks(responseBacklog.filter((task) => String(task.boardId || '') === String(activeBoardId)));
      } catch (loadError) {
        if (active) setError(loadError.message);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [activeBoardId, boardScope, token]);

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

  const moveToSprint = (key) => runMutation(key, () => request(`/api/sprints/${selectedId}/tasks${boardScope}`, token, { method: 'POST', body: JSON.stringify({ key }) }));
  const removeFromSprint = (key) => runMutation(key, () => request(`/api/sprints/${selectedId}/tasks/${key}${boardScope}`, token, { method: 'DELETE' }));

  async function generateSprint(event) {
    event.preventDefault();
    if (aiBusy) return;
    setAiBusy(true);
    setAiError('');
    setError('');
    try {
      const result = await request('/api/ai/sprints', token, {
        method: 'POST',
        body: JSON.stringify({
          goal: aiGoal.trim(),
          boardId: activeBoardId
        })
      });
      if (!result?.sprint?.id) throw new Error('The AI planner did not return a created sprint.');
      setAiPlannerOpen(false);
      setAiGoal('');
      const nextId = await loadSprints(result.sprint.id);
      await refreshTasks(nextId);
    } catch (generationError) {
      setAiError(generationError.message || 'Could not generate the sprint. Please try again.');
    } finally {
      setAiBusy(false);
    }
  }

  const matches = (task) => {
    const haystack = `${task.key} ${task.title} ${task.description} ${task.assignee}`.toLowerCase();
    return haystack.includes(query.toLowerCase()) && (priority === 'all' || task.priority === priority);
  };

  const visibleSprintTasks = sprintTasks.filter((task) =>
    String(task.boardId || '') === String(activeBoardId) && matches(task)
  );
  const visibleBacklog = backlogTasks.filter((task) =>
    String(task.boardId || '') === String(activeBoardId) && matches(task)
  );
  const selectedIsActive = selected?.current?.state === 'active';
  const totals = selected?.progress ?? { totalStoryPoints: 0, completedStoryPoints: 0, remainingStoryPoints: 0, progressPercent: 0 };

  return <section className="sb-page">
    <div className="sb-context-strip">
      <div className="sb-crumbs"><span>{activeBoardName || 'Selected board'}</span><ChevronDown size={13} /><strong>Sprint Backlog</strong></div>
      <div className="sb-selector">
        <label className="sb-select"><Target size={14} /><select value={selectedId ?? ''} onChange={(event) => switchSprint(event.target.value)} disabled={sprints.length === 0}>
          {!selectedId && <option value="">{sprints.length ? 'No active sprint' : 'No sprints yet'}</option>}
          {sprints.map((sprint) => <option key={sprint.id} value={sprint.id}>{sprint.name}</option>)}
        </select><ChevronDown size={13} /></label>
        <button className="secondary-button" disabled={!activeBoardId} onClick={() => setEditing({ mode: 'create' })}><Plus size={15} /> Create Sprint</button>
        <button className="secondary-button" disabled={!activeBoardId} onClick={() => setAiPlannerOpen((open) => !open)}><Sparkles size={15} /> Generate with AI</button>
        <button className="secondary-button" disabled={!selected} onClick={() => setEditing({ mode: 'edit', sprint: selected })}><CalendarDays size={15} /> Edit Sprint</button>
      </div>
    </div>

    {error && <div className="sb-alert" role="alert"><AlertTriangle size={15} /><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss"><X size={14} /></button></div>}

    {loading && <div className="sb-loading">Loading sprint backlog...</div>}

    {aiPlannerOpen && !loading && <form className="sb-ai-planner" onSubmit={generateSprint}>
      <div className="sb-ai-planner-copy"><Sparkles size={18} /><div><strong>Plan a sprint with Copilot</strong><span>Describe the focus and Copilot will create a sprint with prioritized, skill-assigned tasks.</span></div></div>
      <div className="sb-ai-planner-controls">
        <input value={aiGoal} onChange={(event) => { setAiGoal(event.target.value); setAiError(''); }} maxLength={2000} required minLength={10} placeholder="e.g. Plan a 2-week sprint focusing on backend refactoring" aria-label="Sprint planning brief" disabled={aiBusy} />
        <button className="primary-button" type="submit" disabled={aiBusy || aiGoal.trim().length < 10}>{aiBusy ? <><RotateCcw size={14} /> Generating...</> : <><Sparkles size={14} /> Generate Sprint</>}</button>
      </div>
      {aiError && <p className="sb-ai-error" role="alert">{aiError}</p>}
    </form>}

    {!loading && !activeBoardId && <div className="sb-empty">
      <span className="sb-empty-icon"><Target size={22} /></span>
      <div className="eyebrow">Sprint planning</div>
      <h2>Choose a Board</h2>
      <p>Select a board from the workspace selector to view or create its sprints.</p>
    </div>}

    {!loading && activeBoardId && !selected && <div className="sb-empty">
      <span className="sb-empty-icon"><Target size={22} /></span>
      <div className="eyebrow">Sprint planning</div>
      <h2>No Active Sprint Found</h2>
      <p>Plan your first sprint from the product backlog or let LeadAI Copilot draft a prioritized sprint for your team.</p>
      <div className="sb-empty-actions">
        <button className="primary-button" disabled={!activeBoardId} onClick={() => setEditing({ mode: 'create' })}><Plus size={16} /> Create Sprint</button>
        <button className="secondary-button" disabled={!activeBoardId} onClick={() => setAiPlannerOpen(true)}><Sparkles size={15} /> Generate Sprint with AI</button>
      </div>
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
        const groupPoints = groupTasks.reduce((sum, task) => sum + safeStoryPoints(task.storyPoints), 0);
        return <section key={group.id} className="sb-group">
          <header className="sb-group-head">
            <div><span className={`sb-dot sb-dot-${group.id}`}></span><strong>{group.label}</strong><em>{group.hint}</em></div>
            <span className="sb-group-count">{groupTasks.length} issues · {groupPoints} SP</span>
          </header>
          {groupTasks.length === 0
            ? <div className="sb-empty-row">No issues in {group.label.toLowerCase()}</div>
            : <div className="sb-list">{groupTasks.map((task) => <SprintTaskRow key={task.key} task={task} busy={pendingKey === task.key} action="remove" onAction={removeFromSprint} onStoryPointsChange={(key, points) => runMutation(key, () => request(`/api/tasks/${key}?boardId=${encodeURIComponent(activeBoardId)}`, token, { method: 'PATCH', body: JSON.stringify({ storyPoints: points }) }))} disabled={task.status !== 'todo'} disabledReason="Only To Do tasks can return to the Product Backlog." />)}</div>}
        </section>;
      })}

      <ProductBacklogSection
        backlogTasks={backlogTasks}
        visibleBacklog={visibleBacklog}
        selected={selected}
        selectedIsActive={selectedIsActive}
        pendingKey={pendingKey}
        onCreateSprint={() => setEditing({ mode: 'create' })}
        onMove={moveToSprint}
        onStoryPointsChange={(key, points) => runMutation(key, () => request(`/api/tasks/${key}?boardId=${encodeURIComponent(activeBoardId)}`, token, { method: 'PATCH', body: JSON.stringify({ storyPoints: points }) }))}
      />
    </>}

    {!loading && !selected && <ProductBacklogSection
      backlogTasks={backlogTasks}
      visibleBacklog={visibleBacklog}
      selected={null}
      selectedIsActive={false}
      pendingKey={pendingKey}
      onCreateSprint={() => setEditing({ mode: 'create' })}
      onMove={moveToSprint}
      onStoryPointsChange={(key, points) => runMutation(key, () => request(`/api/tasks/${key}?boardId=${encodeURIComponent(activeBoardId)}`, token, { method: 'PATCH', body: JSON.stringify({ storyPoints: points }) }))}
    />}

    {editing && <SprintModal
      mode={editing.mode}
      sprint={editing.sprint}
      token={token}
      boardId={activeBoardId}
      backlogTasks={backlogTasks}
      onClose={() => setEditing(null)}
      onSaved={async (savedSprint) => {
        setEditing(null);
        const nextId = await loadSprints(savedSprint?.id || selectedId);
        await refreshTasks(nextId);
      }}
    />}
  </section>;
}

function ProductBacklogSection({ backlogTasks, visibleBacklog, selected, selectedIsActive, pendingKey, onCreateSprint, onMove, onStoryPointsChange }) {
  const backlogPoints = backlogTasks.reduce((sum, task) => sum + safeStoryPoints(task.storyPoints), 0);
  return <section className="sb-group sb-backlog">
    <header className="sb-group-head">
      <div><ChevronDown size={15} /><strong>Product Backlog</strong><em>Unscheduled work · priority first, then oldest</em></div>
      <span className="sb-group-count">{backlogTasks.length} issues · {backlogPoints} SP</span>
    </header>
    {!selectedIsActive && <div className="sb-backlog-note" role="status">
      <AlertTriangle size={14} />
      <span>{selected ? `"${selected.name}" is ${selected.current?.state === 'upcoming' ? 'upcoming' : 'completed'}. ` : ''}Select or create an active sprint before moving backlog items.</span>
      <button className="secondary-button" onClick={onCreateSprint}><Plus size={14} /> Create Sprint</button>
    </div>}
    {backlogTasks.length === 0
      ? <div className="sb-empty-row">No unscheduled tasks in the Product Backlog.</div>
      : visibleBacklog.length === 0
        ? <div className="sb-empty-row">No backlog tasks match these filters.</div>
        : <div className="sb-list">{visibleBacklog.map((task) => <SprintTaskRow key={task.key} task={task} busy={pendingKey === task.key} action="add" onAction={onMove} onStoryPointsChange={onStoryPointsChange} disabled={!selectedIsActive} disabledReason="Select or create an active sprint first." />)}</div>}
  </section>;
}

function SprintTaskRow({ task, busy, action, onAction, onStoryPointsChange, disabled = false, disabledReason = '' }) {
  const labels = Array.isArray(task.labels) ? task.labels : [];
  const priority = priorityLabels[task.priority] ? task.priority : 'medium';
  const points = safeStoryPoints(task.storyPoints);
  const pointOptions = validStoryPointSet.has(points) ? storyPointOptions : [...storyPointOptions, points].sort((a, b) => a - b);
  return <article className={`sb-row ${busy ? 'is-busy' : ''}`}>
    <span className="sb-row-key">#{task.key}</span>
    <div className="sb-row-main">
      <h3>{task.title}</h3>
      <div className="sb-row-tags">
        {labels.map((label) => <span key={label} className="sb-tag">{label}</span>)}
        <span className={`priority ${priorityClass[priority]}`}>{priorityLabels[priority]}</span>
        <select className="sb-points sb-points-select" aria-label={`Story points for ${task.key}`} value={points} disabled={busy} onChange={(event) => onStoryPointsChange(task.key, Number(event.target.value))}>
          {pointOptions.map((option) => <option key={option} value={option}>{option} SP{!validStoryPointSet.has(option) ? ' · Existing estimate' : ''}</option>)}
        </select>
      </div>
    </div>
    <span className="sb-row-assignee"><i>{initials(task.assignee)}</i>{task.assignee}</span>
    {action === 'add'
      ? <button className="secondary-button sb-action" disabled={busy || disabled} title={disabled ? disabledReason : undefined} onClick={() => onAction(task.key)}><ArrowRight size={14} /> Move to Sprint</button>
      : <button className="secondary-button sb-action" disabled={busy || disabled} title={disabled ? disabledReason : undefined} onClick={() => onAction(task.key)}><ArrowLeft size={14} /> Return to Backlog</button>}
  </article>;
}

function SprintModal({ mode, sprint, token, boardId, backlogTasks = [], onClose, onSaved }) {
  const today = new Date();
  const initialStart = sprint?.startDate ?? `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const initialEnd = sprint?.endDate ?? endDateForStart(initialStart);
  const [name, setName] = useState(sprint?.name ?? '');
  const [goal, setGoal] = useState(sprint?.goal ?? '');
  const [startDate, setStartDate] = useState(initialStart);
  const [endDate, setEndDate] = useState(initialEnd);
  const [selectedTaskKeys, setSelectedTaskKeys] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const range = formatDateRange(startDate, endDate);
  const selectableTasks = backlogTasks.filter((task) => !boardId || String(task.boardId || '') === String(boardId));
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const sprintStartsToday = todayIso === startDate;

  async function submit(event) {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      const savedSprint = await request(mode === 'create' ? '/api/sprints' : `/api/sprints/${sprint.id}?boardId=${encodeURIComponent(boardId)}`, token, {
        method: mode === 'create' ? 'POST' : 'PATCH',
        body: JSON.stringify({
          name, goal, startDate, endDate,
          ...(mode === 'create' ? {
            ...(boardId ? { boardId } : {}),
            taskKeys: selectedTaskKeys
          } : {})
        })
      });
      await onSaved(savedSprint);
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
        <label>Start date<input type="date" value={startDate} onChange={(event) => {
          setStartDate(event.target.value);
          if (event.target.value && isCalendarDate(event.target.value)) setEndDate(endDateForStart(event.target.value));
          if (event.target.value !== todayIso) setSelectedTaskKeys([]);
        }} required /></label>
        <label>End date<input type="date" min={startDate || undefined} value={endDate} onChange={(event) => setEndDate(event.target.value)} required /></label>
      </div>
      {mode === 'create' && <fieldset className="sb-backlog-picker" disabled={!sprintStartsToday || saving}>
        <legend>Product Backlog tasks <span>{selectedTaskKeys.length} selected</span></legend>
        {!sprintStartsToday && <p>Backlog tasks can be added when the sprint starts today. You can move them from the backlog later.</p>}
        {sprintStartsToday && !selectableTasks.length && <p>No Product Backlog tasks are available for this board.</p>}
        {sprintStartsToday && selectableTasks.length > 0 && <div className="sb-backlog-picker-list">
          {selectableTasks.map((task) => {
            const checked = selectedTaskKeys.includes(task.key);
            return <label key={task.key}>
              <input
                type="checkbox"
                checked={checked}
                disabled={!checked && selectedTaskKeys.length >= 100}
                onChange={() => setSelectedTaskKeys((current) => checked ? current.filter((key) => key !== task.key) : [...current, task.key])}
              />
              <span><strong>{task.key}</strong> {task.title}</span>
              <small>{task.storyPoints || 0} SP</small>
            </label>;
          })}
        </div>}
      </fieldset>}
      <p className="sb-modal-note">
        {isCalendarDate(startDate) && isCalendarDate(endDate)
          ? <><Check size={13} /> {range} · {Math.round((new Date(`${endDate}T00:00:00Z`) - new Date(`${startDate}T00:00:00Z`)) / 86400000) + 1} days.</>
          : <><AlertTriangle size={13} /> Pick valid start and end dates. New sprints default to {SPRINT_DURATION_DAYS} days.</>}
      </p>
      <div className="modal-actions">
        <button type="button" className="secondary-button" onClick={onClose}>Cancel</button>
        <button type="submit" className="primary-button" disabled={saving}>{saving ? <><RotateCcw size={15} /> Saving...</> : mode === 'create' ? <><Plus size={15} /> Create sprint</> : <><Check size={15} /> Save changes</>}</button>
      </div>
    </form>
  </div>;
}