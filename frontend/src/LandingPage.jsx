import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUpRight, Bot, CalendarDays, Check,
  CheckCircle2, ChevronLeft, ChevronRight, Circle, Clock3, Command, GitBranch,
  Grip, Layers3, ListTodo, LockKeyhole, MoveRight, Play, Plus, Sparkles,
  Target, Users, WandSparkles, Zap
} from 'lucide-react';
import './landing.css';

const initialCards = [
  { id: 'design', title: 'Polish onboarding flow', tag: 'Product', priority: 'High', lane: 0, due: 'Today', assignee: 'AM', color: 'violet' },
  { id: 'api', title: 'Add workspace API', tag: 'Engineering', priority: 'Medium', lane: 0, due: 'Oct 28', assignee: 'JL', color: 'blue' },
  { id: 'research', title: 'Review user interviews', tag: 'Research', priority: 'Low', lane: 1, due: 'Oct 29', assignee: 'SK', color: 'green' },
  { id: 'deploy', title: 'Ship sprint 08', tag: 'Release', priority: 'High', lane: 2, due: 'Done', assignee: 'AM', color: 'orange' }
];
const lanes = ['TO DO', 'IN REVIEW', 'DONE'];

function Brand({ light = false }) {
  return <span className={`lp-brand ${light ? 'is-light' : ''}`}><span className="lp-brand-icon"><i /><i /><i /></span>LeadAI</span>;
}

export default function LandingPage({ onAuth }) {
  const [cards, setCards] = useState(initialCards);
  const [dragging, setDragging] = useState(null);

  function moveCard(id, lane) {
    setCards((current) => current.map((card) => card.id === id ? { ...card, lane: Math.max(0, Math.min(lanes.length - 1, lane)) } : card));
  }

  function shiftCard(id, direction) {
    const card = cards.find((item) => item.id === id);
    if (card) moveCard(id, card.lane + direction);
  }

  return <main className="landing-page">
    <header className="lp-nav">
      <a className="lp-home-link" href="#top" aria-label="LeadAI home"><Brand /></a>
      <nav className="lp-nav-links" aria-label="Main navigation">
        <a href="#board">Board</a><a href="#planning">Planning</a><a href="#teams">Teams</a><a href="#access">Access</a>
      </nav>
      <div className="lp-nav-actions">
        <button className="lp-signin" onClick={() => onAuth('signin')}>Sign in</button>
        <button className="lp-nav-cta" onClick={() => onAuth('signup')}>Create account <ArrowRight size={15} /></button>
      </div>
    </header>

    <section className="lp-hero" id="top">
      <motion.div className="lp-hero-copy" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .65 }}>
        <div className="lp-eyebrow"><span className="lp-spark"><Sparkles size={13} /></span> AI-POWERED DELIVERY</div>
        <h1>The board your team <span>actually works from.</span></h1>
        <p className="lp-hero-description">Turn plans into momentum. LeadAI brings your MERN-powered workspace, automated Kanban planning, and skill-based assignments together in one clear view.</p>
        <div className="lp-hero-actions">
          <button className="lp-primary" onClick={() => onAuth('signup')}>Create your workspace <ArrowRight className="lp-cta-arrow" size={17} /></button>
          <a className="lp-secondary" href="#access"><span><Play size={13} fill="currentColor" /></span> Explore the board</a>
        </div>
        <div className="lp-hero-proof"><div className="lp-proof-avatars"><b>AM</b><b>JL</b><b>SK</b><b>+4</b></div><span><strong>One shared source of truth.</strong><br />Built for teams that ship together.</span></div>
      </motion.div>
      <div className="lp-hero-board-anchor" id="board"><motion.div className="lp-hero-board-wrap" initial={{ opacity: 0, y: 26, scale: .98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: .75, delay: .12 }}>
        <div className="lp-glow lp-glow-blue" /><div className="lp-glow lp-glow-purple" />
        <div className="lp-product-window">
          <div className="lp-window-top"><div className="lp-window-dots"><i /><i /><i /></div><span className="lp-window-breadcrumb">Workspace <b>/</b> Launch sprint</span><span className="lp-window-live"><i /> LIVE</span></div>
          <div className="lp-board-toolbar"><div><span className="lp-project-icon"><Layers3 size={15} /></span><div><strong>Launch sprint</strong><small>Product team · Sprint 08</small></div></div><div className="lp-mini-avatars"><b>AM</b><b>JL</b><b>SK</b><span><Plus size={12} /></span></div></div>
          <div className="lp-mini-columns">
            {[
              { name: 'Backlog', count: '4', color: 'gray', items: [['Define onboarding goals', 'Product', 'AM'], ['Map user journey', 'Research', 'SK']] },
              { name: 'In Progress', count: '3', color: 'blue', items: [['Build welcome screen', 'Engineering', 'JL'], ['Review API contract', 'Platform', 'AM']] },
              { name: 'Done', count: '6', color: 'green', items: [['Set up project repo', 'Engineering', 'JL'], ['Sprint kickoff', 'Team', 'SK']] }
            ].map((column) => <div className="lp-mini-column" key={column.name}>
              <div className="lp-mini-column-title"><i className={`lp-dot ${column.color}`} />{column.name}<span>{column.count}</span></div>
              {column.items.map(([title, tag, person], index) => <div className="lp-mini-task" key={title}><div className="lp-task-top"><span className={`lp-task-priority p${index}`}>{index === 1 ? 'P2' : 'P1'}</span><Grip size={12} /></div><strong>{title}</strong><div className="lp-task-footer"><span>{tag}</span><b className={`lp-person person-${person.toLowerCase()}`}>{person}</b></div></div>)}
            </div>)}
          </div>
          <div className="lp-window-foot"><span><span className="lp-activity-dot" /> Copilot is keeping the plan in sync</span><span>Updated just now</span></div>
        </div>
        <div className="lp-floating-note"><span><WandSparkles size={14} /></span><div><strong>Plan, meet progress.</strong><small>3 tasks matched to team skills</small></div><CheckCircle2 size={16} /></div>
      </motion.div></div>
      <a className="lp-scroll-cue" href="#planning"><ArrowDown size={14} /> A clearer way to work</a>
    </section>

    <section className="lp-trust-strip" aria-label="LeadAI platform benefits">
      <span>ONE PLACE FOR THE WORK THAT MATTERS</span><div><b><Check size={14} /> Clear ownership</b><b><Check size={14} /> AI-assisted planning</b><b><Check size={14} /> Progress you can trust</b></div>
    </section>

    <section className="lp-features lp-section" id="planning">
      <motion.div className="lp-section-heading" initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: .35 }} transition={{ duration: .5 }}>
        <span className="lp-eyebrow"><span className="lp-eyebrow-mark" /> MADE FOR THE MOMENTUM</span>
        <h2>Work moves.<br /><span>The board keeps up.</span></h2>
        <p>All the context your team needs, right where the work happens.</p>
      </motion.div>
      <div className="lp-feature-grid">
        <FeatureCard className="feature-context" icon={<ListTodo size={18} />} color="blue" index={0} title="Tasks with context to start" description="Priorities, due dates, and useful tags make the next move obvious." footer="No more guessing what matters." >
          <div className="lp-context-preview"><div className="lp-context-heading"><span className="lp-checkbox"><Check size={11} /></span><strong>Prepare launch checklist</strong><ArrowUpRight size={14} /></div><div className="lp-context-tags"><span className="tag-priority">P1 · HIGH</span><span className="tag-date"><CalendarDays size={11} /> Oct 28</span><span className="tag-label">Launch</span></div><div className="lp-context-line" /></div>
        </FeatureCard>
        <FeatureCard className="feature-matching" icon={<Target size={18} />} color="purple" index={1} title="Skill-based matching" description="The right work finds the right people, based on the skills they bring." footer="Better balance, built in.">
          <div className="lp-match-preview"><div className="lp-match-label">BEST MATCH FOR <span>API INTEGRATION</span></div><div className="lp-match-person"><span className="lp-match-avatar">JL</span><div><strong>Jordan Lee</strong><small>Backend · TypeScript · APIs</small></div><span className="lp-match-score">96%<small>match</small></span></div><div className="lp-match-meter"><i /></div></div>
        </FeatureCard>
        <FeatureCard className="feature-history" icon={<GitBranch size={18} />} color="green" index={2} title="Every change leaves a trace" description="See what moved, when it moved, and who made it happen." footer="A complete picture, automatically.">
          <div className="lp-history-preview"><div className="lp-history-line"><span className="history-icon blue"><MoveRight size={12} /></span><p><strong>Jordan Lee</strong> moved <b>API integration</b><small>In progress <ArrowRight size={10} /> In review</small></p><time>2m ago</time></div><div className="lp-history-line"><span className="history-icon green"><Check size={12} /></span><p><strong>Alex Morgan</strong> completed <b>Design review</b><small>All acceptance criteria met</small></p><time>18m ago</time></div></div>
        </FeatureCard>
        <FeatureCard className="feature-sprint" icon={<Zap size={18} />} color="orange" index={3} title="Sprints with a real finish line" description="Turn a busy backlog into a focused plan your team can finish." footer="See your next milestone clearly.">
          <div className="lp-sprint-preview"><div className="lp-sprint-label"><span>SPRINT 08</span><span>6 DAYS LEFT</span></div><div className="lp-sprint-count"><strong>18 <small>/ 24</small></strong><span>tasks completed</span></div><div className="lp-sprint-meter"><i /></div><div className="lp-sprint-bottom"><span><i className="lp-dot green" /> 18 complete</span><span><i className="lp-dot gray" /> 6 open</span><span>75%</span></div></div>
        </FeatureCard>
      </div>
    </section>

    <section className="lp-teams" id="teams">
      <motion.div className="lp-teams-inner" initial={{ opacity: 0, y: 22 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: .3 }} transition={{ duration: .55 }}>
        <div className="lp-team-copy"><span className="lp-eyebrow"><span className="lp-eyebrow-mark" /> MORE FLOW, LESS FOLLOW-UP</span><h2>One team.<br /><span>One clear direction.</span></h2><p>When the plan, people, and progress live together, your team spends less time chasing updates—and more time making things happen.</p><button onClick={() => onAuth('signup')} className="lp-text-link">Bring your team together <ArrowRight size={15} /></button></div>
        <div className="lp-team-visual"><div className="lp-team-grid-lines" /><div className="lp-team-card"><div className="lp-team-card-head"><span className="lp-team-card-icon"><Users size={16} /></span><span>TEAM CAPACITY</span><span className="lp-team-active"><i /> ON TRACK</span></div><div className="lp-capacity-score">82<span>%</span><small>healthy sprint capacity</small></div><div className="lp-capacity-bars"><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /></div><div className="lp-team-people"><div><span className="lp-person person-am">AM</span><span><strong>Alex Morgan</strong><small>Design · 4 tasks</small></span><b>4/5</b></div><div><span className="lp-person person-jl">JL</span><span><strong>Jordan Lee</strong><small>Engineering · 6 tasks</small></span><b>6/7</b></div><div><span className="lp-person person-sk">SK</span><span><strong>Sam Kim</strong><small>Product · 3 tasks</small></span><b>3/5</b></div></div></div><div className="lp-team-orbit orbit-one" /><div className="lp-team-orbit orbit-two" /></div>
      </motion.div>
    </section>

    <section className="lp-sandbox lp-section" id="access">
      <motion.div className="lp-section-heading" initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: .35 }} transition={{ duration: .5 }}>
        <span className="lp-eyebrow"><span className="lp-eyebrow-mark" /> YOUR TURN</span>
        <h2>Try the board<br /><span>before you sign up.</span></h2>
        <p>Move a card, see the board respond. This little workspace is yours to play with.</p>
      </motion.div>
      <div className="lp-sandbox-panel">
        <div className="lp-sandbox-banner"><span><Sparkles size={14} /></span><strong>Interactive preview</strong><i /> Local account — no server needed <span className="lp-sandbox-reset"><button onClick={() => setCards(initialCards)}><Circle size={10} /> Reset board</button></span></div>
        <div className="lp-sandbox-toolbar"><div><span className="lp-sandbox-board-icon"><Command size={15} /></span><span><strong>Product launch</strong><small>Preview workspace <i /></small></span></div><div className="lp-sandbox-toolbar-right"><span className="lp-sandbox-member">AM</span><span className="lp-sandbox-member">JL</span><button aria-label="Add preview task" onClick={() => setCards((current) => [...current, { id: `task-${Date.now()}`, title: 'New idea to explore', tag: 'Product', priority: 'Medium', lane: 0, due: 'New', assignee: 'AM', color: 'violet' }])}><Plus size={14} /></button></div></div>
        <div className="lp-sandbox-columns">
          {lanes.map((lane, laneIndex) => <div className="lp-sandbox-column" key={lane} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const id = event.dataTransfer.getData('text/plain'); if (id) moveCard(id, laneIndex); setDragging(null); }}>
            <div className="lp-sandbox-col-head"><span><i className={`lp-dot ${['blue', 'purple', 'green'][laneIndex]}`} />{lane}</span><b>{cards.filter((card) => card.lane === laneIndex).length}</b></div>
            <div className="lp-sandbox-card-list">
              <AnimatePresence initial={false}>
                {cards.filter((card) => card.lane === laneIndex).map((card) => <motion.article className={`lp-sandbox-card ${dragging === card.id ? 'is-dragging' : ''}`} key={card.id} layout initial={{ opacity: 0, scale: .96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: .95 }} transition={{ type: 'spring', stiffness: 400, damping: 32 }} draggable onDragStart={(event) => { event.dataTransfer.setData('text/plain', card.id); setDragging(card.id); }} onDragEnd={() => setDragging(null)}>
                  <div className="lp-sandbox-card-top"><span className={`lp-sandbox-tag ${card.color}`}>{card.tag}</span><Grip size={14} /></div><strong>{card.title}</strong><div className="lp-sandbox-card-bottom"><span className={`lp-sandbox-priority ${card.priority.toLowerCase()}`}><i />{card.priority}</span><span className="lp-sandbox-due"><Clock3 size={11} />{card.due}</span><b className={`lp-person person-${card.assignee.toLowerCase()}`}>{card.assignee}</b></div>
                  <div className="lp-card-move-controls"><button type="button" aria-label={`Move ${card.title} left`} onClick={() => shiftCard(card.id, -1)} disabled={laneIndex === 0}><ChevronLeft size={14} /></button><span>{laneIndex + 1} / {lanes.length}</span><button type="button" aria-label={`Move ${card.title} right`} onClick={() => shiftCard(card.id, 1)} disabled={laneIndex === lanes.length - 1}><ChevronRight size={14} /></button></div>
                </motion.article>)}
              </AnimatePresence>
              {cards.every((card) => card.lane !== laneIndex) && <div className="lp-sandbox-empty"><span><CheckCircle2 size={15} /></span>Nothing here yet. Move a card in.</div>}
            </div>
          </div>)}
        </div>
        <div className="lp-sandbox-footer"><span><Grip size={13} /> Drag cards or use the arrows to move work</span><span><i /> Changes stay in this preview</span></div>
      </div>
    </section>

    <section className="lp-final-cta">
      <div className="lp-final-glow" />
      <motion.div className="lp-final-inner" initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: .4 }} transition={{ duration: .5 }}>
        <span className="lp-eyebrow"><span className="lp-spark"><Sparkles size={13} /></span> YOUR NEXT SPRINT STARTS HERE</span>
        <h2>Plan the work.<br /><span>Ship the sprint.</span></h2>
        <p>Make room for the work your team is great at.</p>
        <button className="lp-primary" onClick={() => onAuth('signup')}>Create your workspace <ArrowRight className="lp-cta-arrow" size={17} /></button>
        <div className="lp-cta-assurance"><LockKeyhole size={12} /> A workspace that’s yours from day one</div>
      </motion.div>
    </section>

    <footer className="lp-footer"><a className="lp-home-link" href="#top"><Brand /></a><span>Less chaos. More shipped.</span><div><a href="#planning">Product</a><a href="#teams">Teams</a><button onClick={() => onAuth('signin')}>Sign in</button></div><small>© {new Date().getFullYear()} LeadAI</small></footer>
  </main>;
}

function FeatureCard({ className, icon, color, index, title, description, footer, children }) {
  return <motion.article className={`lp-feature-card ${className}`} initial={{ opacity: 0, y: 24 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: .2 }} transition={{ duration: .48, delay: index * .08 }} whileHover={{ scale: 1.02, y: -3 }}>
    <div className={`lp-feature-icon ${color}`}>{icon}</div><h3>{title}</h3><p>{description}</p>{children}<div className="lp-feature-foot"><span><Check size={12} /></span>{footer}</div>
  </motion.article>;
}

export function AuthExperience({ mode, onModeChange, onBack, error, busy, onSubmit }) {
  const signup = mode === 'signup';
  return <main className="lp-auth-page">
    <div className="lp-auth-top"><button className="lp-auth-back" onClick={onBack}><ArrowLeft size={15} /> Back to LeadAI</button><a className="lp-home-link" href="/" onClick={(event) => { event.preventDefault(); onBack(); }}><Brand /></a><span className="lp-auth-top-note">Your team’s next chapter starts here.</span></div>
    <section className="lp-auth-shell">
      <aside className="lp-auth-story">
        <div className="lp-auth-story-glow" />
        <div className="lp-auth-story-content"><span className="lp-eyebrow"><span className="lp-spark"><Sparkles size={13} /></span> WORK, IN GOOD COMPANY</span><h1>Plan the work.<br /><span>Ship the sprint.</span></h1><p>Bring people, priorities, and progress into one shared space—and make every sprint feel a little more possible.</p>
          <div className="lp-auth-promise"><div><span><Check size={13} /></span><b>Start with a clear plan</b><small>Turn big ideas into work your team can move.</small></div><div><span><Check size={13} /></span><b>Keep the whole team in sync</b><small>Everyone knows what’s next and who owns it.</small></div><div><span><Check size={13} /></span><b>Finish with progress to show</b><small>See momentum build, one task at a time.</small></div></div>
        </div><div className="lp-auth-story-footer"><Brand light /><span>Made for teams that move forward.</span></div>
      </aside>
      <div className="lp-auth-form-side">
        <div className="lp-auth-form-wrap">
          <span className="lp-auth-caption">WELCOME TO LEADAI</span><h2>{signup ? 'Make room for good work.' : 'Good to have you back.'}</h2><p>{signup ? 'Create your workspace in just a moment.' : 'Sign in to pick up where your team left off.'}</p>
          <div className="lp-auth-tabs" role="tablist" aria-label="Account access"><button type="button" role="tab" aria-selected={!signup} className={!signup ? 'active' : ''} onClick={() => onModeChange('signin')}>Sign in</button><button type="button" role="tab" aria-selected={signup} className={signup ? 'active' : ''} onClick={() => onModeChange('signup')}>Sign up</button></div>
          <form className="lp-auth-form" onSubmit={onSubmit}>
            {signup && <label>Username<div className="lp-auth-input"><Users size={16} /><input autoFocus name="username" type="text" autoComplete="username" placeholder="How should we call you?" maxLength={80} required /></div></label>}
            <label>Email address<div className="lp-auth-input"><span className="lp-at-symbol">@</span><input autoFocus={!signup} name="email" type="email" autoComplete="email" placeholder="you@company.com" required /></div></label>
            <label>Password<div className="lp-auth-input"><LockKeyhole size={15} /><input name="password" type="password" minLength={8} maxLength={128} autoComplete={signup ? 'new-password' : 'current-password'} placeholder={signup ? 'At least 8 characters' : 'Enter your password'} required /></div></label>
            {error && <div className="lp-auth-error" role="alert">{error}</div>}
            <button className="lp-auth-submit" type="submit" disabled={busy}>{busy ? 'Setting up your workspace…' : signup ? 'Create your account' : 'Sign in to LeadAI'} {!busy && <ArrowRight size={16} />}</button>
          </form>
          <div className="lp-auth-switch">{signup ? 'Already have an account?' : 'New to LeadAI?'} <button type="button" onClick={() => onModeChange(signup ? 'signin' : 'signup')} disabled={busy}>{signup ? 'Sign in' : 'Create an account'}</button></div>
          <div className="lp-auth-footnote"><LockKeyhole size={12} /> Your work is private to your workspace.</div>
        </div>
      </div>
    </section>
  </main>;
}
