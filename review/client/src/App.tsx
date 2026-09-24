import { useCallback, useEffect, useState } from 'react';
import { api, type Project } from './api';
import Gallery from './Gallery';

function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password }) });
      onDone();
    } catch {
      setErr('Incorrect password.');
      setBusy(false);
    }
  }

  return (
    <div className="wrap" style={{ maxWidth: 340 }}>
      <h1>Review</h1>
      <p className="sub">Admin</p>
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="pw">Password</label>
          <input id="pw" type="password" value={password} autoFocus
            onChange={(e) => setPassword(e.target.value)} />
        </div>
        <button disabled={busy || !password}>{busy ? 'Checking…' : 'Sign in'}</button>
        {err && <p className="err">{err}</p>}
      </form>
    </div>
  );
}

function NewProject({ onCreated }: { onCreated: (p: { id: string }) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const created = await api<{ id: string }>('/api/admin/projects', {
      method: 'POST',
      body: JSON.stringify({ name, password: password || undefined }),
    });
    setName(''); setPassword(''); setBusy(false); setOpen(false);
    onCreated(created);
  }

  if (!open) {
    return <button className="ghost" style={{ marginTop: 32 }} onClick={() => setOpen(true)}>Create project</button>;
  }
  return (
    <form onSubmit={create} style={{ marginTop: 32, paddingTop: 24, borderTop: '1px solid var(--line)' }}>
      <div className="field">
        <label htmlFor="n">Project name</label>
        <input id="n" type="text" value={name} autoFocus onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="p">Password (optional)</label>
        <input id="p" type="text" value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      <button disabled={busy || !name.trim()}>{busy ? 'Creating…' : 'Create'}</button>{' '}
      <button type="button" className="ghost" onClick={() => setOpen(false)}>Cancel</button>
    </form>
  );
}

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [viewing, setViewing] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { projects } = await api<{ projects: Project[] }>('/api/admin/projects');
    setProjects(projects);
  }, []);

  useEffect(() => {
    api('/api/admin/me').then(() => { setAuthed(true); return load(); }).catch(() => setAuthed(false));
  }, [load]);

  if (authed === null) return null;
  if (!authed) return <Login onDone={() => { setAuthed(true); void load(); }} />;

  // A project opens straight into its gallery; there is nothing useful in between.
  if (viewing) {
    return (
      <Gallery
        base={`/api/admin/projects/${viewing}`}
        admin
        onBack={() => { setViewing(null); void load(); }}
      />
    );
  }

  return (
    <div className="wrap">
      <h1>Review</h1>
      <p className="sub">Projects</p>
      {projects.map((p) => (
        <div className="row" key={p.id}>
          <a href="#" onClick={(e) => { e.preventDefault(); setViewing(p.id); }}>{p.name}</a>
          <span className="meta">
            {p.album_count} {p.album_count === 1 ? 'album' : 'albums'} · {p.image_count} images
            {p.selected_count > 0 && ` · ${p.selected_count} selected`}
          </span>
        </div>
      ))}
      {projects.length === 0 && <p className="sub">Nothing yet.</p>}
      <NewProject onCreated={(p) => setViewing(p.id)} />
    </div>
  );
}
