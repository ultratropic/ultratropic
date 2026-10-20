import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Img } from './Grid';
import NotesPanel, { pinNumbers, type Note, type NotesApi } from './NotesPanel';

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
const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && !!t.closest('input, textarea, select, [contenteditable="true"]');

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
  talent?: (img: Img) => { name: string; link?: string | null; info?: string | null };
  /** Owner, casting: edit name, portfolio link and status. */
  onEditDetails?: (img: Img) => void;
  /** Retouch notes: pins on the photo and a notes panel. */
  notesApi?: NotesApi;
  /** Tell the grid a frame's note counts changed. */
  onNotesChanged?: (imageId: string, all: number, open: number) => void;
  /** The owner may delete anyone's notes. */
  canModerate?: boolean;
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
  const pinch = useRef<{ dist: number; zoom: number } | null>(null);

  // ---- notes ----
  const [notesOpen, setNotesOpen] = useState(() => {
    try { return !!notesApi && sessionStorage.getItem(NOTES_KEY) === '1'; } catch { return false; }
  });
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [notesError, setNotesError] = useState('');
  const [activeNote, setActiveNote] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ x: number; y: number } | null>(null);
  const [touch, setTouch] = useState(false);

  const go = (i: number) => onIndex(Math.max(0, Math.min(images.length - 1, i)));

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

  // The photo's size on screen at zoom 1: fitted, never enlarged past its pixels.
  const fit = img && stage.w > 0 ? Math.min(1, stage.w / img.w, stage.h / img.h) : 0;
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
    setDraft(null);
    setActiveNote(null);
  }, [img?.id]);

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
    setNotes(null);
    setNotesError('');
    notesApi.list(img.id)
      .then((list) => { if (live) { setNotes(list); report(img.id, list); } })
      .catch(() => { if (live) setNotesError('Could not load notes.'); });
    return () => { live = false; };
  }, [notesApi, notesOpen, img?.id, report]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleNotes = useCallback((open?: boolean) => {
    setNotesOpen((v) => {
      const next = open ?? !v;
      try { sessionStorage.setItem(NOTES_KEY, next ? '1' : '0'); } catch { /* private mode */ }
      if (!next) setDraft(null);
      return next;
    });
  }, []);

  const apply = (list: Note[]) => {
    setNotes(list);
    if (img) report(img.id, list);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return; // typing a note: arrows and Escape belong to the text box
      if (e.key === 'Escape') {
        if (draft) setDraft(null);
        else onClose();
      } else if (e.key === 'ArrowRight') go(index + 1);
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

  function onPointerDown(e: React.PointerEvent) {
    lastPointerType.current = e.pointerType;
    if (e.pointerType !== 'mouse') setTouch(true);
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      // Second finger down: this is a pinch, not a swipe or a tap.
      const [a, b] = [...pointers.current.values()];
      pinch.current = { dist: Math.hypot(a!.x - b!.x, a!.y - b!.y), zoom: zoomRef.current };
      gesture.current = null;
      setDragX(0);
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
      zoomAt(pinch.current.zoom * (dist / Math.max(1, pinch.current.dist)), (a!.x + b!.x) / 2, (a!.y + b!.y) / 2);
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
    if (notesOpen && notesApi) {
      suppressClick.current = performance.now();
      const p = pointOnPhoto(e.clientX, e.clientY);
      if (p) {
        setDraft(p);
        setActiveNote(null);
      }
      return;
    }

    const now = performance.now();
    const prev = lastTap.current;
    if (prev && now - prev.t < DOUBLE_TAP_MS && Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < 40) {
      lastTap.current = null;
      suppressClick.current = performance.now();
      toggleWithPulse();
    } else {
      lastTap.current = { t: now, x: e.clientX, y: e.clientY };
    }
  }

  function onPointerCancel(e: React.PointerEvent) {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    gesture.current = null;
    setSettling(true);
    setDragX(0);
  }

  const numbers = pinNumbers(notes ?? []);
  const pins = notesOpen ? (notes ?? []).filter((n) => !n.parentId && n.x !== null) : [];
  const openCount = img.notesOpen ?? 0;
  const zoomed = zoom > 1;

  return (
    <div
      className={`viewer${notesOpen ? ' with-notes' : ''}`}
      onClickCapture={(e) => {
        // A swipe, pan or double-tap must not also count as a click that closes the viewer.
        if (suppressClick.current && performance.now() - suppressClick.current < 400) {
          suppressClick.current = 0;
          e.stopPropagation();
        }
      }}
      onClick={() => {
        // Clicking the margin closes on desktop. On touch it doesn't: the first
        // half of a double-tap near the edge would otherwise close the viewer.
        // Not while annotating or zoomed, where a stray click would lose your place.
        if (lastPointerType.current === 'mouse' && !notesOpen && !zoomed) onClose();
      }}
    >
      <div className="viewer-head">
        {talent ? (() => {
          const t = talent(img);
          return (
            <span className="viewer-title">
              <strong className="viewer-name">{t.name}</strong>
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
          onClick={(e) => { e.stopPropagation(); onClose(); }}
        >
          ×
        </button>
      </div>

      <div className="viewer-body">
        <div
          ref={stageRef}
          className={`viewer-stage${zoomed ? ' zoomed' : ''}${notesOpen ? ' annotating' : ''}`}
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
            notes={notes}
            loadError={notesError}
            activeId={activeNote}
            onActivate={setActiveNote}
            draft={draft}
            draftNumber={numbers.size + 1}
            onDraftCancel={() => setDraft(null)}
            onAdd={async (input) => {
              const list = await notesApi.add(img.id, input);
              apply(list);
              if (input.x !== undefined) setDraft(null);
            }}
            onResolve={async (id, resolved) => apply(await notesApi.resolve(id, resolved))}
            onDelete={async (id) => {
              apply(await notesApi.remove(id));
              if (activeNote === id) setActiveNote(null);
            }}
            canDelete={(n) => n.mine || canModerate}
            onClose={() => toggleNotes(false)}
            touch={touch}
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
            {notesOpen ? 'Click the photo to pin a note · ' : ''}← → to move · F or Space to select · +/− to zoom · Esc to close
          </span>
          <span className="meta hint-touch">
            {notesOpen ? 'Tap the photo to pin a note · pinch to zoom' : 'Swipe · double-tap to select · pinch to zoom'}
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
