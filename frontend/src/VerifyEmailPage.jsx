import { useEffect, useRef, useState } from 'react';
import { ArrowRight, CheckCircle2, LoaderCircle, MailWarning } from 'lucide-react';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '';

// The email links to this page with the one-time token in the query string.
// The token is exchanged with a POST, so email scanners that prefetch links do
// not consume it before the user opens the message.
export default function VerifyEmailPage({ signedIn = false, onContinue }) {
  const [result, setResult] = useState({ status: 'checking', message: '' });
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const params = new URLSearchParams(window.location.search);
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const token = hash.get('token') || params.get('token');
    // Remove the token from the address bar and history immediately so it is
    // not left behind in screenshots, bookmarks, or later navigations.
    if (token) window.history.replaceState({}, '', '/verify-email');

    if (!token) {
      setResult({ status: 'invalid', message: 'This verification link is missing its token. Request a new verification email.' });
      return;
    }

    (async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/api/auth/verify-email`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token })
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(payload?.error || 'We could not verify this link. Request a new verification email.');
        }
        setResult({ status: 'success', message: payload?.message || 'Email verified. You can sign in now.' });
      } catch (error) {
        setResult({
          status: 'invalid',
          message: error.message || 'We could not verify this link. Request a new verification email.'
        });
      }
    })();
  }, []);

  const checking = result.status === 'checking';
  const success = result.status === 'success';
  const title = checking ? 'Verifying your email' : success ? 'Email verified' : 'Link not valid';

  return (
    <main className="auth-screen">
      <div className="auth-panel">
        <div className="logo-mark"><span></span><span></span><span></span></div>
        <div className={`auth-step-icon ${checking ? '' : success ? 'is-success' : 'is-error'}`}>
          {checking ? <LoaderCircle size={18} className="auth-spinner" /> : success ? <CheckCircle2 size={18} /> : <MailWarning size={18} />}
        </div>
        <div className="eyebrow">Email verification</div>
        <h1>{title}</h1>
        <p aria-live="polite">
          {checking
            ? 'One moment while we confirm your email address.'
            : success
              ? 'Your email address is confirmed. Sign in to open your workspace.'
              : 'This verification link is invalid, expired, or has already been used. Sign in with your email to request a new one.'}
        </p>

        <div className="auth-verify">
          {!checking && (
            <div className={success ? 'form-success' : 'form-error'} role={success ? 'status' : 'alert'}>
              {result.message}
            </div>
          )}
          {!checking && (
            <button className="primary-button" type="button" onClick={onContinue}>
              {signedIn ? 'Go to workspace' : 'Go to sign in'} <ArrowRight size={15} />
            </button>
          )}
        </div>
      </div>
    </main>
  );
}
