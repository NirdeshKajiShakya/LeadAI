import { useState } from 'react';
import { ArrowLeft, ArrowRight, CheckCircle2, Database, KeyRound } from 'lucide-react';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '';

export default function SetupWizard({ token, onComplete }) {
  const [step, setStep] = useState(0);
  const [databaseMode, setDatabaseMode] = useState('local');
  const [mongodbUri, setMongodbUri] = useState('');
  const [openrouterApiKey, setOpenrouterApiKey] = useState('');
  const [demoMode, setDemoMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(skipAI = demoMode) {
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`${API_BASE_URL}/api/system/configure`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          databaseMode,
          ...(databaseMode === 'cloud' ? { mongodbUri } : {}),
          ...(skipAI ? { skipAI: true } : { openrouterApiKey })
        })
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error || `Setup could not be saved (HTTP ${response.status}).`);
      onComplete();
    } catch (submitError) {
      setError(submitError.message || 'Setup could not be saved. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  function continueToAI() {
    if (databaseMode === 'cloud' && !mongodbUri.trim()) {
      setError('Enter your MongoDB Atlas or remote connection URI.');
      return;
    }
    setError('');
    setStep(1);
  }

  return (
    <div className="setup-backdrop">
      <section className="setup-modal" role="dialog" aria-modal="true" aria-labelledby="setup-title">
        <div className="setup-progress"><span style={{ width: step === 0 ? '50%' : '100%' }} /></div>
        <div className="setup-heading">
          <div className="setup-icon">{step === 0 ? <Database size={19} /> : <KeyRound size={19} />}</div>
          <div>
            <p className="setup-eyebrow">LEADAI · FIRST-TIME SETUP</p>
            <h1 id="setup-title">{step === 0 ? 'Choose your database' : 'Configure AI Copilot'}</h1>
            <p>{step === 0 ? 'Select where your workspace data will be stored.' : 'Add an OpenRouter key for AI features, or continue in demo mode.'}</p>
          </div>
        </div>

        {step === 0 ? (
          <div className="setup-options">
            <label className={`setup-choice ${databaseMode === 'local' ? 'is-selected' : ''}`}>
              <input type="radio" name="databaseMode" value="local" checked={databaseMode === 'local'} onChange={() => setDatabaseMode('local')} />
              <span><strong>Use Local Default</strong><small>mongodb://localhost:27017/leadai</small></span>
              <span className="setup-radio" />
            </label>
            <div className="setup-warning" role="note">
              ⚠️ Local MongoDB is only accessible on this machine. Remote teammates will not be able to access shared boards or accounts.
            </div>
            <label className={`setup-choice ${databaseMode === 'cloud' ? 'is-selected' : ''}`}>
              <input type="radio" name="databaseMode" value="cloud" checked={databaseMode === 'cloud'} onChange={() => setDatabaseMode('cloud')} />
              <span><strong>Custom Cloud URI</strong><small>MongoDB Atlas or another remote database</small></span>
              <span className="setup-radio" />
            </label>
            {databaseMode === 'cloud' && (
              <label className="setup-field">
                MongoDB connection URI
                <input
                  value={mongodbUri}
                  onChange={(event) => setMongodbUri(event.target.value)}
                  placeholder="mongodb+srv://user:password@cluster.example/leadai"
                  autoComplete="off"
                  spellCheck="false"
                />
                <small>If omitted, the database name defaults to leadai_dev. Keep this value private.</small>
              </label>
            )}
            <p className="setup-footnote">Changing databases does not copy existing boards or accounts. Choose the database your workspace should use.</p>
          </div>
        ) : (
          <div className="setup-options">
            <label className="setup-field">
              OpenRouter API Key
              <input
                type="password"
                value={openrouterApiKey}
                onChange={(event) => { setOpenrouterApiKey(event.target.value); setDemoMode(false); }}
                placeholder="sk-or-..."
                autoComplete="new-password"
              />
              <small>Unlocks sprint creation, story point estimation, and smart task assignment. Your key is stored only in the running backend configuration.</small>
            </label>
            <button type="button" className={`setup-demo ${demoMode ? 'is-selected' : ''}`} onClick={() => { setDemoMode((current) => !current); setOpenrouterApiKey(''); }}>
              <span className="setup-radio">{demoMode && <CheckCircle2 size={14} />}</span>
              <span><strong>Skip / Demo Mode</strong><small>Use boards and tasks without AI-powered features.</small></span>
            </button>
            <p className="setup-footnote">You can configure an API key later in Settings.</p>
          </div>
        )}

        {error && <p className="setup-error" role="alert">{error}</p>}
        <div className="setup-actions">
          {step === 1 ? (
            <button type="button" className="setup-secondary" onClick={() => { setError(''); setStep(0); }} disabled={busy}><ArrowLeft size={15} /> Back</button>
          ) : <span className="setup-step-label">STEP 1 OF 2</span>}
          {step === 0 ? (
            <button type="button" className="setup-primary" onClick={continueToAI} disabled={busy}>Continue <ArrowRight size={15} /></button>
          ) : (
            <button type="button" className="setup-primary" onClick={() => submit()} disabled={busy || (!demoMode && !openrouterApiKey.trim())}>
              {busy ? 'Saving…' : demoMode ? 'Finish setup' : 'Save and start'} <ArrowRight size={15} />
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
