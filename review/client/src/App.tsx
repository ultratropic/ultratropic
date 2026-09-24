import { useCallback, useEffect, useState } from 'react';
import { api, type Project } from './api';
import Gallery from './Gallery';
import Logo from './Logo';

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
      <Logo width={150} style={{ marginBottom: 14 }} />
      <p className="sub">Review · Admin</p>
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

/** The open project lives in the URL (/projects/<id>), so a refresh or the back button keeps you there. */
type Layout = 'list' | 'grid';
const LAYOUT_KEY = 'review-project-layout';
function savedLayout(): Layout {
  try {
    return localStorage.getItem(LAYOUT_KEY) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}

const projectFromPath = () => location.pathname.match(/^\/projects\/([A-Za-z0-9]+)/)?.[1] ?? null;

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [viewing, setViewingState] = useState<string | null>(projectFromPath);
  const [layout, setLayout] = useState<Layout>(savedLayout);
  const chooseLayout = (l: Layout) => {
    setLayout(l);
    try { localStorage.setItem(LAYOUT_KEY, l); } catch { /* private mode: just don't remember */ }
  };

  const setViewing = useCallback((id: string | null) => {
    const path = id ? `/projects/${id}` : '/';
    if (location.pathname !== path) history.pushState(null, '', path);
    setViewingState(id);
  }, []);

  useEffect(() => {
    const onPop = () => setViewingState(projectFromPath());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

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

  // Plain click opens in place; cmd/ctrl-click still opens a new tab, since
  // these are real links to /projects/<id>.
  const open = (e: React.MouseEvent, id: string) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    setViewing(id);
  };
  const meta = (p: Project) => (
    <>
      {p.album_count} {p.album_count === 1 ? 'album' : 'albums'} · {p.image_count} images
      {p.selected_count > 0 && ` · ${p.selected_count} selected`}
    </>
  );

  return (
    <div className={`wrap${layout === 'grid' ? ' wrap-wide' : ''}`}>
      <div className="dash-head">
        <div>
          <Logo width={150} style={{ marginBottom: 14 }} />
          <p className="sub" style={{ margin: 0 }}>Review · Projects</p>
        </div>
        {projects.length > 0 && (
          <div className="view-toggle" role="group" aria-label="Layout">
            <button className={layout === 'list' ? 'on' : ''} aria-pressed={layout === 'list'} onClick={() => chooseLayout('list')}>List</button>
            <button className={layout === 'grid' ? 'on' : ''} aria-pressed={layout === 'grid'} onClick={() => chooseLayout('grid')}>Grid</button>
          </div>
        )}
      </div>

      {layout === 'list' && projects.map((p) => (
        <a className="row row-link" key={p.id} href={`/projects/${p.id}`} onClick={(e) => open(e, p.id)}>
          <span className="row-thumb">
            {p.cover_thumb && <img src={`/i/${p.cover_thumb}`} alt="" loading="lazy" />}
          </span>
          <span className="row-name">{p.name}</span>
          <span className="meta">{meta(p)}</span>
        </a>
      ))}

      {layout === 'grid' && (
        <div className="cards">
          {projects.map((p) => (
            <a className="card" key={p.id} href={`/projects/${p.id}`} onClick={(e) => open(e, p.id)}>
              <span className="card-cover">
                {p.cover_thumb
                  ? <img src={`/i/${p.cover_thumb}`} alt="" loading="lazy" />
                  : <span className="meta">No photos yet</span>}
              </span>
              <span className="card-name">{p.name}</span>
              <span className="meta">{meta(p)}</span>
            </a>
          ))}
        </div>
      )}

      {projects.length === 0 && <p className="sub" style={{ marginTop: 24 }}>Nothing yet.</p>}
      <NewProject onCreated={(p) => setViewing(p.id)} />
    </div>
  );
}
