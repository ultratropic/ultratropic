import { useState } from 'react';
import { api, ApiError } from './api';
import Logo from './Logo';

/**
 * Landing page of an emailed sign-in link (/signin#<token>). Nothing happens
 * until the person presses the button: mail scanners that open links would
 * otherwise use the one-time token up before its owner gets there.
 */
export default function SignIn() {
  const [token] = useState(() => location.hash.slice(1));
  const [err, setErr] = useState(token ? '' : 'This sign-in link is incomplete. Ask for a new one.');
  const [busy, setBusy] = useState(false);

  async function go() {
    setBusy(true);
    setErr('');
    try {
      await api('/api/auth/verify', { method: 'POST', body: JSON.stringify({ token }) });
      location.replace('/'); // also drops the token from the address bar and history
    } catch (error) {
      setErr(error instanceof ApiError ? error.message : 'Something went wrong. Try again.');
      setBusy(false);
    }
  }

  return (
    <div className="wrap" style={{ maxWidth: 340 }}>
      <Logo width={150} style={{ marginBottom: 14 }} />
      <p className="sub">Sign in</p>
      {token && <button disabled={busy} onClick={go} autoFocus>{busy ? 'Signing in…' : 'Sign in'}</button>}
      {err && <p className="err">{err}</p>}
      {err && <p><a href="/">Get a new link</a></p>}
    </div>
  );
}
