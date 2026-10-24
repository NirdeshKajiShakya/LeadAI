import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, KeyRound, LogOut, Save, Settings2, Shield, X } from 'lucide-react';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '';

function request(path, token, options = {}) {
  return fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  }).then(async (response) => {
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(body?.error || `Request failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return body;
  });
}

const EMPTY_FORM = { mongodbUri: '', openrouterApiKey: '', openrouterModel: '' };

export default function SettingsPage({ token, user, navigate, onSignOut }) {
  const isAdmin = user?.role === 'admin';
  const verified = user?.emailVerified !== false;

  return (
    <section className="profile-page">
      <div className="profile-page-head">
        <h1>Settings</h1>
        <p>Your account and security. Workspace configuration is managed separately.</p>
      </div>

      <section className="profile-card" aria-labelledby="settings-account-heading">
        <div className="profile-card-head">
          <h2 id="settings-account-heading"><Shield size={15} /> Account</h2>
          <p>How you sign in to this workspace. Change your name and photo from your profile.</p>
        </div>
        <div className="profile-fields">
          <div className="settings-status">
            <div><span>Name</span><strong>{user?.name || 'Not set'}</strong></div>
            <div><span>Email</span><strong>{user?.email || 'Unknown'}</strong></div>
            <div><span>Email status</span><strong>{verified ? 'Verified' : 'Not verified'}</strong></div>
            <div><span>Role</span><strong>{isAdmin ? 'Administrator' : 'Member'}</strong></div>
          </div>
        </div>
        <footer className="profile-form-actions">
          <button type="button" className="secondary-button" onClick={() => navigate('/profile/edit')}>
            Edit profile
          </button>
          <button type="button" className="secondary-button" onClick={onSignOut}>
            <LogOut size={14} /> Sign out
          </button>
        </footer>
      </section>

      <PasswordCard token={token} email={user?.email} onSignOut={onSignOut} />

      {isAdmin && <ServerPanel token={token} />}
    </section>
  );
}

function PasswordCard({ token, email, onSignOut }) {
  const [challengeId, setChallengeId] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [changed, setChanged] = useState(false);

  async function sendCode() {
    setBusy(true);
    setError('');
    try {
      const payload = await request('/api/auth/reset-password/request', token, {
        method: 'POST',
        body: JSON.stringify({ email }),
      });
      setChallengeId(payload.challengeId);
      setNotice(`We sent a 6-digit code to ${email}. It expires in 10 minutes.`);
    } catch (sendError) {
      setError(sendError.message || 'Could not send the code.');
    } finally {
      setBusy(false);
    }
  }

  async function confirm(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await request('/api/auth/reset-password/confirm', token, {
        method: 'POST',
        body: JSON.stringify({ challengeId, code: code.trim(), password }),
      });
      // The server revokes every session on a password change, so this browser
      // is signed out too. Say so instead of letting the next click 401.
      setChanged(true);
      setCode('');
      setPassword('');
    } catch (confirmError) {
      setError(confirmError.message || 'Could not change the password.');
    } finally {
      setBusy(false);
    }
  }

  if (changed) {
    return (
      <section className="profile-card" aria-labelledby="settings-security-heading">
        <div className="profile-card-head">
          <h2 id="settings-security-heading"><KeyRound size={15} /> Password</h2>
          <p>Password changed. For safety every device was signed out, including this one.</p>
        </div>
        <p className="settings-saved" role="status">Sign in again with your new password.</p>
        <footer className="profile-form-actions">
          <button type="button" className="primary-button" onClick={onSignOut}>Go to sign in</button>
        </footer>
      </section>
    );
  }

  return (
    <section className="profile-card" aria-labelledby="settings-security-heading">
      <div className="profile-card-head">
        <h2 id="settings-security-heading"><KeyRound size={15} /> Password</h2>
        <p>We email a confirmation code to {email}, then the new password takes effect and every session ends.</p>
      </div>

      {error && (
        <div className="form-error" role="alert">
          {error}
          <button type="button" onClick={() => setError('')} aria-label="Dismiss error"><X size={13} /></button>
        </div>
      )}
      {notice && <p className="settings-saved" role="status">{notice}</p>}

      {!challengeId ? (
        <footer className="profile-form-actions">
          <button type="button" className="secondary-button" onClick={sendCode} disabled={busy || !email}>
            {busy ? 'Sending…' : 'Send confirmation code'}
          </button>
        </footer>
      ) : (
        <form onSubmit={confirm}>
          <div className="profile-fields">
            <div className="field">
              <label htmlFor="settings-reset-code">Confirmation code</label>
              <input
                id="settings-reset-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder="6-digit code"
              />
            </div>
            <div className="field">
              <label htmlFor="settings-new-password">New password</label>
              <input
                id="settings-new-password"
                type="password"
                autoComplete="new-password"
                minLength={8}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="At least 8 characters"
                aria-describedby="settings-new-password-help"
              />
              <div className="field-foot">
                <small id="settings-new-password-help">8–128 characters. Every signed-in device is signed out afterwards.</small>
              </div>
            </div>
          </div>
          <footer className="profile-form-actions">
            <button type="button" className="secondary-button" onClick={sendCode} disabled={busy}>
              Resend code
            </button>
            <button type="submit" className="primary-button" disabled={busy || code.trim().length < 6 || password.length < 8}>
              {busy ? 'Changing…' : 'Change password'}
            </button>
          </footer>
        </form>
      )}
    </section>
  );
}

function ServerPanel({ token }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState('');
  const [saveError, setSaveError] = useState('');

  useEffect(() => {
    let active = true;
    request('/api/settings/env', token)
      .then((payload) => {
        if (!active) return;
        setData(payload);
        setForm({ ...EMPTY_FORM, openrouterModel: payload.openrouterModel || '' });
      })
      .catch((loadError) => { if (active) setError(loadError.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [token]);

  function update(key) {
    return (event) => {
      if (saved) setSaved('');
      if (saveError) setSaveError('');
      setForm((current) => ({ ...current, [key]: event.target.value }));
    };
  }

  async function submit(changes) {
    setSaving(true);
    setSaveError('');
    setSaved('');
    try {
      const payload = await request('/api/settings/env', token, {
        method: 'POST',
        body: JSON.stringify(changes),
      });
      setData(payload);
      setForm({ ...EMPTY_FORM, openrouterModel: payload.openrouterModel || '' });
      setSaved('Saved for this server session.');
    } catch (submitError) {
      setSaveError(submitError.message || 'Could not save settings.');
    } finally {
      setSaving(false);
    }
  }

  function saveSettings(event) {
    event.preventDefault();
    // Blank fields mean "keep the stored value": secrets are never sent to the
    // browser, so there is nothing safe to prefill.
    const changes = Object.fromEntries(
      Object.entries(form)
        .map(([key, value]) => [key, value.trim()])
        .filter(([, value]) => value.length > 0),
    );
    if (!Object.keys(changes).length) {
      setSaveError('Enter at least one value to change, or use "Reset to .env backup".');
      return;
    }
    submit(changes);
  }

  const status = data && (
    <div className="settings-status">
      <div>
        <span>Database</span>
        <strong>{data.mongodbConfigured ? `${data.mongodbDatabase || 'unknown'} @ ${data.mongodbHost || 'unknown'}` : 'Not configured'}</strong>
      </div>
      <div>
        <span>AI provider</span>
        <strong>{data.openrouterConfigured ? `Configured ${data.openrouterKeyHint}` : 'Not configured'}</strong>
      </div>
      <div>
        <span>Model</span>
        <strong>{data.openrouterModel || 'Provider default'}</strong>
      </div>
    </div>
  );

  return (
    <section className="profile-card" aria-labelledby="settings-server-heading">
      <div className="profile-card-head">
        <h2 id="settings-server-heading"><Settings2 size={15} /> Server configuration</h2>
        <p>Administrator only. Values entered here override backend/.env, which stays as the fallback. Secrets are never sent back to the browser.</p>
      </div>

      {loading && <p role="status">Loading server configuration…</p>}
      {error && (
        <div className="form-error" role="alert">
          <AlertTriangle size={14} /> {error}
        </div>
      )}
      {saveError && (
        <div className="form-error" role="alert">
          {saveError}
          <button type="button" onClick={() => setSaveError('')} aria-label="Dismiss error"><X size={13} /></button>
        </div>
      )}
      {saved && <p className="settings-saved" role="status"><CheckCircle2 size={13} /> {saved}</p>}

      {data && (
        <form onSubmit={saveSettings}>
          <div className="profile-fields">
            {status}
            <div className="field field-full">
              <label htmlFor="settings-mongodb-uri">New MongoDB URI</label>
              <input
                id="settings-mongodb-uri"
                value={form.mongodbUri}
                onChange={update('mongodbUri')}
                placeholder="Leave blank to keep the current connection"
                autoComplete="off"
                spellCheck="false"
                aria-describedby="settings-mongodb-uri-help"
              />
              <div className="field-foot">
                <small id="settings-mongodb-uri-help">
                  Must start with mongodb:// or mongodb+srv:// and name a database. The API reconnects immediately.
                </small>
              </div>
            </div>
            <div className="field field-full">
              <label htmlFor="settings-openrouter-api-key">New OpenRouter API key</label>
              <input
                id="settings-openrouter-api-key"
                type="password"
                value={form.openrouterApiKey}
                onChange={update('openrouterApiKey')}
                placeholder="Leave blank to keep the current key"
                autoComplete="new-password"
                spellCheck="false"
                aria-describedby="settings-openrouter-api-key-help"
              />
              <div className="field-foot">
                <small id="settings-openrouter-api-key-help">
                  Get your key from OpenRouter. It is stored on the server and never displayed again.
                </small>
              </div>
            </div>
            <div className="field">
              <label htmlFor="settings-openrouter-model">OpenRouter model</label>
              <input
                id="settings-openrouter-model"
                value={form.openrouterModel}
                onChange={update('openrouterModel')}
                placeholder="openrouter/free"
                autoComplete="off"
                spellCheck="false"
                aria-describedby="settings-openrouter-model-help"
              />
              <div className="field-foot">
                <small id="settings-openrouter-model-help">Leave blank to use the provider default.</small>
              </div>
            </div>
          </div>

          <footer className="profile-form-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={() => submit({ mongodbUri: '', openrouterApiKey: '', openrouterModel: '' })}
              disabled={saving}
            >
              Reset to .env backup
            </button>
            <button type="submit" className="primary-button" disabled={saving}>
              {saving ? <><Save className="spin" size={15} /> Saving…</> : <><Save size={15} /> Save settings</>}
            </button>
          </footer>
        </form>
      )}
    </section>
  );
}
