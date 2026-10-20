import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from './api';
import Grid, { type Img } from './Grid';
import Viewer from './Viewer';
import type { Note, NotesApi } from './NotesPanel';
import Uploader from './Uploader';
import { selectedByEveryone, ACTIVE_SHARE, MIN_ACTIVE } from '../../shared/everyone';
import SharePanel, { type ShareState } from './SharePanel';
import Stats from './Stats';
import CopyLink from './CopyLink';
import Logo from './Logo';
import { useNoZoom } from './useNoZoom';
import { downloadOne, downloadZip } from './download';
import type { ProjectNote } from './retouchSheet';
import { talentFromFilename } from '../../shared/names';

export interface GalleryImg extends Img {
  album: number;
  selects: number;
  mine: boolean;
  dup: boolean;
}

interface Album extends ShareState { id: string; name: string; slug: string }
interface Reviewer { id: string; name: string; isMe: boolean; count: number; lastSeen?: number; hidden?: boolean }

interface GalleryData {
  project: {
    id: string; name: string; slug: string | null; previewEdge: number;
    hasPassword?: boolean; coverImageId?: string | null;
    /** Whether reviewers get download buttons. The owner always does. */
    allowDownloads: boolean;
    /** A casting shows people: names under photos, portfolio links, a brief. */
    kind: 'shoot' | 'casting';
    brief: string | null;
  };
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
  /** Selected by two or more different people. */
  | { kind: 'agreed' }
  /** Selected by every active reviewer (see shared/everyone.ts). */
  | { kind: 'everyone' }
  /** Frames with retouch notes. */
  | { kind: 'notes' }
  | { kind: 'dup' }
  | { kind: 'reviewer'; id: string };

/** ?show=mine | all | 2plus | everyone | duplicates | stats, or ?person=<id>. Absent means all photos. */
function viewFromUrl(): { filter: Filter; stats: boolean } {
  const q = new URLSearchParams(location.search);
  const person = q.get('person');
  if (person) return { filter: { kind: 'reviewer', id: person }, stats: false };
  switch (q.get('show')) {
    case 'mine': return { filter: { kind: 'mine' }, stats: false };
    case 'all': return { filter: { kind: 'any' }, stats: false };
    case '2plus': return { filter: { kind: 'agreed' }, stats: false };
    case 'everyone': return { filter: { kind: 'everyone' }, stats: false };
    case 'notes': return { filter: { kind: 'notes' }, stats: false };
    case 'duplicates': return { filter: { kind: 'dup' }, stats: false };
    case 'stats': return { filter: { kind: 'all' }, stats: true };
    default: return { filter: { kind: 'all' }, stats: false };
  }
}

function viewToQuery(filter: Filter, stats: boolean): string {
  if (stats) return '?show=stats';
  switch (filter.kind) {
    case 'mine': return '?show=mine';
    case 'any': return '?show=all';
    case 'agreed': return '?show=2plus';
    case 'everyone': return '?show=everyone';
    case 'notes': return '?show=notes';
    case 'dup': return '?show=duplicates';
    case 'reviewer': return `?person=${filter.id}`;
    default: return '';
  }
}

/** Selected by two or more people. U+FE0E keeps the heart a text glyph, not a red emoji, on iOS. */
const AGREED = '\u2665\uFE0E\u2665\uFE0E+';
const AGREED_WORDS = 'Selected by 2 or more people';
const EVERYONE_WORDS =
  `Selected by everyone — counting only people who've selected at least ${ACTIVE_SHARE * 100}% of the photos`;

/** Who's in a casting photo: the name given, or one made from the filename. */
const talentName = (img: { name?: string | null; filename: string }) => img.name || talentFromFilename(img.filename);

const scrollKey = () => `review-scroll:${location.pathname}${location.search}`;

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

  // Full screen gets its own history entry, so Back (the button, or an edge
  // swipe on a phone) closes it instead of leaving the gallery.
  const openViewer = useCallback((i: number) => {
    if (!history.state?.viewer) history.pushState({ ...history.state, viewer: true }, '');
    setOpenIndex(i);
  }, []);
  // history.back() is async: a second close before popstate lands (Escape and a
  // click together) would step back twice, out of the gallery.
  const closing = useRef(false);
  const closeViewer = useCallback(() => {
    if (closing.current) return;
    if (history.state?.viewer) {
      closing.current = true;
      history.back(); // popstate below does the closing
    } else setOpenIndex(null);
  }, []);
  useEffect(() => {
    // A refresh while full screen leaves the marker behind with nothing open.
    if (history.state?.viewer) history.replaceState({ ...history.state, viewer: false }, '');
    const onPop = () => {
      closing.current = false;
      if (!history.state?.viewer) setOpenIndex(null);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const [activeAlbum, setActiveAlbum] = useState(0);
  useNoZoom();
  const [initialView] = useState(viewFromUrl);
  const [arrival] = useState(() => {
    const q = new URLSearchParams(location.search);
    return { shared: q.get('shared') === '1', album: q.get('album') };
  });
  const [shareNote, setShareNote] = useState(arrival.shared && !admin);
  const [copiedAlbum, setCopiedAlbum] = useState<string | null>(null);
  const [mode, setMode] = useState<'browse' | 'upload' | 'stats'>(initialView.stats ? 'stats' : 'browse');
  const [filter, setFilter] = useState<Filter>(initialView.filter);
  const restored = useRef(false);
  const holdUpload = useRef(false);
  const [selectedBy, setSelectedBy] = useState<Record<string, string[]>>({});
  const [sharing, setSharing] = useState<string | null>(null);
  const [dl, setDl] = useState<{ done: number; total: number; label: string; error?: string; doneText?: string } | null>(null);
  const [sheetResolved, setSheetResolved] = useState(false);
  const dlAbort = useRef<AbortController | null>(null);
  /** Phones: the sidebar lives behind this full-screen menu. */
  const [menuOpen, setMenuOpen] = useState(false);
  const [c1Help, setC1Help] = useState(false);
  /** Casting: narrow the view to names containing this. */
  const [query, setQuery] = useState('');
  const [editingBrief, setEditingBrief] = useState<string | null>(null);
  const sectionRefs = useRef<Array<HTMLElement | null>>([]);
  const sideRef = useRef<HTMLElement | null>(null);
  const imagesRef = useRef<GalleryImg[]>([]);
  useEffect(() => { imagesRef.current = images; }, [images]);

  const [loadError, setLoadError] = useState('');

  /** The owner removed this reviewer: start over at the join screen. */
  const onRemoved = useCallback((err: unknown) => {
    if (!admin && err instanceof ApiError && err.status === 401) {
      location.reload();
      return true;
    }
    return false;
  }, [admin]);

  const loadGallery = useCallback(async () => {
    let d: GalleryData;
    try {
      d = await api<GalleryData>(`${base}/gallery`);
    } catch (err) {
      if (onRemoved(err)) return;
      setLoadError(err instanceof ApiError && err.status === 404
        ? 'This project no longer exists.'
        : 'Could not load the gallery. Check your connection and reload.');
      return;
    }
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
        name: (r[10] as string | null) ?? null,
        link: (r[11] as string | null) ?? null,
        info: (r[12] as string | null) ?? null,
        notes: (r[13] as number) ?? 0,
        notesOpen: (r[14] as number) ?? 0,
      })),
    );
    setSelectedBy(d.selectionsByReviewer ?? {});
    // An empty project has nothing to browse — go straight to adding photos.
    // Only the owner is sent to the uploader when there's nothing to show.
    // After an upload with failures, stay put: leaving would throw away the list of
    // what failed and the button that retries it.
    setMode((m) => (d.rows.length === 0 && admin ? 'upload' : m === 'upload' && !holdUpload.current ? 'browse' : m));
  }, [base, onRemoved, admin]);

  useEffect(() => { void loadGallery(); }, [loadGallery]);

  // Always open the menu at the top, where the filters are. It has to happen once
  // the menu is displayed: a hidden element ignores scrollTop, and the browser
  // otherwise brings back wherever it was last scrolled to.
  useLayoutEffect(() => {
    if (menuOpen && sideRef.current) sideRef.current.scrollTop = 0;
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const html = document.documentElement;
    const prevBody = document.body.style.overflow;
    const prevHtml = html.style.overflow;
    document.body.style.overflow = 'hidden';
    html.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prevBody;
      html.style.overflow = prevHtml;
      window.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  // A saved ?person= link for someone since removed or hidden: fall back to everything.
  useEffect(() => {
    if (data && filter.kind === 'reviewer' && !data.reviewers.some((r) => r.id === filter.id)) {
      setFilter({ kind: 'all' });
    }
  }, [data, filter]);

  useEffect(() => {
    if (mode === 'upload') return;
    const query = viewToQuery(filter, mode === 'stats');
    if (location.search !== query) history.replaceState(history.state, '', location.pathname + query);
  }, [filter, mode]);

  // Remember scroll position per view, and put it back after a refresh. The
  // grids size themselves after first render, so retry until the page is tall
  // enough to scroll to the saved spot.
  useEffect(() => {
    let t = 0;
    const save = () => {
      clearTimeout(t);
      t = window.setTimeout(() => {
        try { sessionStorage.setItem(scrollKey(), String(Math.round(window.scrollY))); } catch { /* private mode */ }
      }, 150);
    };
    window.addEventListener('scroll', save, { passive: true });
    return () => { window.removeEventListener('scroll', save); clearTimeout(t); };
  }, []);

  useEffect(() => {
    if (restored.current || !data || images.length === 0 || !arrival.album) return;
    const i = data.albums.findIndex((a) => a.slug === arrival.album);
    if (i < 0) return;
    restored.current = true;
    let tries = 0;
    const land = () => {
      const el = sectionRefs.current[i];
      if (el && el.getBoundingClientRect().height > 0) {
        el.scrollIntoView({ block: 'start' });
        // Let the sidebar highlight catch up with where we landed.
        window.dispatchEvent(new Event('scroll'));
      } else if (tries++ < 20) setTimeout(land, 50);
    };
    setTimeout(land, 0);
  }, [data, images.length, arrival.album]);

  // Browsing away from what was shared retires the note.
  useEffect(() => {
    if (JSON.stringify(filter) !== JSON.stringify(initialView.filter)) setShareNote(false);
  }, [filter, initialView.filter]);

  useEffect(() => {
    if (restored.current || images.length === 0 || mode !== 'browse') return;
    restored.current = true;
    let target = 0;
    try { target = Number(sessionStorage.getItem(scrollKey()) ?? 0); } catch { /* private mode */ }
    if (!target) return;
    let tries = 0;
    const attempt = () => {
      if (document.documentElement.scrollHeight >= target + window.innerHeight || tries++ > 20) {
        window.scrollTo(0, target);
      } else {
        setTimeout(attempt, 50);
      }
    };
    setTimeout(attempt, 0);
  }, [images.length, mode]);

  /**
   * Optimistic: the heart fills on click and the request settles behind it.
   * A failure rolls the image back to exactly what it was rather than leaving a
   * selection that looks saved but isn't.
   */
  /**
   * Heart toggles, per frame, are optimistic and strictly ordered.
   *
   * The heart flips on click; the request follows. Requests for the same frame
   * are chained, so a quick on-off (a double-click, fast taps) reaches the server
   * in the order it happened, and only the latest request's answer is applied —
   * an earlier one arriving late can't flip the heart back to a stale state.
   * State is read from a ref updated in the same tick, never from inside a
   * setState updater, which runs later and would see yesterday's value.
   */
  /** Retouch notes for the viewer; the same paths work for the owner and reviewers. */
  const notesApi = useMemo<NotesApi>(() => {
    type R = { notes: Note[] };
    return {
      list: (imageId) => api<R>(`${base}/images/${imageId}/notes`).then((r) => r.notes),
      add: (imageId, input, opts) =>
        api<R>(`${base}/images/${imageId}/notes`, { method: 'POST', body: JSON.stringify(input), keepalive: opts?.keepalive })
          .then((r) => r.notes),
      resolve: (noteId, resolved) =>
        api<R>(`${base}/notes/${noteId}/resolve`, { method: 'POST', body: JSON.stringify({ resolved }) }).then((r) => r.notes),
      remove: (noteId) => api<R>(`${base}/notes/${noteId}`, { method: 'DELETE' }).then((r) => r.notes),
    };
  }, [base]);

  const onNotesChanged = useCallback((imageId: string, all: number, open: number) => {
    const patch = (img: GalleryImg) => (img.id === imageId ? { ...img, notes: all, notesOpen: open } : img);
    if (!imagesRef.current.some((img) => img.id === imageId && (img.notes !== all || img.notesOpen !== open))) return;
    imagesRef.current = imagesRef.current.map(patch);
    setImages((list) => list.map(patch));
  }, []);

  const inflight = useRef(new Map<string, { chain: Promise<unknown>; seq: number }>());
  const toggle = useCallback(
    (id: string) => {
      const current = imagesRef.current.find((img) => img.id === id);
      if (!current || !data) return;
      const want = !current.mine;
      const meId = data.me.id;

      const apply = (selected: boolean, count: number) => {
        imagesRef.current = imagesRef.current.map((img) =>
          img.id === id ? { ...img, mine: selected, selects: count } : img);
        setImages((list) => list.map((img) => (img.id === id ? { ...img, mine: selected, selects: count } : img)));
        setSelectedBy((m) => {
          const mine = new Set(m[meId] ?? []);
          if (selected) mine.add(id); else mine.delete(id);
          return { ...m, [meId]: [...mine] };
        });
      };

      const before = { mine: current.mine, selects: current.selects };
      apply(want, Math.max(0, current.selects + (want ? 1 : -1)));

      const entry = inflight.current.get(id) ?? { chain: Promise.resolve(), seq: 0 };
      const seq = entry.seq + 1;
      const isLatest = () => inflight.current.get(id)?.seq === seq;
      const chain = entry.chain.then(async () => {
        try {
          const res = await api<{ selected: boolean; count: number }>(
            `${base}/selections/${id}`,
            { method: want ? 'PUT' : 'DELETE' },
          );
          if (isLatest()) apply(res.selected, res.count);
        } catch (err) {
          if (isLatest()) apply(before.mine, before.selects);
          onRemoved(err);
        }
      });
      inflight.current.set(id, { chain, seq });
    },
    [base, data, onRemoved],
  );

  const deleteImage = useCallback(async (id: string) => {
    await api(`/api/admin/images/${id}`, { method: 'DELETE' });
    setImages((list) => list.filter((img) => img.id !== id));
    setSelectedBy((m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.filter((x) => x !== id)])));
    // Duplicate flags are computed across the project on the server; deleting one
    // of a pair un-flags the survivor, so refresh rather than guess.
    void loadGallery();
  }, [loadGallery]);

  const everyone = useMemo(() => selectedByEveryone(selectedBy, images.length), [selectedBy, images.length]);

  const byFilter = useMemo(() => {
    switch (filter.kind) {
      case 'mine': return images.filter((i) => i.mine);
      case 'any': return images.filter((i) => i.selects > 0);
      case 'agreed': return images.filter((i) => i.selects >= 2);
      case 'everyone': return images.filter((i) => everyone.ids.has(i.id));
      case 'notes': return images.filter((i) => (i.notes ?? 0) > 0);
      case 'dup': return images.filter((i) => i.dup);
      case 'reviewer': {
        const ids = new Set(selectedBy[filter.id] ?? []);
        return images.filter((i) => ids.has(i.id));
      }
      default: return images;
    }
  }, [images, filter, selectedBy, everyone]);

  const casting = data?.project.kind === 'casting';
  // Casting: the name search narrows whatever filter is on.
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!casting || !q) return byFilter;
    return byFilter.filter((i) => talentName(i).toLowerCase().includes(q));
  }, [byFilter, casting, query]);

  const byAlbum = useMemo(() => {
    const groups = new Map<number, GalleryImg[]>();
    for (const img of visible) {
      const list = groups.get(img.album);
      if (list) list.push(img);
      else groups.set(img.album, [img]);
    }
    return groups;
  }, [visible]);

  /** Reviewer ids that picked each frame; follows your own clicks instantly. */
  const pickersByImage = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const [rid, ids] of Object.entries(selectedBy)) {
      for (const id of ids) (m.get(id) ?? m.set(id, []).get(id)!).push(rid);
    }
    return m;
  }, [selectedBy]);

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
    if (visible.length === 0) closeViewer();
    else if (openIndex > visible.length - 1) setOpenIndex(visible.length - 1);
  }, [visible.length, openIndex, closeViewer]);

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
      // Typing a note: those keys are letters, not shortcuts.
      if ((e.target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
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

  if (!data) {
    return (
      <div className="wrap">
        <p className="sub">{loadError || 'Loading…'}</p>
        {loadError && onBack && <button className="ghost" onClick={onBack}>← Projects</button>}
      </div>
    );
  }

  const reviewers = data.reviewers.map((r) => ({ ...r, count: selectedBy[r.id]?.length ?? 0 }));
  const people = reviewers.filter((r) => r.count > 0);
  const mineCount = images.filter((i) => i.mine).length;
  const anyCount = images.filter((i) => i.selects > 0).length;
  const agreedCount = images.filter((i) => i.selects >= 2).length;
  const everyoneCount = everyone.ids.size;
  const notesCount = images.filter((i) => (i.notes ?? 0) > 0).length;
  const dupCount = images.filter((i) => i.dup).length;

  // Export follows the current filter: filtered to Alice, you export Alice's.
  const exportWho = filter.kind === 'mine' ? data.me.id : filter.kind === 'reviewer' ? filter.id : 'all';
  const exportAgreed = filter.kind === 'agreed';
  const exportEveryone = filter.kind === 'everyone';
  const exportLabel =
    exportAgreed ? AGREED
      : exportEveryone ? 'Everyone'
      : exportWho === 'all' ? 'All selects'
      : exportWho === data.me.id ? 'My selects'
        : `${reviewers.find((r) => r.id === exportWho)?.name ?? 'Their'}'s selects`;
  const exportCount = exportAgreed ? agreedCount : exportEveryone ? everyoneCount : exportWho === 'all' ? anyCount : (selectedBy[exportWho]?.length ?? 0);
  const exportHref = (format: 'csv' | 'txt') =>
    `/api/admin/projects/${data.project.id}/export?format=${format}&reviewer=${exportWho}${exportAgreed ? '&min=2' : ''}${exportEveryone ? '&everyone=1' : ''}`;

  /** What the download control acts on, as a phrase: "all photos", "Alice's selects". */
  const downloadPhrase =
    filter.kind === 'mine' ? 'my selects'
      : filter.kind === 'any' ? 'all selects'
        : filter.kind === 'agreed' ? AGREED
        : filter.kind === 'everyone' ? "everyone's selects"
        : filter.kind === 'notes' ? 'photos with notes'
        : filter.kind === 'dup' ? 'possible duplicates'
          : filter.kind === 'reviewer' ? `${reviewers.find((r) => r.id === filter.id)?.name ?? 'their'}'s selects`
            : 'all photos';
  const capitalised = downloadPhrase.charAt(0).toUpperCase() + downloadPhrase.slice(1);
  const canDownload = admin || data.project.allowDownloads;

  const startZip = async () => {
    if (dl && !dl.error && dl.done < dl.total) return;
    const items = visible.map((img) => ({
      filename: img.filename, preview: img.preview, album: data.albums[img.album]?.name ?? 'Photos',
    }));
    const controller = new AbortController();
    dlAbort.current = controller;
    setDl({ done: 0, total: items.length, label: downloadPhrase });
    try {
      await downloadZip(items, `${data.project.name} - ${filter.kind === 'agreed' ? 'Selected by 2+' : capitalised}`,
        (done, total) => setDl((d) => d && { ...d, done, total }), controller.signal);
      setDl((d) => d && { ...d, done: d.total });
      setTimeout(() => setDl((d) => (d && d.done >= d.total && !d.error ? null : d)), 2500);
    } catch (err) {
      if ((err as Error).name === 'AbortError') setDl(null);
      else setDl((d) => d && { ...d, error: (err as Error).message });
    }
  };

  /** Owner, casting: name, portfolio link and status line for one photo. */
  const editDetails = async (img: { id: string; name?: string | null; filename: string; link?: string | null; info?: string | null }) => {
    const name = window.prompt('Name:', talentName(img));
    if (name === null) return;
    const link = window.prompt('Portfolio link (leave empty for none):', img.link ?? '');
    if (link === null) return;
    const info = window.prompt('Status, e.g. "1st option · Nov 17–18" (leave empty for none):', img.info ?? '');
    if (info === null) return;
    try {
      await api(`/api/admin/images/${img.id}/details`, {
        method: 'POST', body: JSON.stringify({ name, link, info }),
      });
    } catch (err) {
      window.alert((err as Error).message);
      return;
    }
    const patch = { name: name.trim() || null, link: link.trim() || null, info: info.trim() || null };
    imagesRef.current = imagesRef.current.map((x) => (x.id === img.id ? { ...x, ...patch } : x));
    setImages((list) => list.map((x) => (x.id === img.id ? { ...x, ...patch } : x)));
  };

  /** Owner: the retouch sheet for the photos with notes in the current view. */
  const sheetFrames = visible.filter((i) => (i.notes ?? 0) > 0 && (sheetResolved || (i.notesOpen ?? 0) > 0));
  const startSheet = async (format: 'pdf' | 'zip') => {
    if (dl && !dl.error && dl.done < dl.total) return;
    const controller = new AbortController();
    dlAbort.current = controller;
    setDl({ done: 0, total: sheetFrames.length, label: 'retouch sheet' });
    try {
      // Loaded on demand: the PDF library is big and most visits never need it.
      const [{ makeRetouchSheet }, { notes }] = await Promise.all([
        import('./retouchSheet'),
        api<{ notes: ProjectNote[] }>(`/api/admin/projects/${data.project.id}/notes`),
      ]);
      const n = await makeRetouchSheet({
        format,
        project: data.project.name,
        frames: sheetFrames.map((i) => ({ id: i.id, filename: i.filename, preview: i.preview, album: data.albums[i.album]?.name ?? 'Photos' })),
        notes,
        includeResolved: sheetResolved,
        onProgress: (done, total) => setDl((d) => d && { ...d, done, total }),
        signal: controller.signal,
      });
      setDl((d) => d && { ...d, done: d.total, doneText: `Retouch sheet ready · ${n} ${n === 1 ? 'photo' : 'photos'}` });
      setTimeout(() => setDl((d) => (d && d.done >= d.total && !d.error ? null : d)), 3000);
    } catch (err) {
      if ((err as Error).name === 'AbortError') setDl(null);
      else setDl((d) => d && { ...d, error: (err as Error).message });
    }
  };

  const downloadFrame = (img: { filename: string; preview: string }) => {
    downloadOne(img).catch((err) =>
      setDl({ done: 0, total: 1, label: img.filename, error: (err as Error).message }));
  };

  const downloadButton = canDownload && mode === 'browse' && visible.length > 0 ? (
          <button className="ghost download-btn closes-menu" onClick={() => void startZip()}
            disabled={!!dl && !dl.error && dl.done < dl.total}>
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path d="M8 2v8M4.5 6.5 8 10l3.5-3.5M3 13.5h10" fill="none" stroke="currentColor"
                strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="side-name">Download {downloadPhrase}</span>
            <span className="meta">{visible.length}</span>
          </button>
  ) : null;

  const shareBase = data.project.slug ? `${location.origin}/p/${data.project.slug}` : null;
  /** The reviewer link for the current view: where a client lands when they open it. */
  const shareTarget: { url: string; label: string; hiddenPerson?: boolean } | null = (() => {
    if (!shareBase) return null;
    const personLink = (id: string) => {
      const r = reviewers.find((x) => x.id === id);
      return { url: `${shareBase}?person=${id}&shared=1`, label: `${r?.name ?? 'their'}'s selects`, hiddenPerson: !!r?.hidden };
    };
    if (mode !== 'browse') return { url: shareBase, label: 'all photos' };
    switch (filter.kind) {
      case 'mine': return personLink(data.me.id);
      case 'reviewer': return personLink(filter.id);
      case 'any': return { url: `${shareBase}?show=all&shared=1`, label: 'all selects' };
      case 'agreed': return { url: `${shareBase}?show=2plus&shared=1`, label: AGREED };
      case 'everyone': return { url: `${shareBase}?show=everyone&shared=1`, label: "everyone's selects" };
      default: return { url: shareBase, label: 'all photos' };
    }
  })();

  /** For the person who opened a shared link: what they were sent. */
  const sharedLabel = (() => {
    if (!shareNote) return null;
    if (arrival.album) return data.albums.find((a) => a.slug === arrival.album)?.name ?? null;
    const f = initialView.filter;
    if (f.kind === 'reviewer') {
      const r = reviewers.find((x) => x.id === f.id);
      return r ? `${r.name}'s selects` : null;
    }
    if (f.kind === 'any') return 'All selects';
    if (f.kind === 'agreed') return AGREED;
    if (f.kind === 'everyone') return 'Everyone';
    return null;
  })();

  const viewLabel =
    mode === 'stats' ? 'People & stats'
      : mode === 'upload' ? 'Add photos'
        : filter.kind === 'mine' ? 'My selects'
          : filter.kind === 'any' ? 'All selects'
            : filter.kind === 'agreed' ? AGREED
            : filter.kind === 'everyone' ? 'Everyone'
            : filter.kind === 'notes' ? 'Notes'
            : filter.kind === 'dup' ? 'Possible duplicates'
              : filter.kind === 'reviewer' ? (reviewers.find((r) => r.id === filter.id)?.name ?? 'Selects')
                : 'All photos';
  const viewCount = mode === 'browse' ? visible.length : null;

  const albumTitle = data.albums.length === 1 && !admin && !data.project.slug ? data.albums[0]!.name : null;

  return (
    <div
      className={`gallery${canDownload ? '' : ' no-save'}`}
      onContextMenu={canDownload ? undefined : (e) => {
        if ((e.target as HTMLElement).tagName === 'IMG') e.preventDefault();
      }}
    >
      <div className="mobile-bar">
        <Logo width={112} />
        <button className="mobile-menu" aria-expanded={menuOpen} aria-label={`Menu: ${viewLabel}`}
          onClick={() => setMenuOpen(true)}>
          <span className="mobile-menu-label">{viewLabel}</span>
          {viewCount !== null && <span className="meta">{viewCount}</span>}
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <rect x="2" y="3" width="12" height="2" rx="1" />
            <rect x="2" y="7" width="12" height="2" rx="1" />
            <rect x="2" y="11" width="12" height="2" rx="1" />
          </svg>
        </button>
      </div>

      <aside
        ref={sideRef}
        className={`side${menuOpen ? ' open' : ''}`}
        // On a phone, choosing where to go closes the menu; utility buttons
        // (rename, copy link, delete) leave it open.
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('.side-link, .closes-menu')) setMenuOpen(false);
        }}
      >
        <button className="side-close" aria-label="Close menu" onClick={() => setMenuOpen(false)}>×</button>
        <Logo width={116} style={{ margin: '4px 0 22px' }} />
        {onBack && <button className="ghost" onClick={onBack}>← Projects</button>}
        <h2 className="side-title">{data.project.name}</h2>
        {albumTitle && <p className="meta" style={{ margin: '0 0 4px' }}>{albumTitle}</p>}
        {!admin && <div style={{ height: 16 }} />}
        {admin ? (
          <p className="meta" style={{ marginBottom: 20 }}>
            Reviewing as {data.me.name} ·{' '}
            <button className="text-btn" onClick={async () => {
              const name = window.prompt('Your name, as reviewers and exports will show it:', data.me.name);
              if (!name?.trim()) return;
              await api(`/api/admin/projects/${data.project.id}/me`, { method: 'POST', body: JSON.stringify({ name }) });
              void loadGallery();
            }}>rename</button>
          </p>
        ) : null}

        {casting && images.length > 0 && (
          <input
            className="find"
            type="search"
            placeholder="Find a name"
            aria-label="Find a name"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setMode('browse'); }}
          />
        )}
        <label>Show</label>
        <nav style={{ marginBottom: 20 }}>
          {([
            { key: 'all', label: casting ? 'All talent' : 'All photos', n: images.length },
            { key: 'mine', label: 'My selects', n: mineCount },
            { key: 'any', label: 'All selects', n: anyCount },
            { key: 'agreed', label: AGREED, n: agreedCount, title: AGREED_WORDS },
            { key: 'everyone', label: 'Everyone', n: everyoneCount, title: EVERYONE_WORDS },
            { key: 'notes', label: 'Notes', n: notesCount, title: 'Photos with retouch notes' },
          ] as const).map((f) => (
            <button
              key={f.key}
              title={'title' in f ? f.title : undefined}
              aria-label={'title' in f ? `${f.title}, ${f.n}` : undefined}
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
                {admin && r.hidden && <span className="you" title="Hidden from other reviewers"> · hidden</span>}
              </span>
              <span className="meta">{r.count}</span>
            </button>
          ))}
          {admin && !casting && dupCount > 0 && (
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
              <span className="side-name">People &amp; stats</span>
            </button>
          )}
        </nav>

        {admin && images.length > 0 && casting && (
          <>
            <label>Shortlist · {exportLabel} ({exportCount})</label>
            <div className="export-row">
              <a href={exportHref('csv')} download aria-disabled={exportCount === 0}
                title="Name, agency, portfolio, status and who picked them — opens in Numbers or Excel">
                Download shortlist
              </a>
            </div>
            <p className="meta export-more">
              <a href={exportHref('txt')} download aria-disabled={exportCount === 0}>Names only</a>
            </p>
          </>
        )}
        {admin && images.length > 0 && !casting && (
          <>
            <label>Capture One · {exportLabel} ({exportCount})</label>
            <div className="export-row">
              <a href={exportHref('csv')} download aria-disabled={exportCount === 0}
                title="Downloads a file for Scripts → Import Review Selects in Capture One">
                Send to Capture One
              </a>
            </div>
            <p className="meta export-more">
              <a href={exportHref('txt')} download aria-disabled={exportCount === 0}>Filenames only</a>
              {' · '}
              <button className="text-btn" aria-expanded={c1Help} onClick={() => setC1Help((v) => !v)}>
                {c1Help ? 'Hide script setup' : 'Get the script'}
              </button>
            </p>
            {c1Help && (
              <div className="meta c1-help">
                <p>Once per computer:</p>
                <ol>
                  <li>
                    <a href="/capture-one/import-review-selects.scpt" download="Import Review Selects.scpt">
                      Download the script
                    </a>
                  </li>
                  <li>In Capture One, choose Scripts → Open Scripts Folder and drag it in</li>
                  <li>Choose Scripts → Update Scripts Menu</li>
                </ol>
                <p>Then each time: Send to Capture One here, and in Capture One choose
                  Scripts → Import Review Selects and pick the file you just downloaded.</p>
              </div>
            )}
          </>
        )}

        {admin && notesCount > 0 && (
          <>
            <label title="Each photo with its marks drawn on and its notes numbered beside it">
              Retouch sheet · {sheetFrames.length} {sheetFrames.length === 1 ? 'photo' : 'photos'}
            </label>
            <div className="export-row">
              <button className="export-btn" disabled={sheetFrames.length === 0 || (!!dl && !dl.error && dl.done < dl.total)}
                title="One page per photo: the photo with its marks, notes beside it"
                onClick={() => void startSheet('pdf')}>PDF</button>
              <button className="export-btn" disabled={sheetFrames.length === 0 || (!!dl && !dl.error && dl.done < dl.total)}
                title="Each photo as a JPEG with its marks drawn on, plus a text file of the notes"
                onClick={() => void startSheet('zip')}>Marked JPEGs</button>
            </div>
            <label className="radio setting" style={{ marginTop: -10 }}>
              <input type="checkbox" checked={sheetResolved} onChange={(e) => setSheetResolved(e.target.checked)} />
              <span>Include resolved notes</span>
            </label>
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
                  // After this render: the section exists again, and on a phone the
                  // menu has closed and released its scroll lock.
                  setTimeout(() =>
                    sectionRefs.current[i]?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
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
            {downloadButton}
            {(images.length > 0 || mode !== 'upload') && (
              <button className="ghost closes-menu" style={{ width: '100%', marginBottom: 10 }}
                onClick={() => setMode(mode === 'upload' ? 'browse' : 'upload')}>
                {mode === 'upload' ? 'Back to photos' : '+ Add photos'}
              </button>
            )}
            {data.project.slug && (
              <>
                <label>Reviewer link · opens on {shareTarget?.label}</label>
                <CopyLink url={shareTarget?.url ?? `${location.origin}/p/${data.project.slug}`} />
                {shareTarget?.hiddenPerson && (
                  <p className="meta" style={{ margin: '-10px 0 16px' }}>
                    This person is hidden from reviewers, so the link opens on all photos.
                  </p>
                )}
              </>
            )}
            <label className="radio setting">
              <input
                type="checkbox"
                checked={data.project.allowDownloads}
                onChange={async (e) => {
                  const allowDownloads = e.target.checked;
                  setData((d) => d && { ...d, project: { ...d.project, allowDownloads } });
                  try {
                    await api(`/api/admin/projects/${data.project.id}/settings`, {
                      method: 'POST', body: JSON.stringify({ allowDownloads }),
                    });
                  } catch {
                    setData((d) => d && { ...d, project: { ...d.project, allowDownloads: !allowDownloads } });
                  }
                }}
              />
              <span>Reviewers can download</span>
            </label>
            <label className="radio setting" title="Names under photos, portfolio links, a brief and a shortlist export">
              <input
                type="checkbox"
                checked={casting}
                onChange={async (e) => {
                  const kind = e.target.checked ? 'casting' : 'shoot';
                  const before = data.project.kind;
                  setData((d) => d && { ...d, project: { ...d.project, kind } });
                  try {
                    await api(`/api/admin/projects/${data.project.id}/settings`, {
                      method: 'POST', body: JSON.stringify({ kind }),
                    });
                    void loadGallery();
                  } catch {
                    setData((d) => d && { ...d, project: { ...d.project, kind: before } });
                  }
                }}
              />
              <span>Casting project</span>
            </label>

            <button
              className="ghost danger"
              style={{ marginBottom: 10 }}
              onClick={async () => {
                const others = reviewers.filter((r) => !r.isMe).length;
                const picks = Object.values(selectedBy).reduce((n, ids) => n + ids.length, 0);
                // Two steps: say exactly what goes, then make them type it.
                const first = window.confirm(
                  `Reset "${data.project.name}"?\n\n` +
                  `• ${picks} ${picks === 1 ? 'select' : 'selects'} will be cleared, including yours\n` +
                  `• ${others} ${others === 1 ? 'reviewer' : 'reviewers'} will be removed (you stay), with their notes\n\n` +
                  `Photos, albums, your notes, client links and settings are kept. This cannot be undone.`,
                );
                if (!first) return;
                const typed = window.prompt('To confirm, type RESET');
                if (typed?.trim().toUpperCase() !== 'RESET') return;
                await api(`/api/admin/projects/${data.project.id}/reset`, {
                  method: 'POST', body: JSON.stringify({ confirm: 'RESET' }),
                });
                setFilter({ kind: 'all' });
                void loadGallery();
              }}
            >
              Reset selects &amp; reviewers
            </button>

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
            {downloadButton}
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
              onDone={(failed) => { holdUpload.current = failed > 0; void loadGallery(); }}
            />
          </div>
        )}

        {mode === 'stats' && (
          <Stats
            albums={data.albums}
            images={images}
            reviewers={reviewers}
            selectedBy={selectedBy}
            onHide={async (id, hidden) => {
              await api(`/api/admin/reviewers/${id}/hidden`, { method: 'POST', body: JSON.stringify({ hidden }) });
              void loadGallery();
            }}
            onRemove={async (r) => {
              const ok = window.confirm(
                `Remove ${r.name}?\n\nTheir ${r.count} ${r.count === 1 ? 'select is' : 'selects are'} deleted permanently, along with their notes. ` +
                `If they open the link again they start from scratch — to keep them out, change the password.`,
              );
              if (!ok) return;
              await api(`/api/admin/reviewers/${r.id}`, { method: 'DELETE' });
              if (filter.kind === 'reviewer' && filter.id === r.id) setFilter({ kind: 'all' });
              void loadGallery();
            }}
          />
        )}

        {casting && mode === 'browse' && (data.project.brief || admin) && (
          <div className="brief">
            {editingBrief !== null ? (
              <>
                <textarea
                  value={editingBrief}
                  onChange={(e) => setEditingBrief(e.target.value)}
                  placeholder="The casting brief reviewers see: dates, location, rate, usage, what you're looking for."
                  autoFocus
                />
                <button className="text-btn" onClick={async () => {
                  const brief = editingBrief;
                  await api(`/api/admin/projects/${data.project.id}/settings`, {
                    method: 'POST', body: JSON.stringify({ brief }),
                  });
                  setEditingBrief(null);
                  setData((d) => d && { ...d, project: { ...d.project, brief: brief.trim() || null } });
                }}>Save brief</button>{' '}
                <button className="text-btn" onClick={() => setEditingBrief(null)}>Cancel</button>
              </>
            ) : (
              <>
                {data.project.brief ? <><strong>Brief</strong>{'\n'}{data.project.brief}</> : null}
                {admin && (
                  <>
                    {data.project.brief ? '\n' : null}
                    <button className="text-btn" onClick={() => setEditingBrief(data.project.brief ?? '')}>
                      {data.project.brief ? 'Edit brief' : 'Add a brief'}
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        )}
        {sharedLabel && mode === 'browse' && (
          <div className="share-note">
            <span>Shared with you: <strong>{sharedLabel}</strong></span>
            <button className="text-btn" onClick={() => {
              setShareNote(false);
              setFilter({ kind: 'all' });
              window.scrollTo(0, 0);
            }}>See all photos</button>
            <button className="text-btn" aria-label="Dismiss" onClick={() => setShareNote(false)}>×</button>
          </div>
        )}
        {mode === 'browse' && images.length === 0 && !admin && (
          <p className="sub" style={{ padding: '24px 0' }}>No photos here yet. Check back soon.</p>
        )}
        {mode === 'browse' && filter.kind === 'dup' && visible.length > 0 && (
          <p className="meta" style={{ margin: '4px 0 16px', maxWidth: 640 }}>
            Frames that would match the same RAW in Capture One (e.g. <span className="mono">X.jpg</span> and{' '}
            <span className="mono">X 1.jpg</span>), or the same file uploaded twice. Delete the copy you don't want.
          </p>
        )}
        {mode === 'browse' && filter.kind !== 'all' && visible.length === 0 && (
          <p className="sub" style={{ padding: '24px 0' }}>
            {filter.kind === 'dup' ? 'No duplicates.'
              : filter.kind === 'agreed' ? 'No photo has been selected by two people yet.'
              : filter.kind === 'notes' ? 'No notes yet. Open a photo and choose Notes to add one.'
              : filter.kind === 'everyone'
                ? everyone.active.length < MIN_ACTIVE
                  ? `Needs at least ${MIN_ACTIVE} people who've each selected ${ACTIVE_SHARE * 100}% or more of the photos.`
                  : `No photo has been selected by all ${everyone.active.length} active reviewers yet.`
                : 'Nothing selected yet.'}
          </p>
        )}
        {mode === 'browse' && data.albums.map((album, i) => {
          const list = byAlbum.get(i) ?? [];
          if (list.length === 0 && (filter.kind !== 'all' || (casting && query.trim()))) return null;
          const picked = list.filter((x) => x.mine).length;
          return (
            <section key={album.id} ref={(el) => { sectionRefs.current[i] = el; }}>
              <header className="section-head">
                <h3>{album.name}</h3>
                <span className="meta">
                  {list.length} {casting ? (list.length === 1 ? 'person' : 'people') : list.length === 1 ? 'image' : 'images'}
                  {picked > 0 && ` · ${picked} selected`}
                </span>
                {admin && (
                  <span className="section-actions">
                    {shareBase && (
                      <button
                        className="text-btn"
                        title="The full project, opened at this album"
                        onClick={async () => {
                          await navigator.clipboard.writeText(`${shareBase}?album=${album.slug}&shared=1`).catch(() => {});
                          setCopiedAlbum(album.id);
                          setTimeout(() => setCopiedAlbum((c) => (c === album.id ? null : c)), 1500);
                        }}
                      >
                        {copiedAlbum === album.id ? 'Copied' : 'Copy link'}
                      </button>
                    )}
                    <button
                      className="text-btn"
                      title="A link to this album only, optionally with its own password"
                      onClick={() => setSharing(sharing === album.id ? null : album.id)}
                    >
                      Private link
                    </button>
                    <button className="text-btn danger" onClick={async () => {
                      const n = images.filter((x) => x.album === i).length;
                      if (!window.confirm(`Delete album "${album.name}" and its ${n} images, with their selects and notes? This cannot be undone.`)) return;
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
                  const i = img ? indexOf.get(img.id) : undefined;
                  if (i !== undefined) openViewer(i);
                }}
                onToggle={toggle}
                onDownload={canDownload ? downloadFrame : undefined}
                showNames={admin && filter.kind === 'dup'}
                caption={casting ? (img) => ({ title: talentName(img), sub: img.info }) : undefined}
                onDelete={admin && filter.kind === 'dup' ? (img) => {
                  if (window.confirm(`Delete ${img.filename}, with its selects and notes? This cannot be undone.`)) void deleteImage(img.id);
                } : undefined}
              />
            </section>
          );
        })}
      </main>

      {dl && (
        <div className="dl-toast" role="status">
          {dl.error ? (
            <span>{dl.label === 'retouch sheet' ? 'Retouch sheet' : 'Download'} failed: {dl.error}</span>
          ) : dl.done < dl.total ? (
            <>
              <span>Preparing {dl.label} · {dl.done} / {dl.total}</span>
              <div className="dl-bar"><div style={{ width: `${Math.round((dl.done / Math.max(dl.total, 1)) * 100)}%` }} /></div>
            </>
          ) : (
            <span>{dl.doneText ?? `Downloaded ${dl.total} ${dl.total === 1 ? 'photo' : 'photos'}`}</span>
          )}
          {dl.error || dl.done >= dl.total ? (
            <button className="text-btn" onClick={() => setDl(null)}>Dismiss</button>
          ) : (
            <button className="text-btn" onClick={() => dlAbort.current?.abort()}>Cancel</button>
          )}
        </div>
      )}

      {openIndex !== null && visible[openIndex] && (
        <Viewer
          images={visible}
          index={openIndex}
          onIndex={setOpenIndex}
          onClose={closeViewer}
          onToggle={toggle}
          onDelete={admin ? deleteImage : undefined}
          // With no cover chosen, the first frame of the shoot stands in.
          coverId={data.project.coverImageId ?? images[0]?.id ?? null}
          onSetCover={admin ? async (id) => {
            await api(`/api/admin/projects/${data.project.id}/cover`, {
              method: 'POST', body: JSON.stringify({ imageId: id }),
            });
            setData((d) => d && { ...d, project: { ...d.project, coverImageId: id } });
          } : undefined}
          albumName={data.albums[visible[openIndex]!.album]?.name}
          talent={casting ? (img) => ({ name: talentName(img), link: img.link, info: img.info }) : undefined}
          onEditDetails={admin && casting ? editDetails : undefined}
          notesApi={notesApi}
          workScope={base}
          onNotesChanged={onNotesChanged}
          canModerate={admin}
          onDownload={canDownload ? downloadFrame : undefined}
          pickers={(() => {
            // You first, then everyone else in the order they joined.
            const ids = new Set(pickersByImage.get(visible[openIndex]!.id) ?? []);
            return reviewers
              .filter((r) => ids.has(r.id))
              .sort((a, b) => Number(b.isMe) - Number(a.isMe))
              .map((r) => (r.isMe ? 'You' : r.name));
          })()}
        />
      )}
    </div>
  );
}
