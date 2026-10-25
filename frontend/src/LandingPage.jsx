import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, ChevronRight, CircleDot, Sparkles } from 'lucide-react';

const COLUMNS = [
  { id: 'backlog', label: 'Backlog', tone: 'slate' },
  { id: 'todo', label: 'To Do', tone: 'cyan' },
  { id: 'progress', label: 'In Progress', tone: 'violet' },
  { id: 'review', label: 'In Review / QA', tone: 'blue' },
  { id: 'done', label: 'Done', tone: 'green' }
];

const HERO_TASKS = [
  { key: 'KAN-18', title: 'Map onboarding copy to the new flow', label: 'Content', priority: 'P1', assignee: 'AM', status: 'todo' },
  { key: 'KAN-21', title: 'Wire workspace settings to the API', label: 'Backend', priority: 'P1', assignee: 'RS', status: 'progress' },
  { key: 'KAN-24', title: 'Check keyboard order in the board drawer', label: 'Accessibility', priority: 'P2', assignee: 'JT', status: 'progress' },
  { key: 'KAN-16', title: 'Sprint 14 scope agreed with the team', label: 'Planning', priority: 'P2', assignee: 'AM', status: 'done' },
  { key: 'KAN-27', title: 'Draft the release checklist', label: 'Process', priority: 'P3', assignee: 'RS', status: 'backlog' },
  { key: 'KAN-12', title: 'Review the attachment limits', label: 'Security', priority: 'P2', assignee: 'JT', status: 'review' }
];

const DEMO_START = [
  { id: 'demo-1', title: 'Draft the launch checklist', label: 'Release', priority: 'P1', status: 'todo' },
  { id: 'demo-2', title: 'Match onboarding tasks to skills', label: 'Planning', priority: 'P2', status: 'progress' },
  { id: 'demo-3', title: 'Verify the empty board state', label: 'QA', priority: 'P2', status: 'review' }
];

function Wordmark() {
  return (
    <span className="lp-brand">
      <span className="logo-mark" aria-hidden="true"><span></span><span></span><span></span></span>
      <span>LeadAI</span>
    </span>
  );
}

function TaskCard({ task, compact = false }) {
  return (
    <article className={`lp-task ${compact ? 'is-compact' : ''}`}>
      <div className="lp-task-top">
        <span className="lp-task-key">{task.key || 'KAN'}</span>
        <span className={`lp-priority is-${String(task.priority).toLowerCase().replace('p1', 'high').replace('p2', 'medium').replace('p3', 'low')}`}>{task.priority}</span>
      </div>
      <h3>{task.title}</h3>
      <div className="lp-task-foot">
        <span className="lp-tag">{task.label}</span>
        <span className="lp-avatar" aria-hidden="true">{task.assignee || '—'}</span>
      </div>
    </article>
  );
}

function BoardPreview() {
  return (
    <div className="lp-board" data-ui>
      <div className="lp-board-head">
        <div>
          <span className="lp-board-kicker">Workspace</span>
          <strong>Product launch</strong>
        </div>
        <div className="lp-board-meta">
          <span className="lp-status-dot" /> Sprint 14 · Day 6 of 10
        </div>
      </div>
      <div className="lp-board-columns">
        {COLUMNS.map((column) => {
          const cards = HERO_TASKS.filter((task) => task.status === column.id);
          return (
            <section className={`lp-column tone-${column.tone}`} key={column.id}>
              <header>
                <span className="lp-column-dot" />
                <span>{column.label}</span>
                <span className="lp-column-count">{cards.length}</span>
              </header>
              <div className="lp-column-cards">
                {cards.map((task) => <TaskCard task={task} compact key={task.key} />)}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function PlanFragment() {
  return (
    <div className="lp-fragment lp-plan" data-ui>
      <label htmlFor="lp-goal-demo">Project goal</label>
      <div className="lp-goal-row">
        <span id="lp-goal-demo">Launch the customer portal with a guided onboarding flow.</span>
        <Sparkles size={15} aria-hidden="true" />
      </div>
      <div className="lp-plan-result">
        <span className="lp-plan-badge">7 backlog tasks</span>
        <ul>
          <li><Check size={13} /> Map the onboarding journey</li>
          <li><Check size={13} /> Build the account screens</li>
          <li><Check size={13} /> Assign owners by skill</li>
        </ul>
      </div>
    </div>
  );
}

function SprintFragment() {
  return (
    <div className="lp-fragment lp-sprint" data-ui>
      <div className="lp-sprint-head">
        <div>
          <span className="lp-board-kicker">Sprint 14</span>
          <strong>Portal foundations</strong>
        </div>
        <span className="lp-sprint-days">6 / 10</span>
      </div>
      <div className="lp-progress" role="img" aria-label="Sprint progress: 62 percent">
        <span style={{ width: '62%' }} />
      </div>
      <div className="lp-sprint-stats">
        <div><span>Tasks</span><strong>18</strong></div>
        <div><span>Done</span><strong>11</strong></div>
        <div><span>In review</span><strong>3</strong></div>
        <div><span>Points</span><strong>34</strong></div>
      </div>
    </div>
  );
}

function HistoryFragment() {
  return (
    <div className="lp-fragment lp-history" data-ui>
      {[
        ['AM', 'Moved KAN-24 to In Review', '2 min ago'],
        ['RS', 'Assigned KAN-21 to Rhea', '14 min ago'],
        ['JT', 'Added label Accessibility', '1 hr ago'],
        ['AM', 'Completed KAN-16', 'Yesterday']
      ].map(([who, action, when]) => (
        <div className="lp-history-row" key={action}>
          <span className="lp-avatar" aria-hidden="true">{who}</span>
          <span>{action}</span>
          <time>{when}</time>
        </div>
      ))}
    </div>
  );
}

function TaskDetailFragment() {
  return (
    <div className="lp-fragment lp-detail" data-ui>
      <div className="lp-detail-head">
        <span className="lp-task-key">KAN-21</span>
        <span className="lp-priority is-high">P1</span>
      </div>
      <h4>Wire workspace settings to the API</h4>
      <div className="lp-detail-tags">
        <span className="lp-tag">Backend</span>
        <span className="lp-tag">API</span>
        <span className="lp-tag is-outline">+ 2</span>
      </div>
      <div className="lp-check-row"><Check size={13} /> Validation stays on the server</div>
      <div className="lp-check-row is-open"><CircleDot size={13} /> Attach the migration note</div>
      <div className="lp-comment">
        <span className="lp-avatar" aria-hidden="true">RS</span>
        <p>Settings now return the model name but never the key.</p>
      </div>
    </div>
  );
}

function SkillFragment() {
  return (
    <div className="lp-fragment lp-skills" data-ui>
      {[
        ['Rhea S.', ['React', 'Node', 'MongoDB'], 'KAN-21'],
        ['Aarav M.', ['UX', 'Research', 'Copy'], 'KAN-18'],
        ['Jia T.', ['QA', 'Accessibility'], 'KAN-24']
      ].map(([name, skills, task]) => (
        <div className="lp-skill-row" key={name}>
          <span className="lp-avatar" aria-hidden="true">{name.split(' ').map((part) => part[0]).join('')}</span>
          <div>
            <strong>{name}</strong>
            <span>{skills.join(' · ')}</span>
          </div>
          <span className="lp-skill-task">{task}</span>
        </div>
      ))}
    </div>
  );
}

function SecurityFragment() {
  return (
    <div className="lp-fragment lp-security" data-ui>
      <div className="lp-code-label">Email confirmation</div>
      <div className="lp-code" aria-label="Six digit code example">
        <span>4</span><span>8</span><span>2</span><span>9</span><span>1</span><span>6</span>
      </div>
      <div className="lp-security-note"><Check size={13} /> Expires in 10 minutes · one use only</div>
      <div className="lp-security-note"><Check size={13} /> A new code replaces the old one</div>
      <div className="lp-security-note"><Check size={13} /> No session until it is confirmed</div>
    </div>
  );
}

function TeamFragment() {
  return (
    <div className="lp-fragment lp-team" data-ui>
      <div className="lp-team-head">
        <span className="lp-board-kicker">Launch board</span>
        <span className="lp-team-count">4 members</span>
      </div>
      {[
        ['Aarav M.', 'Owner', 'Everything on this board'],
        ['Rhea S.', 'Member', 'Tasks, comments, Copilot'],
        ['Jia T.', 'Member', 'Tasks, comments, Copilot'],
        ['Sam K.', 'Member', 'Tasks, comments, Copilot']
      ].map(([name, role, scope]) => (
        <div className="lp-skill-row" key={name}>
          <span className="lp-avatar" aria-hidden="true">{name.split(' ').map((part) => part[0]).join('')}</span>
          <div>
            <strong>{name}</strong>
            <span>{scope}</span>
          </div>
          <span className={`lp-role ${role === 'Owner' ? 'is-owner' : ''}`}>{role}</span>
        </div>
      ))}
    </div>
  );
}

function LiveBoard() {
  const [tasks, setTasks] = useState(DEMO_START);
  // The preview only renders these three stages; keep moves inside them so a
  // card can never disappear into a column that is not on screen.
  const FIRST_STAGE = 1;
  const LAST_STAGE = 3;

  function move(id, direction) {
    setTasks((current) => current.map((task) => {
      if (task.id !== id) return task;
      const index = COLUMNS.findIndex((column) => column.id === task.status);
      const next = Math.min(LAST_STAGE, Math.max(FIRST_STAGE, index + direction));
      return { ...task, status: COLUMNS[next].id };
    }));
  }

  return (
    <div className="lp-live" data-ui>
      <div className="lp-live-head">
        <span>Interactive preview</span>
        <span>Local demo · no account needed</span>
      </div>
      <div className="lp-live-columns">
        {COLUMNS.slice(1, 4).map((column) => {
          const cards = tasks.filter((task) => task.status === column.id);
          return (
            <section className={`lp-live-column tone-${column.tone}`} key={column.id}>
              <header><span className="lp-column-dot" />{column.label}<span className="lp-column-count">{cards.length}</span></header>
              {cards.map((task) => {
                const atStart = task.status === 'todo';
                const atEnd = task.status === 'review';
                return (
                  <article className="lp-live-card" key={task.id}>
                    <span className="lp-task-key">{task.label}</span>
                    <h4>{task.title}</h4>
                    <div className="lp-live-actions">
                      <button
                        type="button"
                        onClick={() => move(task.id, -1)}
                        disabled={atStart}
                        aria-label={`Move ${task.title} back a stage`}
                      >
                        <ArrowLeft size={13} />
                      </button>
                      <button
                        type="button"
                        onClick={() => move(task.id, 1)}
                        disabled={atEnd}
                        aria-label={`Move ${task.title} forward a stage`}
                      >
                        <ArrowRight size={13} />
                      </button>
                    </div>
                  </article>
                );
              })}
              {!cards.length && <p className="lp-live-empty">Nothing in this stage.</p>}
            </section>
          );
        })}
      </div>
      <p className="lp-live-hint">Move a card with the arrow buttons. This preview stays in your browser.</p>
    </div>
  );
}

export default function LandingPage({ onSignIn, onGetStarted }) {
  const pageRef = useRef(null);

  useEffect(() => {
    const sections = pageRef.current?.querySelectorAll('.lp-reveal');
    if (!sections?.length) return undefined;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      sections.forEach((section) => section.classList.add('is-visible'));
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.18, rootMargin: '0px 0px -8% 0px' });
    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, []);

  return (
    <div className="lp" ref={pageRef}>
      <header className="lp-nav">
        <a href="#top" className="lp-nav-brand" aria-label="LeadAI home"><Wordmark /></a>
        <nav aria-label="Product sections">
          <a href="#board">Board</a>
          <a href="#planning">Planning</a>
          <a href="#team">Team</a>
          <a href="#security">Access</a>
        </nav>
        <div className="lp-nav-actions">
          <button type="button" className="lp-text-link" onClick={onSignIn}>Sign in</button>
          <button type="button" className="lp-button lp-button-small" onClick={onGetStarted}>Create account</button>
        </div>
      </header>

      <main id="top">
        <section className="lp-hero" aria-labelledby="lp-hero-title">
          <div className="lp-hero-copy">
            <h1 id="lp-hero-title">
              <span className="lp-line"><span>The board your team</span></span>
              <span className="lp-line"><span>actually works from.</span></span>
            </h1>
            <p>
              LeadAI turns a project goal into a Kanban board, matches the work to the skills on your team,
              and keeps every sprint, task, and decision in one place.
            </p>
            <div className="lp-hero-actions">
              <button type="button" className="lp-button" onClick={onGetStarted}>
                Create your workspace <ArrowRight size={16} />
              </button>
              <button type="button" className="lp-text-link" onClick={onSignIn}>
                Sign in to an existing board
              </button>
            </div>
          </div>
          <div className="lp-hero-stage">
            <BoardPreview />
          </div>
        </section>

        <section className="lp-section lp-mosaic" id="board" aria-labelledby="lp-board-title">
          <div className="lp-section-head lp-reveal">
            <h2 id="lp-board-title">Work moves. The board keeps up.</h2>
            <p>Five columns, real dependencies, and a record of what changed.</p>
          </div>
          <div className="lp-mosaic-grid">
            <article className="lp-cell lp-cell-wide lp-reveal">
              <div className="lp-cell-copy">
                <h3>Tasks with enough context to start</h3>
                <p>Descriptions, labels, priorities, due dates, comments, attachments, and blockers live on the task, not in a message thread.</p>
              </div>
              <TaskDetailFragment />
            </article>
            <article className="lp-cell lp-reveal">
              <div className="lp-cell-copy">
                <h3>Skills decide the owner</h3>
                <p>List what each member can do. LeadAI uses those skills when it proposes assignments.</p>
              </div>
              <SkillFragment />
            </article>
            <article className="lp-cell lp-reveal">
              <div className="lp-cell-copy">
                <h3>Every change leaves a trace</h3>
                <p>Status moves, assignments, and comments are recorded per task, so the history is not a guess.</p>
              </div>
              <HistoryFragment />
            </article>
            <article className="lp-cell lp-cell-wide lp-reveal">
              <div className="lp-cell-copy">
                <h3>Sprints with a real finish line</h3>
                <p>Plan a dated sprint, pull work from the backlog, and watch the dashboard read the live board rather than a separate report.</p>
              </div>
              <SprintFragment />
            </article>
          </div>
        </section>

        <section className="lp-section lp-planning-section" id="planning" aria-labelledby="lp-plan-title">
          <div className="lp-split lp-reveal">
            <div className="lp-split-copy">
              <h2 id="lp-plan-title">Describe the outcome. Get a plan.</h2>
              <p>
                Write the goal in plain language. LeadAI proposes implementation-sized backlog tasks with
                descriptions, priorities, and dates. You review the plan before anything is created.
              </p>
              <ul className="lp-list">
                <li><Check size={15} /> Up to 20 tasks per generated board</li>
                <li><Check size={15} /> Every task starts in the backlog for your review</li>
                <li><Check size={15} /> Copilot edits are validated by the server before they apply</li>
              </ul>
            </div>
            <PlanFragment />
          </div>
        </section>

        <section className="lp-section lp-live-section" aria-labelledby="lp-live-title">
          <div className="lp-section-head lp-reveal">
            <h2 id="lp-live-title">Try the board before you sign up.</h2>
            <p>This is a local preview of the five-stage flow. Nothing is sent to the server.</p>
          </div>
          <div className="lp-reveal"><LiveBoard /></div>
        </section>

        <section className="lp-section lp-team-section" id="team" aria-labelledby="lp-team-title">
          <div className="lp-split lp-split-reverse lp-reveal">
            <div className="lp-split-copy">
              <h2 id="lp-team-title">A workspace, not a shared password.</h2>
              <p>
                Board owners invite members. Members own their work. Profiles carry the skills the planner
                uses, and the dashboard only shows data from boards you can access.
              </p>
              <ul className="lp-list">
                <li><Check size={15} /> Owner and member roles with server-side checks</li>
                <li><Check size={15} /> Board memberships enforced on every task call</li>
                <li><Check size={15} /> Profile, skills, and avatar editable after signup</li>
              </ul>
            </div>
            <TeamFragment />
          </div>
        </section>

        <section className="lp-section lp-access-section" id="security" aria-labelledby="lp-access-title">
          <div className="lp-split lp-reveal">
            <div className="lp-split-copy">
              <h2 id="lp-access-title">Sign-in that closes the easy doors.</h2>
              <p>
                New accounts confirm an email code before a session exists. Unrecognised browsers ask for a
                second code. Password resets revoke every session and trusted browser.
              </p>
              <ul className="lp-list">
                <li><Check size={15} /> Codes are hashed, single-use, and expire</li>
                <li><Check size={15} /> Five wrong attempts invalidate a code</li>
                <li><Check size={15} /> AI keys stay on the server, never in the bundle</li>
              </ul>
            </div>
            <SecurityFragment />
          </div>
        </section>

        <section className="lp-section lp-close" aria-labelledby="lp-close-title">
          <div className="lp-close-inner lp-reveal">
            <h2 id="lp-close-title">Bring the work. Shape the board.</h2>
            <p>Start with the starter board, or describe a goal and let the planner draft the backlog.</p>
            <button type="button" className="lp-button" onClick={onGetStarted}>
              Create your workspace <ChevronRight size={16} />
            </button>
          </div>
        </section>
      </main>

      <footer className="lp-footer">
        <span><Wordmark /> — AI-assisted Kanban and sprint planning.</span>
        <nav aria-label="Footer">
          <a href="#board">Board</a>
          <a href="#planning">Planning</a>
          <a href="#security">Access</a>
          <button type="button" className="lp-text-link" onClick={onSignIn}>Sign in</button>
        </nav>
        <span>Built with React, Express, and MongoDB.</span>
      </footer>
    </div>
  );
}
