import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowRight, CalendarDays, Check, ChevronRight, Link2, Loader2,
  Mail, MapPin, Minus, Pencil, Plus, RefreshCw, Search, Upload, X
} from 'lucide-react';
import { formatDateRange } from './sprintDates.js';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '';
const statusLabels = { backlog: 'Backlog', todo: 'To do', progress: 'In progress', review: 'In review', done: 'Done' };
const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const AVATAR_MAX_DATA_URL = 105_000;
const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/;

const SKILL_CATEGORIES = [
  {
    id: 'frontend',
    title: 'Frontend',
    skills: ['React', 'TypeScript', 'Next.js', 'Tailwind CSS', 'Vue', 'Angular', 'Svelte', 'JavaScript', 'HTML/CSS']
  },
  {
    id: 'backend',
    title: 'Backend',
    skills: ['Node.js', 'Python', 'Go', 'Java', 'Ruby', 'PHP', 'C#', 'Rust', 'GraphQL', 'REST APIs']
  },
  {
    id: 'devops',
    title: 'DevOps / Infrastructure',
    skills: ['Docker', 'Kubernetes', 'AWS', 'Azure', 'GCP', 'Terraform', 'CI/CD', 'Linux', 'Nginx', 'Redis']
  },
  {
    id: 'ai-ml',
    title: 'AI & ML',
    skills: ['AI/LLMs', 'Machine Learning', 'PyTorch', 'TensorFlow', 'LangChain', 'Prompt Engineering', 'Computer Vision', 'RAG']
  },
  {
    id: 'data',
    title: 'Data & Databases',
    skills: ['SQL', 'PostgreSQL', 'MongoDB', 'MySQL', 'GraphQL', 'Elasticsearch', 'Cassandra', 'DynamoDB']
  },
  {
    id: 'pm',
    title: 'Project Management',
    skills: ['Agile/Scrum', 'Kanban', 'Jira', 'Git', 'System Design', 'Technical Writing', 'Product Management']
  }
];

function initialsOf(name = '') {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  return parts.length ? (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase() : '?';
}

async function request(path, token, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers
    }
  });
  const body = await response.json().catch(() => null);
  if (response.status === 502 || response.status === 503 || response.status === 504) {
    throw new Error('Cannot reach the LeadAI API. Start the backend with `npm run dev:backend`, then retry.');
  }
  if (!response.ok) {
    const error = new Error(body?.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return body;
}

function useProfile(token) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  async function load() {
    setLoading(true);
    setError('');
    try {
      setData(await request('/api/profile', token));
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const payload = await request('/api/profile', token);
        if (active) setData(payload);
      } catch (loadError) {
        if (active) setError(loadError.message);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [token]);

  return { data, loading, error, reload: load };
}

function Avatar({ src, name, className = '' }) {
  return <span className={`avatar ${className}`.trim()}>{src ? <img src={src} alt="" /> : initialsOf(name)}</span>;
}

function joinedLabel(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return 'Unknown';
  return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function websiteLabel(value) {
  try { return new URL(value).hostname.replace(/^www\./, ''); } catch { return value; }
}

function updatedLabel(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return '';
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function StateMessage({ error, onRetry, children }) {
  if (error) {
    return <section className="profile-page"><div className="profile-status" role="alert">
      <AlertTriangle size={18} />
      <div><h1>Could not load your profile</h1><p>{error}</p></div>
      <button className="secondary-button" onClick={onRetry}><RefreshCw size={14} /> Retry</button>
    </div></section>;
  }
  return <section className="profile-page"><div className="profile-status" role="status">
    <Loader2 className="spin" size={18} /><p>{children}</p>
  </div></section>;
}

function SkillsSection({ skills, onManage }) {
  const safeSkills = Array.isArray(skills) ? skills : [];

  return (
    <section className="profile-section skills-section" aria-labelledby="profile-skills-heading">
      <div className="skills-card">
        <div className="skills-view-header">
          <div>
            <h2 id="profile-skills-heading">Skills &amp; Expertise</h2>
            <p>Select the technical skills and methodologies you work with.</p>
          </div>
          <button type="button" className="skills-view-edit-button" onClick={onManage}>
            Edit Skills
          </button>
        </div>
        <div className="skills-view-tags">
          {safeSkills.length > 0 ? (
            safeSkills.map((skill) => (
              <button key={skill} type="button" className="skill-view-tag" aria-label={`Manage ${skill} skill`} onClick={() => onManage(skill)}>
                {skill}
              </button>
            ))
          ) : (
            <p className="skills-view-empty">No skills added yet. Select skills below to showcase your technical background.</p>
          )}
        </div>
      </div>
    </section>
  );
}

function SkillManager({ skills, onSave, onCancel }) {
  const safeSkills = Array.isArray(skills) ? skills : [];
  const allSkills = SKILL_CATEGORIES.flatMap((category) => category.skills);
  const [selectedSkills, setSelectedSkills] = useState([...safeSkills]);
  const [query, setQuery] = useState('');
  const [customSkill, setCustomSkill] = useState('');
  const [customSkills, setCustomSkills] = useState(safeSkills.filter((skill) => !allSkills.includes(skill)));

  const filtered = allSkills.filter((skill) => skill.toLowerCase().includes(query.toLowerCase()));

  function toggleSkill(skill) {
    setSelectedSkills((prev) => (prev.includes(skill) ? prev.filter((s) => s !== skill) : [...prev, skill]));
  }

  function addCustomSkill(event) {
    event.preventDefault();
    const name = customSkill.trim();
    if (!name || customSkills.includes(name) || allSkills.includes(name)) {
      setCustomSkill('');
      return;
    }
    setCustomSkills([...customSkills, name]);
    setSelectedSkills((prev) => [...prev, name]);
    setCustomSkill('');
  }

  function removeCustomSkill(skill) {
    setCustomSkills(customSkills.filter((s) => s !== skill));
    setSelectedSkills((prev) => prev.filter((s) => s !== skill));
  }

  const finalSkills = selectedSkills;

  return (
    <section className="profile-section skills-section skill-manager" aria-labelledby="profile-skills-manager-heading">
      <header className="profile-card-head skills-header">
        <div>
          <h2 id="profile-skills-manager-heading">Skills &amp; Expertise</h2>
          <p>Select the technical skills and methodologies you work with.</p>
        </div>
        <button type="button" className="link-button skills-cancel-button" onClick={onCancel}>
          <X size={14} /> Cancel
        </button>
      </header>

      <div className="skills-manager-body">
        <label className="skills-search-label" htmlFor="skills-search">
          <Search size={14} aria-hidden="true" /><span className="visually-hidden">Search skills</span>
        </label>
        <input
          id="skills-search"
          className="skills-search-input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search skills…"
          aria-label="Search skills"
        />

        <div className="skills-category-list">
          {SKILL_CATEGORIES.map((category) => {
            const categorySkills = category.skills.filter((skill) => skill.toLowerCase().includes(query.toLowerCase()));
            if (categorySkills.length === 0) return null;
            return (
              <div key={category.id} className="skills-category">
                <h3 className="skills-category-title">{category.title}</h3>
                <ul className="skills-list">
                  {categorySkills.map((skill) => {
                    const checked = selectedSkills.includes(skill);
                    return (
                      <li key={skill} className="skills-list-item">
                        <button
                          type="button"
                          className={`skills-checkbox ${checked ? 'is-checked' : ''}`}
                          aria-checked={checked}
                          onClick={() => toggleSkill(skill)}
                        >
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12" /></svg>
                          <span>{skill}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>

        <div className="skills-custom-section">
          <h3 className="skills-category-title">Custom skills</h3>
          <form onSubmit={addCustomSkill} className="skills-custom-form" noValidate>
            <input
              className="skills-custom-input"
              value={customSkill}
              onChange={(event) => setCustomSkill(event.target.value)}
              placeholder="Add a custom skill…"
              aria-label="Add a custom skill"
            />
            <button type="submit" className="skills-custom-add"><Plus size={14} /></button>
          </form>
          {customSkills.length > 0 && (
            <ul className="skills-list skills-custom-list">
              {customSkills.map((skill) => (
                <li key={skill} className="skills-list-item skills-list-item-custom">
                  <span className="skills-label">{skill}</span>
                  <button type="button" className="skills-remove" aria-label={`Remove ${skill}`} onClick={() => removeCustomSkill(skill)}>
                    <Minus size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="skills-selected-summary">
          <strong>{finalSkills.length} selected</strong>
          <p className="skills-selected-hint">Changes are saved when you save your profile.</p>
        </div>

        <footer className="profile-form-actions skills-manager-footer">
          <button type="button" className="secondary-button" onClick={onCancel}>Cancel</button>
          <button type="button" className="primary-button" onClick={() => onSave(finalSkills)}><Check size={15} /> Done</button>
        </footer>
      </div>
    </section>
  );
}

function SkillsEditModal({ open, skills, onSave, onCancel }) {
  const safeSkills = Array.isArray(skills) ? skills : [];
  const allSkills = SKILL_CATEGORIES.flatMap((category) => category.skills);
  const [selectedSkills, setSelectedSkills] = useState([...safeSkills]);
  const [query, setQuery] = useState('');
  const [customSkill, setCustomSkill] = useState('');
  const [customSkills, setCustomSkills] = useState(safeSkills.filter((skill) => !allSkills.includes(skill)));

  function toggleSkill(skill) {
    setSelectedSkills((prev) => (prev.includes(skill) ? prev.filter((s) => s !== skill) : [...prev, skill]));
  }

  function addCustomSkill(event) {
    event.preventDefault();
    const name = customSkill.trim();
    if (!name || customSkills.includes(name) || allSkills.includes(name)) {
      setCustomSkill('');
      return;
    }
    setCustomSkills([...customSkills, name]);
    setSelectedSkills((prev) => [...prev, name]);
    setCustomSkill('');
  }

  function removeCustomSkill(skill) {
    setCustomSkills(customSkills.filter((s) => s !== skill));
    setSelectedSkills((prev) => prev.filter((s) => s !== skill));
  }

  const finalSkills = selectedSkills;

  return (
    <div className={`skills-edit-overlay${open ? ' is-open' : ''}`} onClick={onCancel}>
      <div className="skills-edit-modal" onClick={(event) => event.stopPropagation()}>
        <div className="skills-edit-header">
          <div>
            <h2 className="skills-edit-title">Skills &amp; Expertise</h2>
            <p className="skills-edit-subtitle">Select the technical skills and methodologies you work with.</p>
          </div>
          <button type="button" className="skills-edit-close" onClick={onCancel} aria-label="Close skills editor">
            <X size={18} />
          </button>
        </div>

        <div className="skills-edit-search">
          <div className="skills-edit-search-wrapper">
            <Search size={16} aria-hidden="true" className="skills-edit-search-icon" />
            <input
              id="skills-edit-search"
              className="skills-edit-search-input"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search skills…"
              aria-label="Search skills"
              autoFocus
            />
          </div>
        </div>

        <div className="skills-edit-body">
          {SKILL_CATEGORIES.map((category) => {
            const categorySkills = category.skills.filter((skill) => skill.toLowerCase().includes(query.toLowerCase()));
            if (categorySkills.length === 0) return null;
            return (
              <div key={category.id} className="skills-edit-category">
                <h3 className="skills-edit-category-title">{category.title}</h3>
                <div className="skills-edit-grid">
                  {categorySkills.map((skill) => {
                    const checked = selectedSkills.includes(skill);
                    return (
                      <button
                        key={skill}
                        type="button"
                        className={`skills-edit-card${checked ? ' is-active' : ''}`}
                        aria-checked={checked}
                        onClick={() => toggleSkill(skill)}
                      >
                        <span className="skills-edit-card-name">{skill}</span>
                        {checked && <span className="skills-edit-check" aria-hidden="true">&#10003;</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}

          <div className="skills-edit-category">
            <h3 className="skills-edit-category-title">Custom skills</h3>
            <form onSubmit={addCustomSkill} className="skills-edit-custom-form" noValidate>
              <input
                className="skills-edit-custom-input"
                value={customSkill}
                onChange={(event) => setCustomSkill(event.target.value)}
                placeholder="Add a custom skill…"
                aria-label="Add a custom skill"
              />
              <button type="submit" className="skills-edit-custom-add"><Plus size={14} /></button>
            </form>
            {customSkills.length > 0 && (
              <div className="skills-edit-grid skills-edit-custom-grid">
                {customSkills.map((skill) => {
                  const checked = selectedSkills.includes(skill);
                  return (
                    <button
                      key={skill}
                      type="button"
                      className={`skills-edit-card skills-edit-card-custom${checked ? ' is-active' : ''}`}
                      aria-checked={checked}
                      onClick={() => removeCustomSkill(skill)}
                    >
                      <span className="skills-edit-card-name">{skill}</span>
                      <span className="skills-edit-remove" aria-label={`Remove ${skill}`}>
                        <Minus size={12} />
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className="skills-edit-footer">
          <button type="button" className="skills-edit-btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="skills-edit-btn-primary" onClick={() => onSave(finalSkills)}>
            Save Changes <Check size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

export function ProfilePage({ token, navigate }) {
  const { data, loading, error, reload } = useProfile(token);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [pendingSkills, setPendingSkills] = useState([]);

  function closeSkillsModal() {
    setIsClosing(true);
    setTimeout(() => {
      setIsClosing(false);
      setIsEditModalOpen(false);
    }, 220);
  }

  // Keyboard listener (Escape to close). Must run before any conditional return
  // so hook order stays identical across loading/loaded renders.
  useEffect(() => {
    if (!isEditModalOpen) return;
    function onKeyDown(event) {
      if (event.key === 'Escape') closeSkillsModal();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isEditModalOpen]);

  if (loading || error) return <StateMessage error={error} onRetry={reload}>{loading ? 'Loading your profile…' : ''}</StateMessage>;
  if (!data || !data.profile) return <StateMessage error="Profile data is not available." onRetry={reload} />;

  const { profile, stats, recentTasks, sprint } = data;
  const displayName = profile.name || profile.email?.split('@')[0] || 'User';
  const userSkills = profile.skills || [];
  const sprintState = sprint?.current?.state;

  function handleSkillsSave(nextSkills) {
    const skills = Array.isArray(nextSkills) ? nextSkills : [];
    console.log("Saving skills:", skills);
    setPendingSkills(skills);
    request('/api/profile', token, {
      method: 'PATCH',
      body: JSON.stringify({ skills })
    })
      .then((payload) => {
        reload();
        console.log("Skills saved successfully:", payload.profile.skills);
      })
      .catch((saveError) => {
        console.error("Failed to save skills:", saveError);
      })
      .finally(() => {
        closeSkillsModal();
      });
  }

  return <section className="profile-page">
    <nav className="profile-crumbs" aria-label="Breadcrumb"><span>Account</span><ChevronRight size={12} aria-hidden="true" /><strong>Profile</strong></nav>
    <div className="profile-layout">
      <aside className="profile-sidebar" aria-label="Profile summary">
        <div className="profile-identity">
          <Avatar src={profile.avatar} name={displayName} className="avatar-xl" />
          <div className="profile-identity-text">
            <h1>{displayName}</h1>
            {profile.username
              ? <p className="profile-handle">@{profile.username}</p>
              : <button type="button" className="profile-handle profile-handle-empty" onClick={() => navigate('/profile/edit')}>Add a username</button>}
          </div>
        </div>

        {profile.bio
          ? <p className="profile-bio">{profile.bio}</p>
          : <p className="profile-bio profile-bio-empty">No bio yet. <button type="button" className="link-button" onClick={() => navigate('/profile/edit')}>Add one</button> so teammates know what you work on.</p>}

        <button className="secondary-button profile-edit-button" onClick={() => navigate('/profile/edit')}><Pencil size={14} /> Edit profile</button>

        <dl className="profile-meta">
          <div><dt><Mail size={14} aria-hidden="true" /><span className="visually-hidden">Email</span></dt><dd>{profile.email}</dd></div>
          {profile.location && <div><dt><MapPin size={14} aria-hidden="true" /><span className="visually-hidden">Location</span></dt><dd>{profile.location}</dd></div>}
          {profile.website && <div><dt><Link2 size={14} aria-hidden="true" /><span className="visually-hidden">Website</span></dt><dd><a href={profile.website} target="_blank" rel="noreferrer noopener">{websiteLabel(profile.website)}</a></dd></div>}
          <div><dt><CalendarDays size={14} aria-hidden="true" /><span className="visually-hidden">Joined</span></dt><dd>Joined {joinedLabel(profile.createdAt)}</dd></div>
        </dl>

        <SkillsSection
          skills={userSkills}
          onManage={() => {
            setPendingSkills(userSkills);
            setIsEditModalOpen(true);
          }}
        />
        {(isEditModalOpen || isClosing) && (
          <SkillsEditModal
            open={isEditModalOpen}
            skills={pendingSkills}
            onSave={handleSkillsSave}
            onCancel={closeSkillsModal}
          />
        )}
      </aside>

      <div className="profile-main">
        <section className="profile-section" aria-labelledby="profile-activity">
          <header className="profile-section-head">
            <div><h2 id="profile-activity">Activity</h2><p>Your work in this workspace.</p></div>
          </header>
          <dl className="profile-stats">
            <div><dt>Open tasks</dt><dd>{stats.openTasks}</dd></div>
            <div><dt>In progress</dt><dd>{stats.inProgressTasks}</dd></div>
            <div><dt>Completed</dt><dd>{stats.completedTasks}</dd></div>
            <div><dt>Sprints</dt><dd>{stats.sprints}</dd></div>
          </dl>
        </section>

        {sprint && <section className="profile-section" aria-labelledby="profile-sprint">
          <header className="profile-section-head">
            <div><h2 id="profile-sprint">Current sprint</h2><p>{formatDateRange(sprint.startDate, sprint.endDate)}</p></div>
            <button className="link-button" onClick={() => navigate('/backlog')}>Open backlog <ArrowRight size={13} /></button>
          </header>
          <div className="profile-sprint">
            <div className="profile-sprint-top">
              <strong>{sprint.name}</strong>
              <span>{sprintState === 'active' ? `Day ${sprint.current.day} of ${sprint.current.total}` : sprintState === 'upcoming' ? 'Upcoming' : 'Completed'}</span>
            </div>
            <div className="profile-meter" role="img" aria-label={`${sprint.progress.progressPercent}% of sprint story points completed`}>
              <span style={{ width: `${sprint.progress.progressPercent}%` }} />
            </div>
            <div className="profile-sprint-meta">
              <span>{sprint.progress.completedStoryPoints} of {sprint.progress.totalStoryPoints} story points</span>
              <span>{sprint.progress.progressPercent}% complete</span>
            </div>
          </div>
        </section>}

        <section className="profile-section" aria-labelledby="profile-recent">
          <header className="profile-section-head">
            <div><h2 id="profile-recent">Recent work</h2><p>The tasks you touched most recently.</p></div>
            {recentTasks.length > 0 && <button className="link-button" onClick={() => navigate('/')}>Open board <ArrowRight size={13} /></button>}
          </header>
          {recentTasks.length
            ? <ul className="profile-activity-list">
              {recentTasks.map((task) => <li key={task.key}>
                <span className={`status-dot status-${task.status}`} aria-hidden="true" />
                <span className="profile-activity-main"><span className="profile-activity-key">{task.key}</span><span className="profile-activity-title">{task.title}</span></span>
                <span className={`profile-status-chip status-${task.status}`}>{statusLabels[task.status] || task.status}</span>
                <span className="profile-activity-time">Updated {updatedLabel(task.updatedAt)}</span>
              </li>)}
            </ul>
            : <div className="profile-empty">
              <p>No tasks yet. Your board is where work starts.</p>
              <button className="secondary-button" onClick={() => navigate('/')}>Go to your board <ArrowRight size={14} /></button>
            </div>}
        </section>
      </div>
    </div>
  </section>;
}

function emptyForm(profile) {
  return {
    name: profile.name || '',
    username: profile.username || '',
    bio: profile.bio || '',
    location: profile.location || '',
    website: profile.website || '',
    avatar: profile.avatar || '',
    skills: profile.skills || []
  };
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read that image.'));
    reader.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('That file is not a readable image.'));
    image.src = src;
  });
}

// Resize in the browser so avatars stay small enough to live on the user document.
async function compressAvatar(file) {
  if (!AVATAR_TYPES.includes(file.type)) throw new Error('Choose a PNG, JPEG, or WebP image.');
  if (file.size > 5 * 1024 * 1024) throw new Error('Image must be 5 MB or smaller.');
  const image = await loadImage(await readFile(file));
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  const scale = Math.max(size / image.width, size / image.height);
  const width = Math.round(image.width * scale);
  const height = Math.round(image.height * scale);
  context.fillStyle = '#141a22';
  context.fillRect(0, 0, size, size);
  context.drawImage(image, Math.round((size - width) / 2), Math.round((size - height) / 2), width, height);
  let dataUrl = canvas.toDataURL('image/jpeg', 0.82);
  if (dataUrl.length > AVATAR_MAX_DATA_URL) dataUrl = canvas.toDataURL('image/jpeg', 0.62);
  if (dataUrl.length > AVATAR_MAX_DATA_URL) throw new Error('Could not compress that image small enough. Try a simpler image.');
  return dataUrl;
}

function ProfileForm({ profile, token, navigate, onUserChange }) {
  const [baseline, setBaseline] = useState(() => emptyForm(profile));
  const [form, setForm] = useState(baseline);
  const [skillsEditing, setSkillsEditing] = useState(false);

  function removeSkill(skill) {
    setForm((current) => ({ ...current, skills: Array.isArray(current.skills) ? current.skills.filter((s) => s !== skill) : [] }));
  }
  const [fieldErrors, setFieldErrors] = useState({});
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState('');
  const fileInput = useRef(null);
  const dirty = JSON.stringify(form) !== JSON.stringify(baseline);

  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  // The submit button is disabled after a successful save; move focus to the confirmation.
  useEffect(() => {
    if (saved) document.querySelector('.profile-notice[role="status"]')?.focus();
  }, [saved]);

  const update = (field) => (event) => {
    setForm((current) => ({ ...current, [field]: event.target.value }));
    setFieldErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
    setSaved(false);
    setError('');
  };

  function validate() {
    const errors = {};
    if (form.name.trim().length > 80) errors.name = 'Name must be 80 characters or fewer.';
    if (form.username.trim() && !USERNAME_PATTERN.test(form.username.trim().toLowerCase())) {
      errors.username = 'Use 3–30 lowercase letters, numbers, or hyphens, and do not start or end with a hyphen.';
    }
    if (form.bio.length > 300) errors.bio = 'Bio must be 300 characters or fewer.';
    if (form.location.trim().length > 80) errors.location = 'Location must be 80 characters or fewer.';
    if (form.website.trim()) {
      try {
        const url = new URL(form.website.trim());
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('protocol');
      } catch {
        errors.website = 'Enter a full URL starting with http:// or https://.';
      }
    }
    return errors;
  }

  async function save(event) {
    event.preventDefault();
    const errors = validate();
    setFieldErrors(errors);
    setError('');
    setSaved(false);
    if (Object.keys(errors).length) {
      setError('Check the highlighted fields and try again.');
      document.getElementById(`profile-${Object.keys(errors)[0]}`)?.focus();
      return;
    }
    setSaving(true);
    try {
      const payload = await request('/api/profile', token, { method: 'PATCH', body: JSON.stringify(form) });
      const next = emptyForm(payload.profile);
      setForm(next);
      setBaseline(next);
      onUserChange?.(payload.profile);
      setSaved(true);
    } catch (saveError) {
      if (saveError.status === 409) {
        setFieldErrors({ username: saveError.message });
        setError('Check the highlighted fields and try again.');
        document.getElementById('profile-username')?.focus();
      } else {
        setError(saveError.message);
      }
    } finally {
      setSaving(false);
    }
  }

  function cancel() {
    if (dirty && !window.confirm('Discard your unsaved profile changes?')) return;
    navigate('/profile');
  }

  async function pickAvatar(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setAvatarBusy(true);
    setAvatarError('');
    setSaved(false);
    setError('');
    try {
      const dataUrl = await compressAvatar(file);
      setForm((current) => ({ ...current, avatar: dataUrl }));
    } catch (avatarFailure) {
      setAvatarError(avatarFailure.message);
    } finally {
      setAvatarBusy(false);
    }
  }

  return <section className="profile-page">
    <nav className="profile-crumbs" aria-label="Breadcrumb">
      <span>Account</span><ChevronRight size={12} aria-hidden="true" />
      <button type="button" className="link-button" onClick={cancel}>Profile</button>
      <ChevronRight size={12} aria-hidden="true" /><strong>Edit</strong>
    </nav>
    <header className="profile-page-head">
      <h1>Edit profile</h1>
      <p>Changes show up on your profile and across your board as soon as you save.</p>
    </header>

    {saved && <div className="profile-notice" role="status" tabIndex={-1}>
      <Check size={15} /> Profile updated.
      <button type="button" className="link-button" onClick={() => navigate('/profile')}>View profile <ArrowRight size={13} /></button>
    </div>}
    {error && <div className="profile-notice is-error" role="alert">
      <AlertTriangle size={15} /><span>{error}</span>
      <button type="button" onClick={() => setError('')} aria-label="Dismiss error"><X size={14} /></button>
    </div>}

    <form className="profile-form" onSubmit={save} noValidate>
      <section className="profile-card" aria-labelledby="profile-avatar-heading">
        <div className="profile-card-head">
          <h2 id="profile-avatar-heading">Avatar</h2>
          <p>Shown on your profile and in the workspace. Images are resized to 256 × 256.</p>
        </div>
        <div className="avatar-editor">
          <Avatar src={form.avatar} name={form.name || profile.email} className="avatar-lg" />
          <div className="avatar-actions">
            <input id="profile-avatar-file" ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" onChange={pickAvatar} className="visually-hidden" tabIndex={-1} aria-hidden="true" />
            <button type="button" className="secondary-button" onClick={() => fileInput.current?.click()} disabled={avatarBusy}>
              {avatarBusy ? <><Loader2 className="spin" size={14} /> Processing…</> : <><Upload size={14} /> Upload image</>}
            </button>
            {form.avatar && <button type="button" className="avatar-remove" onClick={() => { setForm((current) => ({ ...current, avatar: '' })); setSaved(false); setError(''); }}>Remove</button>}
            <small>PNG, JPEG, or WebP · 5 MB max before resizing · saved at 80 KB or less</small>
            {avatarError && <p className="field-error" role="alert">{avatarError}</p>}
          </div>
        </div>
      </section>

      <section className="profile-card" aria-labelledby="profile-fields-heading">
        <div className="profile-card-head">
          <h2 id="profile-fields-heading">Public profile</h2>
          <p>This information is visible to people you share a workspace with.</p>
        </div>
        <div className="profile-fields">
          <div className="field">
            <label htmlFor="profile-name">Name</label>
            <input id="profile-name" value={form.name} onChange={update('name')} maxLength={80} autoComplete="name" aria-invalid={Boolean(fieldErrors.name)} aria-describedby="profile-name-help" />
            <small id="profile-name-help">Leave blank to use your email address instead.</small>
            {fieldErrors.name && <p className="field-error">{fieldErrors.name}</p>}
          </div>

          <div className="field">
            <label htmlFor="profile-username">Username</label>
            <div className="input-prefix">
              <span aria-hidden="true">@</span>
              <input id="profile-username" value={form.username} onChange={update('username')} maxLength={30} autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-invalid={Boolean(fieldErrors.username)} aria-describedby="profile-username-help" />
            </div>
            <small id="profile-username-help">3–30 characters. Lowercase letters, numbers, and hyphens.</small>
            {fieldErrors.username && <p className="field-error">{fieldErrors.username}</p>}
          </div>

          <div className="field field-full">
            <label htmlFor="profile-bio">Bio</label>
            <textarea id="profile-bio" rows={3} maxLength={300} value={form.bio} onChange={update('bio')} aria-invalid={Boolean(fieldErrors.bio)} aria-describedby="profile-bio-help" />
            <div className="field-foot">
              <small id="profile-bio-help">A short line about what you work on.</small>
              <span className="field-count">{form.bio.length}/300</span>
            </div>
            {fieldErrors.bio && <p className="field-error">{fieldErrors.bio}</p>}
          </div>

          <div className="field">
            <label htmlFor="profile-location">Location</label>
            <input id="profile-location" value={form.location} onChange={update('location')} maxLength={80} placeholder="City, country" autoComplete="address-level2" aria-invalid={Boolean(fieldErrors.location)} />
            {fieldErrors.location && <p className="field-error">{fieldErrors.location}</p>}
          </div>

          <div className="field">
            <label htmlFor="profile-website">Website</label>
            <input id="profile-website" value={form.website} onChange={update('website')} maxLength={200} placeholder="https://example.com" inputMode="url" aria-invalid={Boolean(fieldErrors.website)} aria-describedby="profile-website-help" />
            <small id="profile-website-help">Include http:// or https://.</small>
            {fieldErrors.website && <p className="field-error">{fieldErrors.website}</p>}
          </div>
        </div>
      </section>

      {skillsEditing ? (
        <SkillManager
          skills={form.skills}
          onSave={(nextSkills) => {
            setForm((current) => ({ ...current, skills: nextSkills }));
            setSkillsEditing(false);
          }}
          onCancel={() => setSkillsEditing(false)}
        />
      ) : (
        <section className="profile-card skills-section" aria-labelledby="profile-skills-heading">
          <header className="profile-card-head skills-header">
            <div>
              <h2 id="profile-skills-heading">Skills &amp; Expertise</h2>
              <p>Select the technical skills and methodologies you work with.</p>
            </div>
            <button type="button" className="link-button skills-manage-button" onClick={() => setSkillsEditing(true)}>
              <Pencil size={14} /> Manage skills
            </button>
          </header>
          <div className="skills-tags">
            {form.skills && form.skills.length > 0 ? (
              form.skills.map((skill) => (
                <button key={skill} type="button" className="skill-tag" aria-label={`Remove ${skill} skill`} onClick={() => removeSkill(skill)}>
                  {skill}<X size={12} />
                </button>
              ))
            ) : (
              <p className="skills-empty">No skills added yet. Select skills below to showcase your technical background.</p>
            )}
          </div>
        </section>
      )}

      <section className="profile-card" aria-labelledby="profile-account-heading">
        <div className="profile-card-head">
          <h2 id="profile-account-heading">Account</h2>
          <p>Sign-in details are managed separately from your public profile.</p>
        </div>
        <div className="profile-fields">
          <div className="field">
            <label htmlFor="profile-email">Email</label>
            <input id="profile-email" value={profile.email} readOnly disabled />
            <small>Used to sign in. It cannot be changed here.</small>
          </div>
          <div className="field">
            <label htmlFor="profile-joined">Member since</label>
            <input id="profile-joined" value={joinedLabel(profile.createdAt)} readOnly disabled />
            <small>Your account role is managed by your workspace.</small>
          </div>
        </div>
      </section>

      <footer className="profile-form-actions">
        <button type="button" className="secondary-button" onClick={cancel}>Cancel</button>
        <button type="submit" className="primary-button" disabled={saving || !dirty}>
          {saving ? <><Loader2 className="spin" size={15} /> Saving…</> : <><Check size={15} /> Save changes</>}
        </button>
      </footer>
    </form>
  </section>;
}

export function ProfileEditPage({ token, navigate, onUserChange }) {
  const { data, loading, error, reload } = useProfile(token);

  if (loading || error) return <StateMessage error={error} onRetry={reload}>{loading ? 'Loading your profile…' : ''}</StateMessage>;
  if (!data || !data.profile) return <StateMessage error="Profile data is not available." onRetry={reload} />;
  return <ProfileForm key={data.profile._id} profile={data.profile} token={token} navigate={navigate} onUserChange={onUserChange} />;
}
