import { useEffect, useState } from 'react';
import { Eye, EyeOff, Save, Settings2, Zap, X } from 'lucide-react';

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

function useSettings(token) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  async function load() {
    setLoading(true);
    setError('');
    try {
      setData(await request('/api/settings/env', token));
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
        const payload = await request('/api/settings/env', token);
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

function maskSecret(value) {
  if (!value) return '';
  const visible = 4;
  return value.length > visible ? '•'.repeat(value.length - visible) + value.slice(-visible) : '•'.repeat(value.length);
}

export default function SettingsPage({ token, navigate }) {
  const { data, loading, error, reload } = useSettings(token);
  const [form, setForm] = useState({
    mongodbUri: '',
    openrouterApiKey: '',
    openrouterModel: '',
  });
  const [masked, setMasked] = useState({ openrouterApiKey: true });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState('');

  useEffect(() => {
    if (data) {
      setForm({
        mongodbUri: data.mongodbUri || '',
        openrouterApiKey: data.openrouterApiKey || '',
        openrouterModel: data.openrouterModel || '',
      });
      setSaved(false);
      setSaveError('');
    }
  }, [data]);

  function update(key) {
    return (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  }

  async function saveSettings(event) {
    event.preventDefault();
    setSaving(true);
    setSaveError('');
    setSaved(false);
    try {
      const payload = await request('/api/settings/env', token, {
        method: 'POST',
        body: JSON.stringify({
          mongodbUri: form.mongodbUri || undefined,
          openrouterApiKey: form.openrouterApiKey || undefined,
          openrouterModel: form.openrouterModel || undefined,
        }),
      });
      if (payload.saved) {
        setSaved(true);
        setForm((current) => ({
          mongodbUri: payload.mongodbUri ?? current.mongodbUri,
          openrouterApiKey: payload.openrouterApiKey ?? current.openrouterApiKey,
          openrouterModel: payload.openrouterModel ?? current.openrouterModel,
        }));
      }
    } catch (saveError) {
      setSaveError(saveError.message || 'Could not save settings.');
    } finally {
      setSaving(false);
    }
  }

  function resetToEnv() {
    setForm({ mongodbUri: '', openrouterApiKey: '', openrouterModel: '' });
    setSaveError('');
    setSaved(false);
  }

  if (loading || error) {
    return (
      <section className="profile-page">
        <div className="profile-page-head">
          <h1>Settings</h1>
          <p>Control your workspace and AI provider preferences.</p>
        </div>
        {error && (
          <div className="form-error" role="alert">
            {error}
            <button type="button" onClick={reload} aria-label="Retry">
              <Settings2 size={13} />
            </button>
          </div>
        )}
        {loading && <p>Loading your settings…</p>}
      </section>
    );
  }

  return (
    <section className="profile-page">
      <div className="profile-page-head">
        <h1>Settings</h1>
        <p>Database and AI provider values entered here take precedence over backend/.env, which stays as the fallback.</p>
      </div>

      {saveError && (
        <div className="form-error" role="alert">
          {saveError}
          <button type="button" onClick={() => setSaveError('')} aria-label="Dismiss error">
            <X size={13} />
          </button>
        </div>
      )}

      <section className="profile-card" aria-labelledby="settings-database-heading">
        <div className="profile-card-head">
          <h2 id="settings-database-heading">
            <Settings2 size={15} /> Database
          </h2>
          <p>MongoDB connection string used to persist tasks, boards, and sprints.</p>
        </div>
        <div className="profile-fields">
          <div className="field-full">
            <label htmlFor="settings-mongodb-uri">MongoDB URI</label>
            <input
              id="settings-mongodb-uri"
              value={form.mongodbUri}
              onChange={update('mongodbUri')}
              placeholder="mongodb://127.0.0.1:27017/leadai_dev"
              aria-describedby="settings-mongodb-uri-help"
            />
            <div className="field-foot">
              <small id="settings-mongodb-uri-help">
                Must start with mongodb:// or mongodb+srv:// and name a database. Leave blank to use backend/.env.
              </small>
              {form.mongodbUri && (
                <span className="field-count">{form.mongodbUri.length} chars</span>
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="profile-card" aria-labelledby="settings-ai-heading">
        <div className="profile-card-head">
          <h2 id="settings-ai-heading">
            <Zap size={15} /> AI provider — OpenRouter
          </h2>
          <p>API key and model used by LeadAI Copilot for chat and task actions.</p>
        </div>
        <div className="profile-fields">
          <div className="field-full">
            <label htmlFor="settings-openrouter-api-key">OpenRouter API key</label>
            <input
              id="settings-openrouter-api-key"
              type={masked.openrouterApiKey ? 'password' : 'text'}
              value={masked.openrouterApiKey ? maskSecret(form.openrouterApiKey) : form.openrouterApiKey}
              onChange={update('openrouterApiKey')}
              placeholder="sk-or-v1-..."
              aria-describedby="settings-openrouter-api-key-help"
            />
            <div className="field-foot">
              <small id="settings-openrouter-api-key-help">
                Get your key from OpenRouter. Values are shown masked; enter again to replace.
              </small>
              <button
                type="button"
                className="icon-button"
                onClick={() => setMasked((current) => ({ ...current, openrouterApiKey: !current.openrouterApiKey }))}
                aria-label={masked.openrouterApiKey ? 'Show API key' : 'Hide API key'}
              >
                {masked.openrouterApiKey ? <Eye size={15} /> : <EyeOff size={15} />}
              </button>
            </div>
          </div>
          <div className="field">
            <label htmlFor="settings-openrouter-model">OpenRouter model</label>
            <input
              id="settings-openrouter-model"
              value={form.openrouterModel}
              onChange={update('openrouterModel')}
              placeholder="openrouter/free"
              aria-describedby="settings-openrouter-model-help"
            />
            <div className="field-foot">
              <small id="settings-openrouter-model-help">
                Choose from OpenRouter's model catalog. Defaults to openrouter/free when blank.
              </small>
            </div>
          </div>
        </div>
      </section>

      <footer className="profile-form-actions">
        <button type="button" className="secondary-button" onClick={resetToEnv} disabled={saving}>
          Reset to .env backup
        </button>
        <button type="submit" className="primary-button" onClick={saveSettings} disabled={saving}>
          {saving ? <><Save className="spin" size={15} /> Saving…</> : <><Save size={15} /> Save settings</>}
        </button>
      </footer>
    </section>
  );
}
