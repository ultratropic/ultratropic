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

/**
 * Entry for both /p/<slug> (every album) and /a/<token> (one client album).
 * The photos show straight away (after the password, if the link has one);
 * a name and email are asked for only on the first heart, note or download.
 */
export default function ReviewerApp({ base }: { base: string }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [joined, setJoined] = useState(false);

  useEffect(() => {
    api<Info>(base)
      .then(async (i) => {
        // No password to ask for: open the link as a guest (or, for someone this
        // project already knows, simply add this album to what they can see).
        if (!i.joined && !i.hasPassword) {
          const r = await api<{ joined: boolean }>(`${base}/unlock`, { method: 'POST', body: '{}' });
          i = { ...i, joined: r.joined };
        }
        setInfo(i);
        setJoined(i.joined);
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
  return <Unlock base={base} title={title} onDone={() => setJoined(true)} />;
}

function Unlock({ base, title, onDone }: { base: string; title: string; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      await api(`${base}/unlock`, { method: 'POST', body: JSON.stringify({ password }) });
      onDone();
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
