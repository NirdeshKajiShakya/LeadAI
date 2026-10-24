import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Mail, ShieldCheck } from 'lucide-react';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '';
const DEVICE_KEY = 'leadai-device';
const DEVICE_PATTERN = /^[A-Za-z0-9_-]{16,80}$/;

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
    throw error;
  }
  return payload || {};
}

const HEADINGS = {
  signin: { eyebrow: 'LeadAI workspace', title: 'Welcome back', copy: 'Sign in to continue to your sprint board.' },
  signup: { eyebrow: 'LeadAI workspace', title: 'Create your account', copy: 'Start shaping clearer work for your team.' },
  verify: { eyebrow: 'One more step', title: 'Check your email', copy: '' },
  otp: { eyebrow: 'One more step', title: 'Check your email', copy: '' },
  forgot: { eyebrow: 'Account recovery', title: 'Reset your password', copy: 'Enter your account email and we will send a 6-digit code.' },
  reset: { eyebrow: 'Account recovery', title: 'Choose a new password', copy: 'Enter the code from your email and a new password.' }
};

export default function AuthScreen({ onAuthenticated }) {
  const [step, setStep] = useState('signin');
  const [challenge, setChallenge] = useState(null);
  const [reset, setReset] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const codeRef = useRef(null);

  useEffect(() => {
    if (!cooldown) return undefined;
    const timer = setTimeout(() => setCooldown((value) => Math.max(0, value - 1)), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  useEffect(() => {
    if (step === 'otp') codeRef.current?.focus();
  }, [step]);

  function go(next) {
    setStep(next);
    setError('');
    setNotice('');
  }

  function startOver() {
    setChallenge(null);
    setReset(null);
    setCooldown(0);
    go('signin');
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
      const payload = await post(step === 'signup' ? '/api/auth/signup' : '/api/auth/signin', {
        name: form.get('name'),
        email,
        password: form.get('password'),
        deviceId: readDeviceId(),
        deviceLabel: deviceLabel()
      });
      if (payload.token) return onAuthenticated(payload.token);
      if (payload.verificationRequired) {
        setChallenge({ email: payload.email || email });
        setStep('verify');
        setCooldown(60);
        setNotice(payload.message || 'Check your email to verify your account.');
        return;
      }
      if (payload.otpRequired) {
        setChallenge({ challengeId: payload.challengeId, email: payload.email || email, purpose: payload.purpose });
        setStep('otp');
        setCooldown(60);
        setNotice(payload.message || `We emailed a 6-digit code to ${payload.email || email}.`);
        return;
      }
      setError('The server did not return a session. Please try again.');
    } catch (failure) {
      if (failure.code === 'EMAIL_NOT_VERIFIED') {
        setChallenge({ email });
        setStep('verify');
        setCooldown(0);
        setNotice('Check your email to verify your account. We can send a new link if you need one.');
        return;
      }
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  async function resendVerification() {
    if (busy || cooldown > 0 || !challenge?.email) return;
    setBusy(true);
    setError('');
    try {
      const payload = await post('/api/auth/verify-email/resend', { email: challenge.email });
      setCooldown(payload.cooldownSeconds || 60);
      setNotice(payload.message || `If ${challenge.email} still needs verification, a new link is on its way.`);
    } catch (failure) {
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
  const verifyStep = step === 'verify';
  const otpStep = step === 'otp';
  const resetStep = step === 'reset';

  return (
    <main className="auth-screen">
      <div className="auth-panel">
        <div className="logo-mark"><span></span><span></span><span></span></div>
        {verifyStep || otpStep || resetStep
          ? <div className="auth-step-icon">{resetStep ? <ShieldCheck size={18} /> : <Mail size={18} />}</div>
          : null}
        <div className="eyebrow">{heading.eyebrow}</div>
        <h1>{heading.title}</h1>
        {verifyStep
          ? <p>Check your email to verify your account. We sent a verification link to <strong>{challenge?.email}</strong>. It expires in 30 minutes.</p>
          : otpStep
            ? <p>We sent a 6-digit code to <strong>{challenge?.email}</strong>. It expires in 10 minutes.</p>
            : <p>{heading.copy}</p>}

        {verifyStep ? (
          <div className="auth-verify">
            {notice && <div className="form-success" role="status">{notice}</div>}
            {error && <div className="form-error" role="alert">{error}</div>}
            <button className="primary-button" type="button" onClick={() => go('signin')} disabled={busy}>
              Go to sign in {!busy && <ArrowRight size={15} />}
            </button>
          </div>
        ) : otpStep ? (
          <form onSubmit={submitCode}>
            <label>6-digit code
              <input
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
            </label>
            {notice && <div className="form-success" role="status">{notice}</div>}
            {error && <div className="form-error" role="alert">{error}</div>}
            <button className="primary-button" type="submit" disabled={busy}>
              {busy ? 'Checking...' : 'Verify and continue'} {!busy && <ArrowRight size={15} />}
            </button>
          </form>
        ) : resetStep ? (
          <form onSubmit={submitReset}>
            <label>Code from email
              <input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} placeholder="000000" required />
            </label>
            <label>New password
              <input name="password" type="password" minLength={8} maxLength={128} autoComplete="new-password" required />
            </label>
            <label>Confirm new password
              <input name="confirmPassword" type="password" minLength={8} maxLength={128} autoComplete="new-password" required />
            </label>
            {notice && <div className="form-success" role="status">{notice}</div>}
            {error && <div className="form-error" role="alert">{error}</div>}
            <button className="primary-button" type="submit" disabled={busy}>
              {busy ? 'Updating...' : 'Update password'} {!busy && <ArrowRight size={15} />}
            </button>
          </form>
        ) : step === 'forgot' ? (
          <form onSubmit={submitForgot}>
            <label>Email
              <input name="email" type="email" autoComplete="email" required />
            </label>
            {error && <div className="form-error" role="alert">{error}</div>}
            <button className="primary-button" type="submit" disabled={busy}>
              {busy ? 'Sending...' : 'Send reset code'} {!busy && <ArrowRight size={15} />}
            </button>
          </form>
        ) : (
          <form onSubmit={submitCredentials}>
            {step === 'signup' && <label>Name<input name="name" autoComplete="name" maxLength="80" /></label>}
            <label>Email<input name="email" type="email" autoComplete="email" required defaultValue={challenge?.email || ''} /></label>
            <label>Password
              <input
                name="password"
                type="password"
                minLength={8}
                maxLength={128}
                autoComplete={step === 'signup' ? 'new-password' : 'current-password'}
                required
              />
            </label>
            {step === 'signin' && (
              <div className="auth-meta">
                <button type="button" className="auth-link" onClick={() => go('forgot')} disabled={busy}>Forgot password?</button>
              </div>
            )}
            {notice && <div className="form-success" role="status">{notice}</div>}
            {error && <div className="form-error" role="alert">{error}</div>}
            <button className="primary-button" type="submit" disabled={busy}>
              {busy ? 'Working...' : step === 'signup' ? 'Create account' : 'Sign in'} {!busy && <ArrowRight size={15} />}
            </button>
          </form>
        )}

        {verifyStep ? (
          <div className="auth-actions">
            <button className="auth-switch" type="button" onClick={resendVerification} disabled={busy || cooldown > 0}>
              {cooldown > 0 ? `Resend verification email in ${cooldown}s` : 'Resend verification email'}
            </button>
            <button className="auth-switch" type="button" onClick={startOver} disabled={busy}>
              <ArrowLeft size={12} /> Use a different account
            </button>
          </div>
        ) : otpStep ? (
          <div className="auth-actions">
            <button className="auth-switch" type="button" onClick={resendCode} disabled={busy || cooldown > 0}>
              {cooldown > 0 ? `Resend code in ${cooldown}s` : 'Resend code'}
            </button>
            <button className="auth-switch" type="button" onClick={startOver} disabled={busy}>
              <ArrowLeft size={12} /> Use a different account
            </button>
          </div>
        ) : resetStep ? (
          <div className="auth-actions">
            <button className="auth-switch" type="button" onClick={() => go('forgot')} disabled={busy}>
              <ArrowLeft size={12} /> Use a different email
            </button>
            <button className="auth-switch" type="button" onClick={startOver} disabled={busy}>Back to sign in</button>
          </div>
        ) : step === 'forgot' ? (
          <button className="auth-switch" type="button" onClick={startOver} disabled={busy}>
            <ArrowLeft size={12} /> Back to sign in
          </button>
        ) : (
          <button
            className="auth-switch"
            type="button"
            onClick={() => go(step === 'signup' ? 'signin' : 'signup')}
            disabled={busy}
          >
            {step === 'signup' ? 'Already have an account? Sign in' : 'Need an account? Sign up'}
          </button>
        )}

        {(verifyStep || otpStep) && import.meta.env.DEV && (
          <p className="auth-hint">
            Local development without SMTP: the {verifyStep ? 'verification link' : 'code'} is printed in the API server log.
          </p>
        )}
      </div>
    </main>
  );
}
