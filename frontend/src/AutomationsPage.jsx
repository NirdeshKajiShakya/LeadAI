import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle, BellRing, LoaderCircle, Play, Settings2, Sparkles, Users
} from 'lucide-react';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '';

const RULES = [
  {
    id: 'taskAssignmentNotification',
    title: 'Task assignment notification',
    trigger: 'When a task is assigned to a board member.',
    action: 'Send the assignee an in-app notification.',
    icon: BellRing,
    category: 'Notifications'
  },
  {
    id: 'taskReviewAlert',
    title: 'Task review alert',
    trigger: 'When a task moves into In Review / QA.',
    action: 'Notify the board owner and task creator.',
    icon: BellRing,
    category: 'Notifications'
  },
  {
    id: 'smartMemberReassignment',
    title: 'Smart member departure reassignment',
    trigger: 'When a member is removed from this board.',
    action: 'Match open tasks against active members’ listed skills, distribute unmatched tasks, and add an audit note.',
    icon: Users,
    category: 'AI workflow'
  },
  {
    id: 'overduePriorityEscalation',
    title: 'Overdue task priority escalation',
    trigger: 'When an unfinished task passes its due date.',
    action: 'Raise its priority to High and flag it in red.',
    icon: AlertTriangle,
    category: 'Task management'
  },
  {
    id: 'sprintKickoffBroadcast',
    title: 'Sprint kickoff broadcast',
    trigger: 'When a sprint is created and started.',
    action: 'Broadcast the sprint goal and timeline to board members.',
    icon: Play,
    category: 'Notifications'
  }
];

const DEFAULT_RULES = {
  taskAssignmentNotification: true,
  taskReviewAlert: true,
  smartMemberReassignment: false,
  overduePriorityEscalation: true,
  sprintKickoffBroadcast: true
};

export default function AutomationsPage({ token, activeBoardId, activeBoard }) {
  const [rules, setRules] = useState(DEFAULT_RULES);
  const [loading, setLoading] = useState(false);
  const [savingRule, setSavingRule] = useState('');
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
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.error || `Automation request failed (${response.status}).`);
    return payload;
  }, [token]);

  useEffect(() => {
    if (!activeBoardId) {
      setRules(DEFAULT_RULES);
      return undefined;
    }
    let active = true;
    setLoading(true);
    setError('');
    request(`/api/automations?boardId=${encodeURIComponent(activeBoardId)}`)
      .then((payload) => {
        if (active) setRules({ ...DEFAULT_RULES, ...(payload.rules || {}) });
      })
      .catch((loadError) => {
        if (active) setError(loadError.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [request, activeBoardId]);

  async function toggleRule(ruleId) {
    if (!activeBoardId || savingRule) return;
    const previous = rules[ruleId];
    const next = !previous;
    setRules((current) => ({ ...current, [ruleId]: next }));
    setSavingRule(ruleId);
    setError('');
    try {
      const payload = await request('/api/automations', {
        method: 'PATCH',
        body: JSON.stringify({ boardId: activeBoardId, rules: { [ruleId]: next } })
      });
      setRules({ ...DEFAULT_RULES, ...(payload.rules || {}) });
    } catch (saveError) {
      setRules((current) => ({ ...current, [ruleId]: previous }));
      setError(saveError.message);
    } finally {
      setSavingRule('');
    }
  }

  const enabledCount = RULES.filter((rule) => rules[rule.id]).length;
  const canManage = Boolean(activeBoard?.isOwner);

  return (
    <section className="route-page automation-page">
      <header className="automation-header">
        <div>
          <div className="eyebrow"><Sparkles size={13} /> Workflow controls</div>
          <h1>Automations</h1>
          <p>Choose which routine board actions LeadAI handles for you.</p>
        </div>
        <div className="automation-header-status">
          <span className="automation-status-pill"><i /> {enabledCount} of {RULES.length} active</span>
          <span className="automation-board-name">{activeBoard?.name || 'No board selected'}</span>
        </div>
      </header>

      {error && <div className="form-error" role="alert">{error}</div>}
      {!activeBoardId ? (
        <div className="automation-empty"><Settings2 size={22} /><strong>Select a board to configure rules.</strong></div>
      ) : loading ? (
        <div className="automation-empty"><LoaderCircle className="spin" size={20} /><span>Loading automation rules…</span></div>
      ) : (
        <>
          {!canManage && <div className="automation-notice" role="status">Only the board owner can change automation rules. You can still review the current setup.</div>}
          <div className="automation-list">
            {RULES.map((rule) => {
              const Icon = rule.icon;
              const enabled = Boolean(rules[rule.id]);
              const saving = savingRule === rule.id;
              return (
                <article className={`automation-card${enabled ? ' is-enabled' : ''}`} key={rule.id}>
                  <div className="automation-card-icon"><Icon size={17} /></div>
                  <div className="automation-card-copy">
                    <div className="automation-card-heading">
                      <h2>{rule.title}</h2>
                      <span className="automation-category">{rule.category}</span>
                      {saving && <LoaderCircle size={13} className="spin" aria-label="Saving rule" />}
                    </div>
                    <p><b>Trigger</b> {rule.trigger}</p>
                    <p><b>Action</b> {rule.action}</p>
                  </div>
                  <button
                    type="button"
                    className={`automation-toggle${enabled ? ' is-on' : ''}`}
                    role="switch"
                    aria-checked={enabled}
                    aria-label={`${enabled ? 'Disable' : 'Enable'} ${rule.title}`}
                    disabled={!canManage || saving || loading}
                    onClick={() => toggleRule(rule.id)}
                  >
                    <span />
                  </button>
                </article>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}
