import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';

/**
 * The whole account system: a name and an email, asked for the first time a
 * guest hearts, notes or downloads. The email is the identity within this
 * project, so returning with the same address brings back your selections.
 */
export default function NameGate({ base, why, onDone, onCancel }: {
  base: string;
  /** What they were doing, e.g. "to heart photos". */
  why: string;
  onDone: () => Promise<void> | void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => { first.current?.focus(); }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      await api(`${base}/join`, { method: 'POST', body: JSON.stringify({ name, email }) });
      await onDone();
    } catch (error) {
      const text = (error as Error).message;
      setErr(error instanceof ApiError && error.status === 429 ? 'Too many attempts. Wait a minute and try again.'
        : text.includes('email') ? 'Please enter a valid email address.'
          : text.includes('too long') ? 'That name is too long.'
            : 'Could not continue. Try again.');
      setBusy(false);
    }
  }

  return (
    <div
      className="name-gate-backdrop"
      onClick={(e) => { e.stopPropagation(); if (e.target === e.currentTarget && !busy) onCancel(); }}
      onKeyDown={(e) => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); onCancel(); } }}
    >
      <form className="name-gate" onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="ng-title">
        <h2 id="ng-title">Who's reviewing?</h2>
        <p className="sub">Add your name and email {why}.</p>
        <div className="field">
          <label htmlFor="ng-nm">Name</label>
          <input id="ng-nm" ref={first} type="text" value={name} autoComplete="name" maxLength={80}
            onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="ng-em">Email</label>
          <input id="ng-em" type="text" inputMode="email" value={email} autoComplete="email" maxLength={254}
            onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="name-gate-actions">
          <button disabled={busy || !name.trim() || !email.trim()}>{busy ? 'Saving…' : 'Continue'}</button>
          <button type="button" className="text-btn" disabled={busy} onClick={onCancel}>Cancel</button>
        </div>
        {err && <p className="err">{err}</p>}
        <p className="meta" style={{ marginTop: 18, marginBottom: 0 }}>
          No account needed. Your email just keeps your selections with you.
        </p>
      </form>
    </div>
  );
}
