import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Img } from './Grid';
import NotesPanel, { pinNumbers, COLORS, type Note, type NoteInput, type NotesApi, type Shape, type Tool } from './NotesPanel';
import { anchorOf, geometry, HALO, HALO_COLOR, STROKE } from './marks';
import { ApiError } from './api';

const SWIPE_DISTANCE = 60;   // px: a deliberate horizontal drag
const SWIPE_VELOCITY = 0.45; // px/ms: or a quick flick
const TAP_SLOP = 10;         // px of movement still counted as a tap
const DOUBLE_TAP_MS = 300;
const MAX_ZOOM = 6;
const ZOOM_STEP = 1.6;
// The names line never wraps (a second line would shift the photo), so it shows
// as many names as fit a line: six on a desktop, three on a phone.
const shownPickers = () => (window.matchMedia('(max-width: 760px)').matches ? 3 : 6);
const NOTES_KEY = 'review-notes-open';
const MIN_MARK = 6;      // px: anything smaller was a slip, not a mark
const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && !!t.closest('input, textarea, select, [contenteditable="true"]');

type Pin = { x: number; y: number; shapes?: Shape[] };
/**
 * Everything unfinished on one photo: a placed pin or drawing and its words, a
 * half-typed general note, a half-typed reply. Kept in the browser as it's
 * typed and saved to the server on leaving the photo, so no work is ever lost
 * and none can end up on the wrong photo.
 */
interface Work { pin: Pin | null; text: string; general: string; reply: { to: string; text: string } | null }
const NO_WORK: Work = { pin: null, text: '', general: '', reply: null };
const isEmpty = (w: Work) => !w.pin && !w.text.trim() && !w.general.trim() && !w.reply?.text.trim();
type Part = 'pin' | 'general' | 'reply';
const strip = (w: Work, part: Part): Work =>
  part === 'pin' ? { ...w, pin: null, text: '' } : part === 'general' ? { ...w, general: '' } : { ...w, reply: null };
/** The note a part of unfinished work would become; null if it isn't ready (a bare pin, empty boxes). */
function noteFrom(w: Work, part: Part): NoteInput | null {
  if (part === 'pin') {
    if (!w.pin || (!w.text.trim() && !w.pin.shapes?.length)) return null;
    return { x: w.pin.x, y: w.pin.y, body: w.text.trim(), shapes: w.pin.shapes?.length ? w.pin.shapes : undefined };
  }
  if (part === 'general') return w.general.trim() ? { body: w.general.trim() } : null;
  return w.reply?.text.trim() ? { parentId: w.reply.to, body: w.reply.text.trim() } : null;
}
const PARTS: Part[] = ['pin', 'general', 'reply'];
const workKey = (scope: string, imageId: string) => `review-work:${scope}:${imageId}`;
function loadWork(scope: string, imageId: string): Work {
  try {
    const raw = localStorage.getItem(workKey(scope, imageId));
    return raw ? { ...NO_WORK, ...(JSON.parse(raw) as Partial<Work>) } : NO_WORK;
  } catch { return NO_WORK; }
}
function storeWork(scope: string, imageId: string, w: Work) {
  try {
    if (isEmpty(w)) localStorage.removeItem(workKey(scope, imageId));
    else localStorage.setItem(workKey(scope, imageId), JSON.stringify(w));
  } catch { /* storage full or blocked: the in-memory copy still saves on leave */ }
}

/**
 * One mark as SVG, in photo pixels (the SVG's viewBox is the photo's size).
 * A dark halo under each stroke keeps it readable on light and dark parts of a
 * photo alike.
 */
function ShapeSvg({ s, w, h, px, dim }: { s: Shape; w: number; h: number; px: number; dim?: boolean }) {
  const g = geometry(s, w, h, px);
  const draw = (color: string, width: number) => {
    const stroke = { fill: 'none', stroke: color, strokeWidth: width, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
    return g.kind === 'ellipse'
      ? <ellipse cx={g.cx} cy={g.cy} rx={g.rx} ry={g.ry} {...stroke} />
      : <path d={g.d} {...stroke} />;
  };
  return (
    <g opacity={dim ? 0.3 : 1}>
      {draw(HALO_COLOR, STROKE * px * HALO)}
      {draw(s.c, STROKE * px)}
    </g>
  );
}

/**
 * Full-screen review. Keyboard on desktop (arrows, F/Space, Esc, +/−/0, N);
 * swipe, pinch and double-tap on a phone. Either way the point is to move
 * through hundreds of frames without returning to the grid between each one.
 *
 * The viewer owns every touch gesture inside it (touch-action: none), so a swipe
 * or double-tap can never pan or zoom the page underneath — which is what made the
 * frame drift sideways in mobile Safari. Zoom is the viewer's own: the photo is
 * laid out at its fitted size, then scaled and panned with a transform, and the
 * note pins ride along inside that same transform so they stay on their spot.
 */
export default function Viewer({
  images,
  index,
  onIndex,
  onClose,
  onToggle,
  onDelete,
  onSetCover,
  coverId,
  albumName,
  pickers = [],
  onDownload,
  talent,
  onEditDetails,
  notesApi,
  onNotesChanged,
  canModerate = false,
  workScope = 'review',
}: {
  images: Img[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  onToggle?: (id: string) => void;
  /** Owner only. */
  onDelete?: (id: string) => Promise<void>;
  /** Owner only: make this frame the project's cover on the project list. */
  onSetCover?: (id: string) => void;
  coverId?: string | null;
  albumName?: string;
  /** Names of everyone who picked this frame, "You" first. */
  pickers?: string[];
  onDownload?: (img: Img) => void;
  /** Casting: show the person, not the file. */
  talent?: (img: Img) => { name: string; link?: string | null; info?: string | null; of?: string | null };
  /** Owner, casting: edit name, portfolio link and status. */
  onEditDetails?: (img: Img) => void;
  /** Retouch notes: pins on the photo and a notes panel. */
  notesApi?: NotesApi;
  /** Tell the grid a frame's note counts changed. */
  onNotesChanged?: (imageId: string, all: number, open: number) => void;
  /** The owner may delete anyone's notes. */
  canModerate?: boolean;
  /** Keeps unfinished notes for one project apart from another's in the browser. */
  workScope?: string;
}) {
  const img = images[index];
  const [dragX, setDragX] = useState(0);
  const [settling, setSettling] = useState(false);
  const [pulse, setPulse] = useState<{ key: number; on: boolean } | null>(null);
  const gesture = useRef<{
    id: number; x: number; y: number; t: number; type: string;
    horizontal: boolean | null; panFrom: { x: number; y: number } | null; panned: boolean;
  } | null>(null);
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);
  /** Where the pin was before the last tap moved it, so a double-tap can put it back. */
  const pinBeforeTap = useRef<Pin | null>(null);
  // When a gesture ended: the click the browser fires right after it isn't a
  // real click. Time-boxed, because some gestures (a touch swipe, a pinch) fire
  // no click at all, and the next genuine one must not be swallowed.
  const suppressClick = useRef(0);
  const lastPointerType = useRef('mouse');

  // ---- zoom ----
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const [zoom, setZoomState] = useState(1);
  const [pan, setPanState] = useState({ x: 0, y: 0 });
  // Handlers read the live values from refs: several pointer events can land
  // before React re-renders with the last state.
  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; zoom: number; mid: { x: number; y: number } } | null>(null);
  // The mark being drawn right now (not yet part of the draft).
  const [live, setLive] = useState<Shape | null>(null);
  const liveRef = useRef<Shape | null>(null);
  const drawPointer = useRef<number | null>(null);

  // ---- notes ----
  const [notesOpen, setNotesOpen] = useState(() => {
    // Open by default beside the photo; on a phone it would take half the
    // screen (and hide who picked the photo), so there it starts closed. Either
    // way, opening or closing it is remembered for the rest of the visit.
    if (!notesApi) return false;
    const wide = window.matchMedia('(min-width: 761px)').matches;
    try {
      const saved = sessionStorage.getItem(NOTES_KEY);
      return saved === null ? wide : saved === '1';
    } catch { return wide; }
  });
  // Notes are kept with the photo they belong to, so a late answer for one
  // photo can never show up on the next.
  const [notesFor, setNotesFor] = useState<{ imageId: string; list: Note[] } | null>(null);
  const notes = notesFor && notesFor.imageId === img?.id ? notesFor.list : null;
  const [notesError, setNotesError] = useState('');
  const [activeNote, setActiveNote] = useState<string | null>(null);
  // The work and the photo it belongs to travel together, so it can only ever be
  // shown, kept or saved against that photo — never the one you've moved to.
  const [held, setHeld] = useState<{ imageId: string | null; work: Work }>(() =>
    ({ imageId: img?.id ?? null, work: img ? loadWork(workScope, img.id) : NO_WORK }));
  const work = held.imageId === img?.id ? held.work : NO_WORK;
  const setWork = (u: Work | ((w: Work) => Work)) =>
    setHeld((h) => ({ imageId: h.imageId, work: typeof u === 'function' ? u(h.work) : u }));
  const heldRef = useRef(held);
  heldRef.current = held;
  /** The unfinished work for one photo, if that's what's held. */
  const workOf = (imageId: string) => (heldRef.current.imageId === imageId ? heldRef.current.work : NO_WORK);
  const draft = work.pin;
  const setDraft = (u: Pin | null | ((d: Pin | null) => Pin | null)) =>
    setWork((w) => ({ ...w, pin: typeof u === 'function' ? u(w.pin) : u }));
  const imgIdRef = useRef(img?.id);
  imgIdRef.current = img?.id;
  const [touch, setTouch] = useState(false);
  const [tool, setTool] = useState<Tool>('pin');
  const [color, setColor] = useState<string>(COLORS[0]);
  const drawing = notesOpen && !!notesApi && tool !== 'pin';

  // Unfinished work saves itself on the way out (see the leave effect below).
  const go = (i: number) => onIndex(Math.max(0, Math.min(images.length - 1, i)));
  const close = onClose;

  // Measured straight away (so the first paint is already the right size) and
  // again whenever the stage changes: window resize, notes panel in or out.
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => {
      const cs = getComputedStyle(el);
      const w = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const h = el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      setStage((s) => (s.w === w && s.h === h ? s : { w, h }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener('resize', measure);
    return () => { ro.disconnect(); window.removeEventListener('resize', measure); };
  }, [notesOpen, img?.id]);

  // The photo's size on screen at zoom 1: as big as the space allows, small
  // photos (castings often are) scaled up to fill it rather than left tiny.
  const fit = img && stage.w > 0 ? Math.min(stage.w / img.w, stage.h / img.h) : 0;
  const fw = img ? img.w * fit : 0;
  const fh = img ? img.h * fit : 0;

  const clampPan = useCallback((p: { x: number; y: number }, z: number) => {
    const mx = Math.max(0, (fw * z - stage.w) / 2);
    const my = Math.max(0, (fh * z - stage.h) / 2);
    return { x: Math.max(-mx, Math.min(mx, p.x)), y: Math.max(-my, Math.min(my, p.y)) };
  }, [fw, fh, stage.w, stage.h]);

  const setView = useCallback((z: number, p: { x: number; y: number }) => {
    const zz = Math.max(1, Math.min(MAX_ZOOM, z));
    const pp = zz <= 1.001 ? { x: 0, y: 0 } : clampPan(p, zz);
    zoomRef.current = zz <= 1.001 ? 1 : zz;
    panRef.current = pp;
    setZoomState(zoomRef.current);
    setPanState(pp);
  }, [clampPan]);

  /** Zoom to z keeping the point under (cx, cy) where it is. */
  const zoomAt = useCallback((z: number, cx?: number, cy?: number) => {
    const el = stageRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const centreX = r.left + parseFloat(style.paddingLeft) + stage.w / 2;
    const centreY = r.top + parseFloat(style.paddingTop) + stage.h / 2;
    const px = (cx ?? centreX) - centreX;
    const py = (cy ?? centreY) - centreY;
    const z0 = zoomRef.current;
    const nz = Math.max(1, Math.min(MAX_ZOOM, z));
    const ux = (px - panRef.current.x) / z0;
    const uy = (py - panRef.current.y) / z0;
    setView(nz, { x: px - ux * nz, y: py - uy * nz });
  }, [setView, stage.w, stage.h]);

  // A new photo starts at fit, with nothing half-written on it.
  useEffect(() => {
    zoomRef.current = 1;
    panRef.current = { x: 0, y: 0 };
    setZoomState(1);
    setPanState({ x: 0, y: 0 });
    setHeld({ imageId: img?.id ?? null, work: img ? loadWork(workScope, img.id) : NO_WORK });
    setActiveNote(null);
    liveRef.current = null;
    setLive(null);
  }, [img?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Every change to unfinished work is kept in the browser at once, under its photo.
  useEffect(() => {
    if (held.imageId) storeWork(workScope, held.imageId, held.work);
  }, [held, workScope]);

  // Trackpad pinch arrives as ctrl+wheel; a plain wheel pans once zoomed in.
  // Listened to natively: React's wheel listener is passive and can't stop the page.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) {
        e.preventDefault();
        zoomAt(zoomRef.current * Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
      } else if (zoomRef.current > 1) {
        e.preventDefault();
        setView(zoomRef.current, { x: panRef.current.x - e.deltaX, y: panRef.current.y - e.deltaY });
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAt, setView, notesOpen]);

  // ---- notes data ----
  const report = useCallback((imageId: string, list: Note[]) => {
    const top = list.filter((n) => !n.parentId);
    onNotesChanged?.(imageId, top.length, top.filter((n) => !n.resolvedAt).length);
  }, [onNotesChanged]);

  useEffect(() => {
    if (!notesApi || !notesOpen || !img) return;
    let live = true;
    const imageId = img.id;
    setNotesError('');
    notesApi.list(imageId)
      .then((list) => { if (live) { setNotesFor({ imageId, list }); report(imageId, list); } })
      .catch(() => { if (live) setNotesError('Could not load notes.'); });
    return () => { live = false; };
  }, [notesApi, notesOpen, img?.id, report]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleNotes = useCallback((open?: boolean) => {
    setNotesOpen((v) => {
      const next = open ?? !v;
      try { sessionStorage.setItem(NOTES_KEY, next ? '1' : '0'); } catch { /* private mode */ }
      return next; // closing the panel only hides unfinished work; it's kept
    });
  }, []);

  /** Note parts on their way to the server, as "imageId:part": never sent twice. */
  const inFlight = useRef(new Set<string>());
  const notesApiRef = useRef(notesApi);
  notesApiRef.current = notesApi;
  const applyRef = useRef<(imageId: string, list: Note[]) => void>(() => {});

  /**
   * Send whatever unfinished work on a photo is ready to be a note. Each part
   * leaves the browser's copy as it's sent and goes back if the send fails, so
   * it is offered again next time; a bare pin with no words just stays put.
   */
  const saveWork = useCallback((imageId: string, w: Work, keepalive = false) => {
    const api = notesApiRef.current;
    if (!api) return;
    for (const part of PARTS) {
      const input = noteFrom(w, part);
      const key = `${imageId}:${part}`;
      if (!input || inFlight.current.has(key)) continue;
      inFlight.current.add(key);
      storeWork(workScope, imageId, strip(loadWork(workScope, imageId), part));
      setHeld((h) => (h.imageId === imageId ? { imageId, work: strip(h.work, part) } : h));
      api.add(imageId, input, { keepalive })
        .then((list) => applyRef.current(imageId, list))
        .catch((err) => {
          // The photo itself is gone (deleted meanwhile): nowhere left to save to.
          if (err instanceof ApiError && err.status === 404) return;
          // The note being replied to was deleted meanwhile: keep the words as a general note.
          if (part === 'reply' && err instanceof ApiError && err.status === 400 && /parent/i.test(err.message)) {
            api.add(imageId, { body: (input as NoteInput).body }, { keepalive })
              .then((list) => applyRef.current(imageId, list))
              .catch(() => {
                const back = loadWork(workScope, imageId);
                const merged = { ...back, general: [back.general, (input as NoteInput).body].filter(Boolean).join('\n') };
                storeWork(workScope, imageId, merged);
                setHeld((h) => (h.imageId === imageId ? { imageId, work: merged } : h));
              });
            return;
          }
          const back = loadWork(workScope, imageId);
          // Only into an empty slot: never over something typed since.
          const restored = noteFrom(back, part) || (part === 'pin' && back.pin) ? back
            : part === 'pin' ? { ...back, pin: w.pin, text: w.text }
              : part === 'general' ? { ...back, general: w.general } : { ...back, reply: w.reply };
          storeWork(workScope, imageId, restored);
          setHeld((h) => (h.imageId === imageId ? { imageId, work: restored } : h));
        })
        .finally(() => inFlight.current.delete(key));
    }
  }, [workScope]);

  // Leaving a photo (next, previous, close, back gesture) saves its unfinished work.
  // A bare pin — no words, no marks — is a stray click rather than work: it goes.
  useEffect(() => {
    const imageId = img?.id;
    return () => {
      if (!imageId) return;
      const w = workOf(imageId);
      saveWork(imageId, w);
      if (w.pin && !w.text.trim() && !w.pin.shapes?.length) {
        storeWork(workScope, imageId, { ...loadWork(workScope, imageId), pin: null });
      }
    };
  }, [img?.id, saveWork]); // eslint-disable-line react-hooks/exhaustive-deps

  // So does closing or reloading the tab: keepalive lets the request outlive the page.
  useEffect(() => {
    const onHide = () => { const id = heldRef.current.imageId; if (id) saveWork(id, heldRef.current.work, true); };
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, [saveWork]);

  /** A changed list for a photo, from any note action. Counts update even if you've moved on. */
  const apply = (imageId: string, list: Note[]) => {
    // A late answer for a photo you've left mustn't replace the one on screen.
    setNotesFor((cur) => (cur && imageId !== imgIdRef.current && cur.imageId === imgIdRef.current ? cur : { imageId, list }));
    report(imageId, list);
  };
  applyRef.current = apply;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Typing a note: keys belong to the box. But an empty box has nothing to
      // move the cursor through, so the arrows still change photo from there.
      if (isTyping(e.target)) {
        const box = e.target as HTMLTextAreaElement;
        const empty = 'value' in box && !box.value;
        if (!(empty && (e.key === 'ArrowRight' || e.key === 'ArrowLeft'))) return;
        box.blur();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && draft?.shapes?.length) {
        e.preventDefault();
        undoMark();
        return;
      }
      if (e.key === 'Escape') close(); // unfinished work saves itself
      else if (e.key === 'ArrowRight') go(index + 1);
      else if (e.key === 'ArrowLeft') go(index - 1);
      else if (e.key === '+' || e.key === '=') zoomAt(zoomRef.current * ZOOM_STEP);
      else if (e.key === '-' || e.key === '_') zoomAt(zoomRef.current / ZOOM_STEP);
      else if (e.key === '0') setView(1, { x: 0, y: 0 });
      else if ((e.key === 'n' || e.key === 'N') && notesApi && !e.metaKey && !e.ctrlKey) toggleNotes();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Prefetch the next few and the previous one, so moving either way feels instant.
  useEffect(() => {
    for (const i of [index + 1, index + 2, index + 3, index - 1]) {
      const n = images[i];
      if (n) new Image().src = `/i/${n.preview}`;
    }
  }, [index, images]);

  useEffect(() => {
    const html = document.documentElement;
    const prevBody = document.body.style.overflow;
    const prevHtml = html.style.overflow;
    document.body.style.overflow = 'hidden';
    html.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevBody;
      html.style.overflow = prevHtml;
    };
  }, []);

  if (!img) return null;

  function toggleWithPulse() {
    if (!onToggle || !img) return;
    setPulse({ key: Date.now(), on: !img.mine });
    onToggle(img.id);
  }

  /** Where a screen point falls on the photo, as fractions; null if off the photo. */
  function pointOnPhoto(cx: number, cy: number): { x: number; y: number } | null {
    const r = imgRef.current?.getBoundingClientRect();
    if (!r || !r.width) return null;
    const x = (cx - r.left) / r.width;
    const y = (cy - r.top) / r.height;
    return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
  }

  /** The same, held to the photo's edges: a stroke may wander off and come back. */
  function clampedPoint(cx: number, cy: number): [number, number] {
    const r = imgRef.current!.getBoundingClientRect();
    const c = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 1e4) / 1e4;
    return [c((cx - r.left) / r.width), c((cy - r.top) / r.height)];
  }

  function startMark(e: React.PointerEvent): boolean {
    const p = pointOnPhoto(e.clientX, e.clientY);
    if (!p) return false;
    const at: [number, number] = clampedPoint(e.clientX, e.clientY);
    const shape: Shape = tool === 'pen' ? { t: 'pen', c: color, p: [at] } : { t: tool as 'ellipse' | 'arrow', c: color, a: at, b: at };
    liveRef.current = shape;
    setLive(shape);
    drawPointer.current = e.pointerId;
    // Keep the stroke if the pointer leaves the stage; harmless if capture isn't possible.
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    setActiveNote(null);
    return true;
  }

  function moveMark(e: React.PointerEvent) {
    const s = liveRef.current;
    if (!s) return;
    const at = clampedPoint(e.clientX, e.clientY);
    let next: Shape;
    if (s.t === 'pen') {
      // Thin the stroke: a new point only once the pointer has moved a couple of pixels.
      const r = imgRef.current!.getBoundingClientRect();
      const last = s.p[s.p.length - 1]!;
      if (Math.hypot((at[0] - last[0]) * r.width, (at[1] - last[1]) * r.height) < 2.5 || s.p.length >= 600) return;
      next = { ...s, p: [...s.p, at] };
    } else {
      next = { ...s, b: at };
    }
    liveRef.current = next;
    setLive(next);
  }

  function endMark() {
    const s = liveRef.current;
    liveRef.current = null;
    drawPointer.current = null;
    setLive(null);
    if (!s) return;
    const r = imgRef.current?.getBoundingClientRect();
    const span = (a: [number, number], b: [number, number]) =>
      r ? Math.hypot((a[0] - b[0]) * r.width, (a[1] - b[1]) * r.height) : 0;
    const big = s.t === 'pen' ? s.p.length >= 2 && span(s.p[0]!, s.p[s.p.length - 1]!) + s.p.length > MIN_MARK : span(s.a, s.b) >= MIN_MARK;
    if (!big) return;
    setDraft((d) => {
      const shapes = [...(d?.shapes ?? []), s];
      const [x, y] = anchorOf(shapes[0]!);
      return { x, y, shapes };
    });
  }

  function undoMark() {
    setDraft((d) => {
      if (!d?.shapes?.length) return d;
      const shapes = d.shapes.slice(0, -1);
      if (!shapes.length) return heldRef.current.work.text.trim() ? { x: d.x, y: d.y } : null;
      const [x, y] = anchorOf(shapes[0]!);
      return { x, y, shapes };
    });
  }

  function onPointerDown(e: React.PointerEvent) {
    lastPointerType.current = e.pointerType;
    if (e.pointerType !== 'mouse') setTouch(true);
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      // Second finger down: this is a pinch (zoom and pan), not a swipe, a tap or a stroke.
      const [a, b] = [...pointers.current.values()];
      pinch.current = {
        dist: Math.hypot(a!.x - b!.x, a!.y - b!.y), zoom: zoomRef.current,
        mid: { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 },
      };
      gesture.current = null;
      liveRef.current = null;
      drawPointer.current = null;
      setLive(null);
      setDragX(0);
      return;
    }
    // A drawing tool: a drag on the photo is a mark. Panning is two fingers, the
    // scroll wheel, or switching back to the pin tool.
    if (drawing && startMark(e)) {
      gesture.current = null;
      return;
    }
    gesture.current = {
      id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), type: e.pointerType,
      horizontal: null, panFrom: zoomRef.current > 1 ? { ...panRef.current } : null, panned: false,
    };
    setSettling(false);
  }

  function onPointerMove(e: React.PointerEvent) {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch.current && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      const mid = { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 };
      // The photo moves with the fingers, then scales around the point between them.
      setView(zoomRef.current, { x: panRef.current.x + mid.x - pinch.current.mid.x, y: panRef.current.y + mid.y - pinch.current.mid.y });
      pinch.current.mid = mid;
      zoomAt(pinch.current.zoom * (dist / Math.max(1, pinch.current.dist)), mid.x, mid.y);
      return;
    }
    if (drawPointer.current === e.pointerId) {
      moveMark(e);
      return;
    }
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (g.panFrom) {
      // Zoomed in: any drag (mouse or finger) moves around the photo.
      if (!g.panned && Math.hypot(dx, dy) > TAP_SLOP) g.panned = true;
      if (g.panned) setView(zoomRef.current, { x: g.panFrom.x + dx, y: g.panFrom.y + dy });
      return;
    }
    if (g.type === 'mouse') return;
    if (g.horizontal === null && Math.hypot(dx, dy) > TAP_SLOP) g.horizontal = Math.abs(dx) > Math.abs(dy);
    if (g.horizontal) {
      // The frame follows the finger; past either end of the set it resists.
      const atEdge = (dx > 0 && index === 0) || (dx < 0 && index === images.length - 1);
      setDragX(atEdge ? dx * 0.25 : dx);
    }
  }

  function onPointerUp(e: React.PointerEvent) {
    pointers.current.delete(e.pointerId);
    if (drawPointer.current === e.pointerId) {
      moveMark(e); // where the pointer was released is where the mark ends
      endMark();
      suppressClick.current = performance.now();
      return;
    }
    if (pinch.current) {
      if (pointers.current.size < 2) pinch.current = null;
      suppressClick.current = performance.now();
      return;
    }
    const g = gesture.current;
    gesture.current = null;
    if (!g || g.id !== e.pointerId) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    const dt = Math.max(1, performance.now() - g.t);
    const moved = Math.hypot(dx, dy);

    if (g.panned) {
      suppressClick.current = performance.now();
      return;
    }

    if (g.type !== 'mouse' && g.horizontal && !g.panFrom) {
      const flick = Math.abs(dx) / dt > SWIPE_VELOCITY && Math.abs(dx) > 25;
      const target = dx < 0 ? index + 1 : index - 1;
      suppressClick.current = performance.now();
      if ((Math.abs(dx) > SWIPE_DISTANCE || flick) && target >= 0 && target < images.length) {
        setSettling(false);
        setDragX(0);
        go(target);
      } else {
        setSettling(true); // not far enough: ease back to centre
        setDragX(0);
      }
      return;
    }

    if (moved > TAP_SLOP) return;

    // With notes open, a tap on the photo pins a note there (and nothing else:
    // no double-tap select, no closing).
    const now = performance.now();
    const prev = lastTap.current;
    const isDouble = !!prev && now - prev.t < DOUBLE_TAP_MS && Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < 40;

    if (notesOpen && notesApi) {
      suppressClick.current = performance.now();
      if (isDouble) {
        // A double-tap still selects: take back the pin the first tap dropped.
        lastTap.current = null;
        setDraft(pinBeforeTap.current);
        toggleWithPulse();
        return;
      }
      lastTap.current = { t: now, x: e.clientX, y: e.clientY };
      const p = pointOnPhoto(e.clientX, e.clientY);
      pinBeforeTap.current = draft;
      if (p && !draft?.shapes?.length) {
        setDraft(p); // a new spot for the pin; any words typed for it stay
        setActiveNote(null);
      }
      return;
    }

    if (isDouble) {
      lastTap.current = null;
      suppressClick.current = performance.now();
      toggleWithPulse();
    } else {
      lastTap.current = { t: now, x: e.clientX, y: e.clientY };
    }
  }

  function onPointerCancel(e: React.PointerEvent) {
    pointers.current.delete(e.pointerId);
    if (drawPointer.current === e.pointerId) {
      liveRef.current = null;
      drawPointer.current = null;
      setLive(null);
    }
    if (pointers.current.size < 2) pinch.current = null;
    gesture.current = null;
    setSettling(true);
    setDragX(0);
  }

  const numbers = pinNumbers(notes ?? []);
  const pins = notesOpen ? (notes ?? []).filter((n) => !n.parentId && n.x !== null) : [];
  const marked = notesOpen ? (notes ?? []).filter((n) => !n.parentId && n.shapes?.length) : [];
  // Photo pixels per screen pixel, for strokes that stay one size at any zoom.
  const px = fit > 0 ? 1 / (fit * zoom) : 1;
  const openCount = img.notesOpen ?? 0;
  const zoomed = zoom > 1;

  return (
    <div
      className={`viewer${notesOpen ? ' with-notes' : ''}`}
      onClickCapture={(e) => {
        // A swipe, pan or double-tap must not also count as a click that closes the viewer.
        // Only on the photo area or the margin: buttons in the bar or the notes
        // panel are always real clicks, however soon after a stroke they come.
        const onStage = stageRef.current?.contains(e.target as Node) || e.target === e.currentTarget;
        if (onStage && suppressClick.current && performance.now() - suppressClick.current < 400) {
          suppressClick.current = 0;
          e.stopPropagation();
        }
      }}
      onClick={() => {
        // Clicking the margin closes on desktop. On touch it doesn't: the first
        // half of a double-tap near the edge would otherwise close the viewer.
        // Not while annotating or zoomed, where a stray click would lose your place.
        if (lastPointerType.current === 'mouse' && !notesOpen && !zoomed) close();
      }}
    >
      <div className="viewer-head">
        {talent ? (() => {
          const t = talent(img);
          return (
            <span className="viewer-title">
              <strong className="viewer-name">{t.name}</strong>
              {t.of && <span className="viewer-info">{t.of}</span>}
              {t.info && <span className="viewer-info">{t.info}</span>}
              {albumName && <span className="viewer-info">{albumName}</span>}
            </span>
          );
        })() : (
          <span className="viewer-title mono">
            {albumName && <span style={{ marginRight: 10 }}>{albumName}</span>}
            {img.filename}
          </span>
        )}
        <span className="viewer-zoom" onClick={(e) => e.stopPropagation()}>
          <button aria-label="Zoom out" title="Zoom out (−)" disabled={!zoomed} onClick={() => zoomAt(zoom / ZOOM_STEP)}>−</button>
          <button className="zoom-level" title="Fit (0)" onClick={() => setView(1, { x: 0, y: 0 })}>
            {zoomed ? `${Math.round(zoom * fit * 100)}%` : 'Fit'}
          </button>
          <button aria-label="Zoom in" title="Zoom in (+)" disabled={zoom >= MAX_ZOOM} onClick={() => zoomAt(zoom * ZOOM_STEP)}>+</button>
        </span>
        {notesApi && (
          <button
            className={`viewer-notes-btn${notesOpen ? ' on' : ''}`}
            aria-pressed={notesOpen}
            title="Notes (N)"
            onClick={(e) => { e.stopPropagation(); toggleNotes(); }}
          >
            Notes{openCount > 0 ? ` · ${openCount}` : ''}
          </button>
        )}
        <span className="viewer-count">
          {index + 1} / {images.length}
        </span>
        <button
          className="viewer-close"
          aria-label="Close"
          title="Close (Esc)"
          onClick={(e) => { e.stopPropagation(); close(); }}
        >
          ×
        </button>
      </div>

      <div className="viewer-body">
        <div
          ref={stageRef}
          className={`viewer-stage${zoomed ? ' zoomed' : ''}${notesOpen ? ' annotating' : ''}${drawing ? ' drawing' : ''}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
        >
          {fit > 0 && (
            <div
              className="viewer-frame"
              onClick={(e) => e.stopPropagation()}
              style={{
                width: fw,
                height: fh,
                transform: `translate(${dragX + pan.x}px, ${pan.y}px) scale(${zoom})`,
                transition: settling ? 'transform 0.18s ease-out' : 'none',
              }}
            >
              <img
                ref={imgRef}
                key={img.id}
                src={`/i/${img.preview}`}
                alt={img.filename}
                draggable={false}
              />
              {(marked.length > 0 || draft?.shapes?.length || live) && (
                <svg className="marks" viewBox={`0 0 ${img.w} ${img.h}`} preserveAspectRatio="none" aria-hidden="true">
                  {marked.map((n) =>
                    n.shapes!.map((s, i) => (
                      <ShapeSvg key={`${n.id}-${i}`} s={s} w={img.w} h={img.h} px={px}
                        dim={!!n.resolvedAt || (!!activeNote && activeNote !== n.id)} />
                    )))}
                  {draft?.shapes?.map((s, i) => <ShapeSvg key={`d-${i}`} s={s} w={img.w} h={img.h} px={px} />)}
                  {live && <ShapeSvg s={live} w={img.w} h={img.h} px={px} />}
                </svg>
              )}
              {pins.map((n) => (
                <button
                  key={n.id}
                  className={`pin${n.resolvedAt ? ' resolved' : ''}${n.id === activeNote ? ' active' : ''}`}
                  style={{ left: `${n.x! * 100}%`, top: `${n.y! * 100}%`, transform: `translate(-50%, -50%) scale(${1 / zoom})` }}
                  onPointerDown={(e) => e.stopPropagation()}
                  onPointerUp={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); setDraft(null); setActiveNote(n.id === activeNote ? null : n.id); }}
                  aria-label={`Note ${numbers.get(n.id)}`}
                >
                  {numbers.get(n.id)}
                </button>
              ))}
              {draft && (
                <span
                  className="pin draft"
                  style={{ left: `${draft.x * 100}%`, top: `${draft.y * 100}%`, transform: `translate(-50%, -50%) scale(${1 / zoom})` }}
                >
                  {numbers.size + 1}
                </span>
              )}
            </div>
          )}
          {pulse && (
            <span key={pulse.key} className="viewer-pulse" onAnimationEnd={() => setPulse(null)}>
              {pulse.on ? '♥' : '♡'}
            </span>
          )}
        </div>

        {notesOpen && notesApi && (
          <NotesPanel
            // Fresh per photo: half-typed words must never be posted to the next one.
            key={img.id}
            notes={notes}
            loadError={notesError}
            activeId={activeNote}
            onActivate={setActiveNote}
            draft={draft}
            draftNumber={numbers.size + 1}
            onDraftCancel={() => setWork((w) => strip(w, 'pin'))}
            draftText={work.text}
            onDraftText={(text) => setWork((w) => ({ ...w, text }))}
            general={work.general}
            onGeneral={(general) => setWork((w) => ({ ...w, general }))}
            reply={work.reply}
            onReply={(reply) => setWork((w) => ({ ...w, reply }))}
            onAdd={async (input) => {
              const imageId = img.id;
              const part: Part = input.parentId ? 'reply' : input.x !== undefined ? 'pin' : 'general';
              const key = `${imageId}:${part}`;
              if (inFlight.current.has(key)) return;
              inFlight.current.add(key);
              try {
                apply(imageId, await notesApi.add(imageId, input).catch((err) => {
                  if (part === 'reply' && err instanceof ApiError && err.status === 400 && /parent/i.test(err.message)) {
                    throw new Error('That note was just deleted. Your words are kept, and leaving this photo saves them as a general note');
                  }
                  throw err;
                }));
                // Saved: clear it from wherever it now lives (on screen, or kept for that photo).
                if (heldRef.current.imageId === imageId) setHeld((h) => (h.imageId === imageId ? { imageId, work: strip(h.work, part) } : h));
                else storeWork(workScope, imageId, strip(loadWork(workScope, imageId), part));
              } finally {
                inFlight.current.delete(key);
              }
            }}
            onResolve={async (id, resolved) => {
              const imageId = img.id;
              apply(imageId, await notesApi.resolve(id, resolved));
            }}
            onDelete={async (id) => {
              const imageId = img.id;
              apply(imageId, await notesApi.remove(id));
              if (activeNote === id) setActiveNote(null);
            }}
            canDelete={(n) => n.mine || canModerate}
            onClose={() => toggleNotes(false)}
            touch={touch}
            tool={tool}
            onTool={setTool}
            color={color}
            onColor={setColor}
            onUndo={undoMark}
          />
        )}
      </div>

      {/* Who picked it, like a caption: a heart and a name per person. */}
      <div className="viewer-pickers" aria-live="polite">
        {pickers.slice(0, shownPickers()).map((name, i) => (
          // Two reviewers can share a name, so the position is part of the key.
          <span key={`${i}-${name}`} className="picker">
            <span className="picker-heart" aria-hidden="true">♥</span>{name}
          </span>
        ))}
        {pickers.length > shownPickers() && (
          <span className="picker more">+ {pickers.length - shownPickers()} more</span>
        )}
      </div>

      <div className="viewer-foot">
        <span className="viewer-actions">
          {talent && (() => {
            const link = talent(img).link;
            return link ? (
              <a className="text-btn" href={link} target="_blank" rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}>Portfolio ↗</a>
            ) : null;
          })()}
          {onEditDetails && (
            <button className="text-btn" onClick={(e) => { e.stopPropagation(); onEditDetails(img); }}>
              Edit details
            </button>
          )}
          {onDownload && (
            <button className="text-btn" onClick={(e) => { e.stopPropagation(); onDownload(img); }}>
              Download
            </button>
          )}
          {onSetCover && (
            img.id === coverId ? (
              <span className="meta">Project cover</span>
            ) : (
              <button className="text-btn" onClick={(e) => { e.stopPropagation(); onSetCover(img.id); }}>
                Set as cover
              </button>
            )
          )}
          {onDelete && (
            <button
              className="text-btn danger"
              onClick={async (e) => {
                e.stopPropagation();
                if (!window.confirm(`Delete ${img.filename}? Its selections and notes go with it. This cannot be undone.`)) return;
                await onDelete(img.id);
              }}
            >
              Delete image
            </button>
          )}
          <span className="meta hint-keys">
            {notesOpen ? (drawing ? 'Drag on the photo to draw · ⌘Z to undo · ' : 'Click the photo to pin a note · ') : ''}← → to move · F or Space to select · +/− to zoom · Esc to close
          </span>
          <span className="meta hint-touch">
            {notesOpen ? (drawing ? 'Draw with one finger · two fingers to zoom and move' : 'Tap the photo to pin a note · pinch to zoom') : 'Swipe · double-tap to select · pinch to zoom'}
          </span>
        </span>
        {onToggle ? (
          <button
            className={`heart big${img.mine ? ' on' : ''}`}
            aria-pressed={!!img.mine}
            onClick={(e) => { e.stopPropagation(); onToggle(img.id); }}
          >
            {/* The red fill says it's selected; the word stays put. */}
            {img.mine ? '♥' : '♡'} Select
          </button>
        ) : null}
      </div>
    </div>
  );
}
