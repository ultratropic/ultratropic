import { useEffect, useState } from 'react';
import { api, ApiError } from './api';
import Gallery from './Gallery';
import Logo from './Logo';

interface Info {
  name: string;
  /** Set on a client album link. */
  album: string | null;
  hasPassword: boolean;
  joined: boolean;
  /** Already identified in this project (e.g. via another album link). */
  known: boolean;
  reviewerName: string | null;
}

/** Entry for both /p/<slug> (every album) and /a/<token> (one client album). */
export default function ReviewerApp({ base }: { base: string }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const [joined, setJoined] = useState(false);

  useEffect(() => {
    api<Info>(base)
      .then(async (i) => {
        // Someone this project already knows, opening a new album link with no
        // password: nothing to ask them, just grant the album.
        if (i.known && !i.joined && !i.hasPassword) {
          const r = await api<{ joined: boolean }>(`${base}/unlock`, { method: 'POST', body: '{}' });
          i = { ...i, joined: r.joined };
        }
        setInfo(i);
        setJoined(i.joined);
        setUnlocked(!i.hasPassword);
      })
      .catch(() => setNotFound(true));
  }, [base]);

  if (notFound) {
    return (
      <div className="wrap" style={{ maxWidth: 380 }}>
      <Logo width={150} style={{ marginBottom: 44 }} />
        <h1>Not found</h1>
        <p className="sub">This link is no longer active.</p>
      </div>
    );
  }
  if (!info) return null;

  const title = info.album ? `${info.name} — ${info.album}` : info.name;

  if (joined) return <Gallery base={base} admin={false} />;
  if (!unlocked) {
    return (
      <Unlock
        base={base}
        title={title}
        // A known reviewer who unlocks is granted access straight away.
        onDone={(alreadyJoined) => (alreadyJoined ? setJoined(true) : setUnlocked(true))}
      />
    );
  }
  return <Join base={base} title={title} onDone={() => setJoined(true)} />;
}

function Unlock({ base, title, onDone }: { base: string; title: string; onDone: (joined: boolean) => void }) {
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      const r = await api<{ joined: boolean }>(`${base}/unlock`, {
        method: 'POST',
        body: JSON.stringify({ password }),
      });
      onDone(r.joined);
    } catch (error) {
      setErr(error instanceof ApiError && error.status === 429
        ? 'Too many attempts. Wait a minute and try again.'
        : 'Incorrect password.');
      setBusy(false);
    }
  }

  return (
    <div className="wrap" style={{ maxWidth: 380 }}>
      <Logo width={150} style={{ marginBottom: 44 }} />
      <h1>{title}</h1>
      <p className="sub">This gallery is password protected.</p>
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="pw">Password</label>
          <input id="pw" type="password" value={password} autoFocus
            onChange={(e) => setPassword(e.target.value)} />
        </div>
        <button disabled={busy || !password}>{busy ? 'Checking…' : 'Continue'}</button>
        {err && <p className="err">{err}</p>}
      </form>
    </div>
  );
}

/**
 * The whole account system: a name and an email. The email is the identity within
 * this project, so returning with the same address brings back your selections.
 */
function Join({ base, title, onDone }: { base: string; title: string; onDone: () => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      await api(`${base}/join`, { method: 'POST', body: JSON.stringify({ name, email }) });
      onDone();
    } catch (error) {
      const text = (error as Error).message;
      setErr(text.includes('email') ? 'Please enter a valid email address.' : 'Could not start. Try again.');
      setBusy(false);
    }
  }

  return (
    <div className="wrap" style={{ maxWidth: 380 }}>
      <Logo width={150} style={{ marginBottom: 44 }} />
      <h1>{title}</h1>
      <p className="sub">Enter your name and email to start reviewing.</p>
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="nm">Name</label>
          <input id="nm" type="text" value={name} autoFocus autoComplete="name"
            onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="em">Email</label>
          <input id="em" type="text" inputMode="email" value={email} autoComplete="email"
            onChange={(e) => setEmail(e.target.value)} />
        </div>
        <button disabled={busy || !name.trim() || !email.trim()}>
          {busy ? 'Starting…' : 'Start reviewing'}
        </button>
        {err && <p className="err">{err}</p>}
      </form>
      <p className="meta" style={{ marginTop: 24 }}>
        No account needed. Your email just keeps your selections with you.
      </p>
    </div>
  );
}
