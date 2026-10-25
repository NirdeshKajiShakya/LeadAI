import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft, ArrowRight, Check, Eye, EyeOff, LayoutGrid, Mail, ShieldCheck, Sparkles, X
} from 'lucide-react';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '';
const DEVICE_KEY = 'leadai-device';
const DEVICE_PATTERN = /^[A-Za-z0-9_-]{16,80}$/;
const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/;

// Mirrors the server policy in backend/server/auth.js. The server validates the
// same rules again; this list only makes the requirement visible while typing.
const PASSWORD_RULES = [
  { id: 'length', label: 'At least 8 characters', test: (value) => value.length >= 8 && value.length <= 128 },
  { id: 'lowercase', label: 'One lowercase letter', test: (value) => /[a-z]/.test(value) },
  { id: 'uppercase', label: 'One uppercase letter', test: (value) => /[A-Z]/.test(value) },
  { id: 'number', label: 'One number', test: (value) => /[0-9]/.test(value) },
  { id: 'special', label: 'One special character', test: (value) => /[^A-Za-z0-9]/.test(value) }
];

function passwordIsValid(password) {
  return PASSWORD_RULES.every((rule) => rule.test(password));
}

// A stable id for this browser. The server stores only a hash of it and uses
// it to decide whether a sign-in needs an emailed code. If storage is blocked
// (private windows), every sign-in simply asks for a code.
function readDeviceId() {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id || !DEVICE_PATTERN.test(id)) {
      id = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `device-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return null;
  }
}

const deviceLabel = () => String(navigator.userAgent || 'Browser').slice(0, 120);

async function post(path, body) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.error || `Request failed (HTTP ${response.status}).`);
    error.status = response.status;
    error.code = payload?.code;
    error.challengeId = payload?.challengeId;
    error.purpose = payload?.purpose;
    error.email = payload?.email;
    throw error;
  }
  return payload || {};
}

function PasswordChecklist({ password, id }) {
  return (
    <ul className="password-rules" id={id} aria-label="Password requirements">
      {PASSWORD_RULES.map((rule) => {
        const met = rule.test(password);
        return (
          <li key={rule.id} className={met ? 'is-met' : 'is-missing'}>
            {met ? <Check size={13} aria-hidden="true" /> : <X size={13} aria-hidden="true" />}
            <span>{rule.label}</span>
            <span className="visually-hidden">{met ? 'requirement met' : 'requirement not met'}</span>
          </li>
        );
      })}
    </ul>
  );
}

function PasswordInput({
  id, name = 'password', autoComplete = 'current-password', value, onChange,
  describedBy, invalid = false, placeholder
}) {
  const [visible, setVisible] = useState(false);
  // Keep the input controlled even for forms that read values through FormData.
  const [draft, setDraft] = useState('');
  const isControlled = value !== undefined;
  return (
    <div className="auth-input-wrap">
      <input
        id={id}
        name={name}
        type={visible ? 'text' : 'password'}
        minLength={8}
        maxLength={128}
        autoComplete={autoComplete}
        value={isControlled ? value : draft}
        onChange={(event) => {
          if (isControlled) onChange?.(event);
          else setDraft(event.target.value);
        }}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        placeholder={placeholder}
        required
      />
      <button
        className="auth-reveal"
        type="button"
        onClick={() => setVisible((current) => !current)}
        aria-label={visible ? 'Hide password' : 'Show password'}
        aria-pressed={visible}
      >
        {visible ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
      </button>
    </div>
  );
}

const HEADINGS = {
  signin: { eyebrow: 'LeadAI workspace', title: 'Welcome back', copy: 'Sign in to continue to your sprint board.' },
  signup: { eyebrow: 'Create your workspace', title: 'Start with a clearer plan', copy: 'One account, a starter board, and a Copilot that knows your team.' },
  otp: { eyebrow: 'One more step', title: 'Enter your code', copy: '' },
  forgot: { eyebrow: 'Account recovery', title: 'Reset your password', copy: 'Enter your account email and we will generate a 6-digit code.' },
  reset: { eyebrow: 'Account recovery', title: 'Choose a new password', copy: 'Enter the code from your email or terminal and choose a new password.' }
};

export default function AuthScreen({ onAuthenticated, initialStep = 'signin', onBack }) {
  const [step, setStep] = useState(initialStep === 'signup' ? 'signup' : 'signin');
  const [challenge, setChallenge] = useState(null);
  const [reset, setReset] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [signup, setSignup] = useState({ name: '', username: '', email: '', password: '', confirmPassword: '' });
  const [usernameCheck, setUsernameCheck] = useState({ status: 'idle', message: '' });
  const codeRef = useRef(null);

  useEffect(() => {
    if (!cooldown) return undefined;
    const timer = setTimeout(() => setCooldown((value) => Math.max(0, value - 1)), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  useEffect(() => {
    if (step === 'otp') codeRef.current?.focus();
  }, [step]);

  // Informational only: the server still owns uniqueness. The debounce keeps
  // typing from firing a request per keystroke.
  useEffect(() => {
    if (step !== 'signup') return undefined;
    const username = signup.username.trim().toLowerCase();
    if (!username) {
      setUsernameCheck({ status: 'idle', message: '' });
      return undefined;
    }
    if (!USERNAME_PATTERN.test(username)) {
      setUsernameCheck({ status: 'invalid', message: 'Use 3-30 lowercase letters, numbers, or hyphens.' });
      return undefined;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(
          `${API_BASE_URL}/api/auth/username-available?username=${encodeURIComponent(username)}`,
          { signal: controller.signal }
        );
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          setUsernameCheck({ status: 'idle', message: payload?.error || '' });
          return;
        }
        setUsernameCheck(payload.available
          ? { status: 'available', message: `@${payload.username} is available.` }
          : { status: 'taken', message: 'That username is already taken.' });
      } catch (failure) {
        if (failure.name !== 'AbortError') setUsernameCheck({ status: 'idle', message: '' });
      }
    }, 450);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [signup.username, step]);

  function go(next) {
    setStep(next);
    setError('');
    setNotice('');
  }

  function startOver() {
    setChallenge(null);
    setReset(null);
    setCooldown(0);
    setSignup((current) => ({ ...current, password: '', confirmPassword: '' }));
    go('signin');
  }

  function updateSignup(field, value) {
    setSignup((current) => ({ ...current, [field]: value }));
  }

  async function submitCredentials(event) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email') || '').trim();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (step === 'signup') {
        const username = signup.username.trim().toLowerCase();
        if (!signup.name.trim()) {
          throw new Error('Enter your full name.');
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          throw new Error('Enter a valid email address.');
        }
        if (!USERNAME_PATTERN.test(username)) {
          throw new Error('Username must be 3-30 characters: lowercase letters, numbers, or hyphens, and cannot start or end with a hyphen.');
        }
        if (usernameCheck.status === 'taken') {
          throw new Error('That username is already taken.');
        }
        if (!passwordIsValid(signup.password)) {
          throw new Error('Choose a password that meets all five requirements below.');
        }
        if (signup.password !== signup.confirmPassword) {
          throw new Error('The passwords do not match.');
        }
        const payload = await post('/api/auth/signup', {
          name: signup.name.trim(),
          username,
          email,
          password: signup.password,
          deviceId: readDeviceId(),
          deviceLabel: deviceLabel()
        });
        setSignup((current) => ({ ...current, password: '', confirmPassword: '' }));
        setChallenge({ challengeId: payload.challengeId, email: payload.email || email, purpose: 'signup' });
        setStep('otp');
        setCooldown(60);
        setNotice(payload.message || `We sent a 6-digit code to ${payload.email || email}.`);
        return;
      }

      const payload = await post('/api/auth/signin', {
        email,
        password: form.get('password'),
        deviceId: readDeviceId(),
        deviceLabel: deviceLabel()
      });
      if (payload.token) return onAuthenticated(payload.token);
      if (payload.otpRequired) {
        setChallenge({ challengeId: payload.challengeId, email: payload.email || email, purpose: payload.purpose });
        setStep('otp');
        setCooldown(60);
        setNotice(payload.message || `We sent a 6-digit code to ${payload.email || email}.`);
        return;
      }
      setError('The server did not return a session. Please try again.');
    } catch (failure) {
      if (failure.code === 'EMAIL_NOT_VERIFIED' && failure.challengeId) {
        setChallenge({ challengeId: failure.challengeId, email: failure.email || email, purpose: 'signup' });
        setStep('otp');
        setCooldown(60);
        setNotice('We sent a new confirmation code. Enter it below to finish setting up your account.');
        return;
      }
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(event) {
    event.preventDefault();
    if (busy || !challenge) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      const payload = await post('/api/auth/otp/verify', {
        challengeId: challenge.challengeId,
        code: String(form.get('code') || '').trim(),
        deviceId: readDeviceId(),
        deviceLabel: deviceLabel()
      });
      if (payload.token) return onAuthenticated(payload.token);
      setError('The code was accepted but no session was returned. Please try again.');
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  async function resendCode() {
    if (busy || cooldown > 0 || !challenge) return;
    setBusy(true);
    setError('');
    try {
      const payload = await post('/api/auth/otp/resend', { challengeId: challenge.challengeId });
      setChallenge((current) => ({ ...current, challengeId: payload.challengeId || current.challengeId }));
      setCooldown(60);
      setNotice(`A new code is on its way to ${challenge.email}.`);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  async function submitForgot(event) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email') || '').trim();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const payload = await post('/api/auth/reset-password/request', { email });
      setReset({ challengeId: payload.challengeId, email });
      setStep('reset');
      setNotice(payload.message || 'If an account exists for that email, a code is on its way.');
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  async function submitReset(event) {
    event.preventDefault();
    if (busy || !reset) return;
    const form = new FormData(event.currentTarget);
    const password = String(form.get('password') || '');
    setError('');
    if (password !== String(form.get('confirmPassword') || '')) {
      setError('The passwords do not match.');
      return;
    }
    setBusy(true);
    setNotice('');
    try {
      await post('/api/auth/reset-password/confirm', {
        challengeId: reset.challengeId,
        code: String(form.get('code') || '').trim(),
        password
      });
      setReset(null);
      setCooldown(0);
      setStep('signin');
      setNotice('Password updated. Sign in with your new password.');
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  const heading = HEADINGS[step];
  const otpStep = step === 'otp';
  const resetStep = step === 'reset';
  const signupStep = step === 'signup';
  const credentialStep = step === 'signin' || step === 'signup';
  const passwordMismatch = signupStep && signup.confirmPassword.length > 0 && signup.password !== signup.confirmPassword;

  return (
    <main className="auth-screen">
      <div className="auth-shell">
        <aside className="auth-story">
          <div className="auth-brand">
            <div className="logo-mark" aria-hidden="true"><span></span><span></span><span></span></div>
            <span>LeadAI</span>
          </div>

          <div className="auth-story-body">
            <p className="auth-story-kicker">AI-assisted delivery</p>
            <p className="auth-story-title">Plan the work.<br /><span>Ship the sprint.</span></p>
            <p className="auth-story-lede">
              Turn a project goal into a reviewed backlog, keep every task on one board,
              and let Copilot handle the busywork.
            </p>

            <ul className="auth-proof">
              <li>
                <span className="auth-proof-icon"><Sparkles size={16} aria-hidden="true" /></span>
                <div>
                  <strong>Goal to backlog</strong>
                  <span>Generate a drafted plan, then review every task before it lands.</span>
                </div>
              </li>
              <li>
                <span className="auth-proof-icon"><LayoutGrid size={16} aria-hidden="true" /></span>
                <div>
                  <strong>One shared board</strong>
                  <span>Backlog, To Do, In Progress, Review, and Done stay in sync.</span>
                </div>
              </li>
              <li>
                <span className="auth-proof-icon"><ShieldCheck size={16} aria-hidden="true" /></span>
                <div>
                  <strong>Account protection</strong>
                  <span>Email codes, trusted browsers, and owner-scoped workspace data.</span>
                </div>
              </li>
            </ul>
          </div>

          <p className="auth-story-foot">
            <span aria-hidden="true" /> Backlog · To Do · In Progress · In Review / QA · Done
          </p>
        </aside>

        <section className="auth-panel" aria-labelledby="auth-title">
          <div className="auth-panel-top">
            <div className="auth-brand auth-brand-mobile">
              <div className="logo-mark" aria-hidden="true"><span></span><span></span><span></span></div>
              <span>LeadAI</span>
            </div>
            {onBack && (
              <button className="auth-back" type="button" onClick={onBack}>
                <ArrowLeft size={14} aria-hidden="true" /> Back to overview
              </button>
            )}
          </div>

          <div className="auth-panel-scroll">
            {credentialStep && (
              <div className="auth-segment" data-active={step} role="group" aria-label="Account access">
                <span className="auth-segment-thumb" aria-hidden="true" />
                <button
                  type="button"
                  aria-pressed={step === 'signin'}
                  onClick={() => go('signin')}
                  disabled={busy}
                >
                  Sign in
                </button>
                <button
                  type="button"
                  aria-pressed={step === 'signup'}
                  onClick={() => go('signup')}
                  disabled={busy}
                >
                  Sign up
                </button>
              </div>
            )}

            <header className="auth-heading">
              {(otpStep || resetStep) && (
                <div className="auth-step-icon">
                  {resetStep ? <ShieldCheck size={18} aria-hidden="true" /> : <Mail size={18} aria-hidden="true" />}
                </div>
              )}
              <p className="eyebrow">{heading.eyebrow}</p>
              <h1 id="auth-title">{heading.title}</h1>
              {otpStep ? (
                <p className="auth-subtitle">
                  We sent a 6-digit code to <strong>{challenge?.email}</strong>. It expires in 10 minutes.
                  {challenge?.purpose === 'signup' ? ' Verifying it completes your account setup.' : ''}
                </p>
              ) : (
                <p className="auth-subtitle">{heading.copy}</p>
              )}
            </header>

            {otpStep ? (
              <form className="auth-form" onSubmit={submitCode}>
                <label htmlFor="auth-code">6-digit code</label>
                <input
                  id="auth-code"
                  ref={codeRef}
                  className="otp-input"
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  placeholder="000000"
                  required
                />
                {notice && <div className="form-success" role="status">{notice}</div>}
                {error && <div className="form-error" role="alert">{error}</div>}
                <button className="primary-button auth-submit" type="submit" disabled={busy}>
                  {busy ? 'Checking...' : 'Verify and continue'} {!busy && <ArrowRight size={15} aria-hidden="true" />}
                </button>
              </form>
            ) : resetStep ? (
              <form className="auth-form" onSubmit={submitReset}>
                <label htmlFor="reset-code">6-digit code</label>
                <input id="reset-code" className="otp-input" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} placeholder="000000" required />
                <label htmlFor="reset-password">New password</label>
                <PasswordInput key="reset-password" id="reset-password" autoComplete="new-password" />
                <label htmlFor="reset-confirm">Confirm new password</label>
                <PasswordInput key="reset-confirm" id="reset-confirm" name="confirmPassword" autoComplete="new-password" />
                {notice && <div className="form-success" role="status">{notice}</div>}
                {error && <div className="form-error" role="alert">{error}</div>}
                <button className="primary-button auth-submit" type="submit" disabled={busy}>
                  {busy ? 'Updating...' : 'Update password'} {!busy && <ArrowRight size={15} aria-hidden="true" />}
                </button>
              </form>
            ) : step === 'forgot' ? (
              <form className="auth-form" onSubmit={submitForgot}>
                <label htmlFor="forgot-email">Email</label>
                <input id="forgot-email" name="email" type="email" autoComplete="email" required />
                {error && <div className="form-error" role="alert">{error}</div>}
                <button className="primary-button auth-submit" type="submit" disabled={busy}>
                  {busy ? 'Sending...' : 'Send reset code'} {!busy && <ArrowRight size={15} aria-hidden="true" />}
                </button>
              </form>
            ) : (
              <form className="auth-form" onSubmit={submitCredentials} noValidate={signupStep}>
                {signupStep && (
                  <>
                    <label htmlFor="signup-name">Full name</label>
                    <input
                      id="signup-name"
                      name="name"
                      autoComplete="name"
                      maxLength="80"
                      value={signup.name}
                      onChange={(event) => updateSignup('name', event.target.value)}
                      required
                    />
                    <label htmlFor="signup-username">Username</label>
                    <input
                      id="signup-username"
                      name="username"
                      autoComplete="username"
                      minLength="3"
                      maxLength="30"
                      pattern="[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])"
                      value={signup.username}
                      onChange={(event) => updateSignup('username', event.target.value.toLowerCase())}
                      aria-describedby="signup-username-status"
                      required
                    />
                    <p
                      id="signup-username-status"
                      className={`field-note ${usernameCheck.status === 'taken' || usernameCheck.status === 'invalid' ? 'is-error' : usernameCheck.status === 'available' ? 'is-ok' : ''}`}
                      aria-live="polite"
                    >
                      {usernameCheck.message || 'Lowercase letters, numbers, and hyphens. This is how teammates find you.'}
                    </p>
                  </>
                )}
                <label htmlFor="signup-email">Email</label>
                <input
                  id="signup-email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  value={signup.email}
                  onChange={(event) => updateSignup('email', event.target.value)}
                  required
                />
                {signupStep ? (
                  <>
                    <label htmlFor="signup-password">Password</label>
                    <PasswordInput
                      key="signup-password"
                      id="signup-password"
                      autoComplete="new-password"
                      value={signup.password}
                      onChange={(event) => updateSignup('password', event.target.value)}
                      describedBy="password-rules"
                    />
                    <PasswordChecklist password={signup.password} id="password-rules" />
                    <label htmlFor="signup-confirm">Confirm password</label>
                    <PasswordInput
                      key="signup-confirm"
                      id="signup-confirm"
                      name="confirmPassword"
                      autoComplete="new-password"
                      value={signup.confirmPassword}
                      onChange={(event) => updateSignup('confirmPassword', event.target.value)}
                      describedBy="signup-confirm-status"
                      invalid={passwordMismatch}
                    />
                    <p id="signup-confirm-status" className={`field-note ${passwordMismatch ? 'is-error' : ''}`} aria-live="polite">
                      {passwordMismatch ? 'The passwords do not match.' : 'Enter the same password again.'}
                    </p>
                  </>
                ) : (
                  <>
                    <label htmlFor="signin-password">Password</label>
                    <PasswordInput key="signin-password" id="signin-password" autoComplete="current-password" />
                  </>
                )}
                {step === 'signin' && (
                  <div className="auth-meta">
                    <button type="button" className="auth-link" onClick={() => go('forgot')} disabled={busy}>Forgot password?</button>
                  </div>
                )}
                {notice && <div className="form-success" role="status">{notice}</div>}
                {error && <div className="form-error" role="alert">{error}</div>}
                <button className="primary-button auth-submit" type="submit" disabled={busy}>
                  {busy ? 'Working...' : signupStep ? 'Create account' : 'Sign in'} {!busy && <ArrowRight size={15} aria-hidden="true" />}
                </button>
              </form>
            )}

            {otpStep ? (
              <div className="auth-actions">
                <button className="auth-switch" type="button" onClick={resendCode} disabled={busy || cooldown > 0}>
                  {cooldown > 0 ? `Resend code in ${cooldown}s` : 'Resend code'}
                </button>
                <button className="auth-switch" type="button" onClick={startOver} disabled={busy}>
                  <ArrowLeft size={12} aria-hidden="true" /> Use a different account
                </button>
              </div>
            ) : resetStep ? (
              <div className="auth-actions">
                <button className="auth-switch" type="button" onClick={() => go('forgot')} disabled={busy}>
                  <ArrowLeft size={12} aria-hidden="true" /> Use a different email
                </button>
                <button className="auth-switch" type="button" onClick={startOver} disabled={busy}>Back to sign in</button>
              </div>
            ) : step === 'forgot' ? (
              <button className="auth-switch" type="button" onClick={startOver} disabled={busy}>
                <ArrowLeft size={12} aria-hidden="true" /> Back to sign in
              </button>
            ) : null}

            {(otpStep || resetStep) && (
              <p className="auth-hint">
                {import.meta.env.DEV
                  ? <>Development: the 6-digit code is printed in the <strong>API terminal</strong>.</>
                  : 'If the code does not arrive, check your spam folder and request a new one.'}
              </p>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
