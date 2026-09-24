import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import Grid, { type Img } from './Grid';
import Viewer from './Viewer';
import Uploader from './Uploader';
import SharePanel, { type ShareState } from './SharePanel';
import Stats from './Stats';
import CopyLink from './CopyLink';

export interface GalleryImg extends Img {
  album: number;
  selects: number;
  mine: boolean;
  dup: boolean;
}

interface Album extends ShareState { id: string; name: string }
interface Reviewer { id: string; name: string; isMe: boolean; count: number; lastSeen?: number }

interface GalleryData {
  project: { id: string; name: string; slug: string | null; previewEdge: number; hasPassword?: boolean };
  me: { id: string; name: string };
  albums: Album[];
  reviewers: Reviewer[];
  selectionsByReviewer: Record<string, string[]>;
  rows: unknown[][];
}

export type Filter =
  | { kind: 'all' }
  | { kind: 'mine' }
  | { kind: 'any' }
  | { kind: 'dup' }
  | { kind: 'reviewer'; id: string };

export default function Gallery({
  base,
  admin,
  onBack,
}: {
  /** API prefix: /api/admin/projects/<id>, /api/p/<slug> or /api/a/<token>. */
  base: string;
  admin: boolean;
  onBack?: () => void;
}) {
  const [data, setData] = useState<GalleryData | null>(null);
  const [images, setImages] = useState<GalleryImg[]>([]);
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [activeAlbum, setActiveAlbum] = useState(0);
  const [mode, setMode] = useState<'browse' | 'upload' | 'stats'>('browse');
  const [filter, setFilter] = useState<Filter>({ kind: 'all' });
  const [selectedBy, setSelectedBy] = useState<Record<string, string[]>>({});
  const [sharing, setSharing] = useState<string | null>(null);
  const sectionRefs = useRef<Array<HTMLElement | null>>([]);
  const imagesRef = useRef<GalleryImg[]>([]);
  useEffect(() => { imagesRef.current = images; }, [images]);

  const loadGallery = useCallback(async () => {
    const d = await api<GalleryData>(`${base}/gallery`);
    setData(d);
    setImages(
      d.rows.map((r) => ({
        id: r[0] as string,
        filename: r[1] as string,
        thumb: r[2] as string,
        preview: r[3] as string,
        w: r[4] as number,
        h: r[5] as number,
        album: r[6] as number,
        selects: r[7] as number,
        mine: (r[8] as number) === 1,
        dup: (r[9] as number) === 1,
      })),
    );
    setSelectedBy(d.selectionsByReviewer ?? {});
    // An empty project has nothing to browse — go straight to adding photos.
    setMode((m) => (d.rows.length === 0 ? 'upload' : m === 'upload' ? 'browse' : m));
  }, [base]);

  useEffect(() => { void loadGallery(); }, [loadGallery]);

  /**
   * Optimistic: the heart fills on click and the request settles behind it.
   * A failure rolls the image back to exactly what it was rather than leaving a
   * selection that looks saved but isn't.
   */
  const toggle = useCallback(
    async (id: string) => {
      // Read current state from a ref, never from inside the setState updater:
      // the updater runs during render, not at call time, so anything it assigns
      // is still undefined on the next line.
      const previous = imagesRef.current.find((img) => img.id === id);
      if (!previous || !data) return;
      const wasSelected = previous.mine;
      const meId = data.me.id;

      const apply = (selected: boolean, count: number) => {
        setImages((list) => list.map((img) => (img.id === id ? { ...img, mine: selected, selects: count } : img)));
        setSelectedBy((m) => {
          const mine = new Set(m[meId] ?? []);
          if (selected) mine.add(id); else mine.delete(id);
          return { ...m, [meId]: [...mine] };
        });
      };

      apply(!wasSelected, previous.selects + (wasSelected ? -1 : 1));
      try {
        const res = await api<{ selected: boolean; count: number }>(
          `${base}/selections/${id}`,
          { method: wasSelected ? 'DELETE' : 'PUT' },
        );
        apply(res.selected, res.count);
      } catch {
        apply(previous.mine, previous.selects);
      }
    },
    [base, data],
  );

  const deleteImage = useCallback(async (id: string) => {
    await api(`/api/admin/images/${id}`, { method: 'DELETE' });
    setImages((list) => list.filter((img) => img.id !== id));
    setSelectedBy((m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.filter((x) => x !== id)])));
  }, []);

  const visible = useMemo(() => {
    switch (filter.kind) {
      case 'mine': return images.filter((i) => i.mine);
      case 'any': return images.filter((i) => i.selects > 0);
      case 'dup': return images.filter((i) => i.dup);
      case 'reviewer': {
        const ids = new Set(selectedBy[filter.id] ?? []);
        return images.filter((i) => ids.has(i.id));
      }
      default: return images;
    }
  }, [images, filter, selectedBy]);

  const byAlbum = useMemo(() => {
    const groups = new Map<number, GalleryImg[]>();
    for (const img of visible) {
      const list = groups.get(img.album);
      if (list) list.push(img);
      else groups.set(img.album, [img]);
    }
    return groups;
  }, [visible]);

  const albumTotals = useMemo(() => {
    const m = new Map<number, { n: number; mine: number }>();
    for (const img of images) {
      const t = m.get(img.album) ?? { n: 0, mine: 0 };
      t.n++;
      if (img.mine) t.mine++;
      m.set(img.album, t);
    }
    return m;
  }, [images]);

  const indexOf = useMemo(() => {
    const m = new Map<string, number>();
    visible.forEach((img, i) => m.set(img.id, i));
    return m;
  }, [visible]);

  // Keep the viewer on a real frame when the set under it shrinks (a delete, or
  // deselecting while filtered to "My selects").
  useEffect(() => {
    if (openIndex === null) return;
    if (visible.length === 0) setOpenIndex(null);
    else if (openIndex > visible.length - 1) setOpenIndex(visible.length - 1);
  }, [visible.length, openIndex]);

  // Highlight whichever album heading is nearest the top of the viewport.
  useEffect(() => {
    const onScroll = () => {
      let best = 0;
      sectionRefs.current.forEach((el, i) => {
        if (el && el.getBoundingClientRect().top <= 120) best = i;
      });
      setActiveAlbum(best);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [data]);

  // Space / F toggle the frame on screen, so a pass never needs the mouse.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (openIndex === null) return;
      if (e.key === ' ' || e.key.toLowerCase() === 'f') {
        const img = visible[openIndex];
        if (img) {
          e.preventDefault();
          void toggle(img.id);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openIndex, visible, toggle]);

  if (!data) return <div className="wrap"><p className="sub">Loading…</p></div>;

  const reviewers = data.reviewers.map((r) => ({ ...r, count: selectedBy[r.id]?.length ?? 0 }));
  const people = reviewers.filter((r) => r.count > 0);
  const mineCount = images.filter((i) => i.mine).length;
  const anyCount = images.filter((i) => i.selects > 0).length;
  const dupCount = images.filter((i) => i.dup).length;

  // Export follows the current filter: filtered to Alice, you export Alice's.
  const exportWho = filter.kind === 'mine' ? data.me.id : filter.kind === 'reviewer' ? filter.id : 'all';
  const exportLabel =
    exportWho === 'all' ? "Everyone's selects"
      : exportWho === data.me.id ? 'My selects'
        : `${reviewers.find((r) => r.id === exportWho)?.name ?? 'Their'}'s selects`;
  const exportCount = exportWho === 'all' ? anyCount : (selectedBy[exportWho]?.length ?? 0);
  const exportHref = (format: 'csv' | 'txt') =>
    `/api/admin/projects/${data.project.id}/export?format=${format}&reviewer=${exportWho}`;

  const albumTitle = data.albums.length === 1 && !admin && !data.project.slug ? data.albums[0]!.name : null;

  return (
    <div className="gallery">
      <aside className="side">
        {onBack && <button className="ghost" onClick={onBack}>← Projects</button>}
        <h2 className="side-title">{data.project.name}</h2>
        {albumTitle && <p className="meta" style={{ margin: '0 0 4px' }}>{albumTitle}</p>}
        <p className="meta" style={{ marginBottom: admin ? 4 : 20 }}>
          {images.length} images · {mineCount} yours · {anyCount} selected
        </p>
        {admin ? (
          <p className="meta" style={{ marginBottom: 20 }}>
            Selecting as {data.me.name} ·{' '}
            <button className="text-btn" onClick={async () => {
              const name = window.prompt('Your name, as reviewers and exports will show it:', data.me.name);
              if (!name?.trim()) return;
              await api(`/api/admin/projects/${data.project.id}/me`, { method: 'POST', body: JSON.stringify({ name }) });
              void loadGallery();
            }}>rename</button>
          </p>
        ) : null}

        <label>Show</label>
        <nav style={{ marginBottom: 20 }}>
          {([
            { key: 'all', label: 'All photos', n: images.length },
            { key: 'mine', label: 'My selects', n: mineCount },
            { key: 'any', label: "Everyone's selects", n: anyCount },
          ] as const).map((f) => (
            <button
              key={f.key}
              className={`side-link${filter.kind === f.key && mode !== 'stats' ? ' active' : ''}`}
              onClick={() => { setFilter({ kind: f.key }); setMode('browse'); }}
            >
              <span className="side-name">{f.label}</span>
              <span className="meta">{f.n}</span>
            </button>
          ))}
          {people.length > 0 && <div className="side-sub">People</div>}
          {people.map((r) => (
            <button
              key={r.id}
              className={`side-link${filter.kind === 'reviewer' && filter.id === r.id && mode !== 'stats' ? ' active' : ''}`}
              onClick={() => { setFilter({ kind: 'reviewer', id: r.id }); setMode('browse'); }}
            >
              <span className="side-name">
                {r.name}{r.isMe && <span className="you"> · you</span>}
              </span>
              <span className="meta">{r.count}</span>
            </button>
          ))}
          {admin && dupCount > 0 && (
            <button
              className={`side-link${filter.kind === 'dup' && mode !== 'stats' ? ' active' : ''}`}
              onClick={() => { setFilter({ kind: 'dup' }); setMode('browse'); }}
              title="Different files that point at the same RAW, or the same file uploaded twice"
            >
              <span className="side-name">Possible duplicates</span>
              <span className="meta">{dupCount}</span>
            </button>
          )}
          {admin && images.length > 0 && (
            <button
              className={`side-link${mode === 'stats' ? ' active' : ''}`}
              onClick={() => setMode(mode === 'stats' ? 'browse' : 'stats')}
            >
              <span className="side-name">Stats</span>
            </button>
          )}
        </nav>

        {admin && images.length > 0 && (
          <>
            <label>Export {exportLabel} ({exportCount})</label>
            <div className="export-row">
              <a href={exportHref('csv')} download aria-disabled={exportCount === 0}>CSV</a>
              <a href={exportHref('txt')} download aria-disabled={exportCount === 0}>Filenames</a>
            </div>
          </>
        )}

        <label>Albums</label>
        <nav>
          {data.albums.map((a, i) => {
            // Totals, not the filtered view: the sidebar is a map of the whole
            // shoot and shouldn't read "0" everywhere because a filter is active.
            const total = albumTotals.get(i) ?? { n: 0, mine: 0 };
            return (
              <button
                key={a.id}
                className={`side-link${activeAlbum === i && mode === 'browse' ? ' active' : ''}`}
                onClick={() => {
                  setMode('browse');
                  requestAnimationFrame(() =>
                    sectionRefs.current[i]?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
                }}
              >
                <span className="side-name">
                  {a.name}
                  {admin && a.shareToken && <span className="lock" title={a.hasPassword ? 'Client link, password protected' : 'Client link'}>{a.hasPassword ? '🔒' : '↗'}</span>}
                </span>
                <span className="meta">{total.mine > 0 ? `${total.mine}/${total.n}` : total.n}</span>
              </button>
            );
          })}
        </nav>

        {admin ? (
          <div className="side-foot">
            {(images.length > 0 || mode !== 'upload') && (
              <button className="ghost" style={{ width: '100%', marginBottom: 10 }}
                onClick={() => setMode(mode === 'upload' ? 'browse' : 'upload')}>
                {mode === 'upload' ? 'Back to photos' : '+ Add photos'}
              </button>
            )}
            {data.project.slug && (
              <>
                <label>Reviewer link · all albums</label>
                <CopyLink url={`${location.origin}/p/${data.project.slug}`} />
              </>
            )}
            <button
              className="ghost danger"
              onClick={async () => {
                const ok = window.confirm(
                  `Delete "${data.project.name}"?\n\n${data.albums.length} albums and ${images.length} images will be permanently removed, along with every selection. This cannot be undone.`,
                );
                if (!ok) return;
                await api(`/api/admin/projects/${data.project.id}`, { method: 'DELETE' });
                onBack?.();
              }}
            >
              Delete project
            </button>
          </div>
        ) : (
          <div className="side-foot">
            <p className="meta" style={{ margin: 0 }}>
              Reviewing as {data.me.name} ·{' '}
              <button className="text-btn" onClick={async () => {
                await api(`${base}/leave`, { method: 'POST' });
                location.reload();
              }}>not you?</button>
            </p>
          </div>
        )}
      </aside>

      <main className="main">
        {mode === 'upload' && (
          <div style={{ maxWidth: 600 }}>
            <h3 style={{ fontSize: 15, fontWeight: 500, margin: '8px 0 16px' }}>Add photos</h3>
            <Uploader
              projectId={data.project.id}
              projectName={data.project.name}
              previewEdge={data.project.previewEdge}
              onDone={() => { void loadGallery(); }}
            />
          </div>
        )}

        {mode === 'stats' && (
          <Stats albums={data.albums} images={images} reviewers={reviewers} selectedBy={selectedBy} />
        )}

        {mode === 'browse' && filter.kind !== 'all' && visible.length === 0 && (
          <p className="sub" style={{ padding: '24px 0' }}>
            {filter.kind === 'dup' ? 'No duplicates.' : 'Nothing selected yet.'}
          </p>
        )}
        {mode === 'browse' && data.albums.map((album, i) => {
          const list = byAlbum.get(i) ?? [];
          if (list.length === 0 && filter.kind !== 'all') return null;
          const picked = list.filter((x) => x.mine).length;
          return (
            <section key={album.id} ref={(el) => { sectionRefs.current[i] = el; }}>
              <header className="section-head">
                <h3>{album.name}</h3>
                <span className="meta">
                  {list.length} {list.length === 1 ? 'image' : 'images'}
                  {picked > 0 && ` · ${picked} selected`}
                </span>
                {admin && (
                  <span className="section-actions">
                    <button className="text-btn" onClick={() => setSharing(sharing === album.id ? null : album.id)}>
                      {album.shareToken ? 'Client link' : 'Share'}
                    </button>
                    <button className="text-btn danger" onClick={async () => {
                      const n = images.filter((x) => x.album === i).length;
                      if (!window.confirm(`Delete album "${album.name}" and its ${n} images? This cannot be undone.`)) return;
                      await api(`/api/admin/albums/${album.id}`, { method: 'DELETE' });
                      void loadGallery();
                    }}>Delete</button>
                  </span>
                )}
              </header>
              {admin && sharing === album.id && (
                <SharePanel
                  albumId={album.id}
                  state={album}
                  projectHasPassword={!!data.project.hasPassword}
                  onSaved={(s) => setData((d) => d && {
                    ...d,
                    albums: d.albums.map((a) => (a.id === album.id ? { ...a, ...s } : a)),
                  })}
                />
              )}
              <Grid
                images={list}
                onOpen={(localIndex) => {
                  const img = list[localIndex];
                  if (img) setOpenIndex(indexOf.get(img.id) ?? null);
                }}
                onToggle={toggle}
              />
            </section>
          );
        })}
      </main>

      {openIndex !== null && visible[openIndex] && (
        <Viewer
          images={visible}
          index={openIndex}
          onIndex={setOpenIndex}
          onClose={() => setOpenIndex(null)}
          onToggle={toggle}
          onDelete={admin ? deleteImage : undefined}
          albumName={data.albums[visible[openIndex]!.album]?.name}
        />
      )}
    </div>
  );
}
