import { useEffect, useRef, useState } from 'react';
import type { Img } from './Grid';

const SWIPE_DISTANCE = 60;   // px: a deliberate horizontal drag
const SWIPE_VELOCITY = 0.45; // px/ms: or a quick flick
const TAP_SLOP = 10;         // px of movement still counted as a tap
const DOUBLE_TAP_MS = 300;
// The names line never wraps (a second line would shift the photo), so it shows
// as many names as fit a line: six on a desktop, three on a phone.
const shownPickers = () => (window.matchMedia('(max-width: 760px)').matches ? 3 : 6);

/**
 * Full-screen review. Keyboard on desktop (arrows, F/Space, Esc); swipe and
 * double-tap on a phone. Either way the point is to move through hundreds of
 * frames without returning to the grid between each one.
 *
 * The viewer owns every touch gesture inside it (touch-action: none), so a swipe
 * or double-tap can never pan or zoom the page underneath — which is what made the
 * frame drift sideways in mobile Safari.
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
}) {
  const img = images[index];
  const [dragX, setDragX] = useState(0);
  const [settling, setSettling] = useState(false);
  const [pulse, setPulse] = useState<{ key: number; on: boolean } | null>(null);
  const gesture = useRef<{ id: number; x: number; y: number; t: number; type: string; horizontal: boolean | null } | null>(null);
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);
  const suppressClick = useRef(false);
  const lastPointerType = useRef('mouse');

  const go = (i: number) => onIndex(Math.max(0, Math.min(images.length - 1, i)));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight') go(index + 1);
      else if (e.key === 'ArrowLeft') go(index - 1);
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

  function onPointerDown(e: React.PointerEvent) {
    lastPointerType.current = e.pointerType;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    gesture.current = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), type: e.pointerType, horizontal: null };
    setSettling(false);
  }

  function onPointerMove(e: React.PointerEvent) {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId || g.type === 'mouse') return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (g.horizontal === null && Math.hypot(dx, dy) > TAP_SLOP) g.horizontal = Math.abs(dx) > Math.abs(dy);
    if (g.horizontal) {
      // The frame follows the finger; past either end of the set it resists.
      const atEdge = (dx > 0 && index === 0) || (dx < 0 && index === images.length - 1);
      setDragX(atEdge ? dx * 0.25 : dx);
    }
  }

  function onPointerUp(e: React.PointerEvent) {
    const g = gesture.current;
    gesture.current = null;
    if (!g || g.id !== e.pointerId) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    const dt = Math.max(1, performance.now() - g.t);
    const moved = Math.hypot(dx, dy);

    if (g.type !== 'mouse' && g.horizontal) {
      const flick = Math.abs(dx) / dt > SWIPE_VELOCITY && Math.abs(dx) > 25;
      const target = dx < 0 ? index + 1 : index - 1;
      suppressClick.current = true;
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

    if (moved <= TAP_SLOP) {
      const now = performance.now();
      const prev = lastTap.current;
      if (prev && now - prev.t < DOUBLE_TAP_MS && Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < 40) {
        lastTap.current = null;
        suppressClick.current = true;
        toggleWithPulse();
      } else {
        lastTap.current = { t: now, x: e.clientX, y: e.clientY };
      }
    }
  }

  function onPointerCancel() {
    gesture.current = null;
    setSettling(true);
    setDragX(0);
  }

  return (
    <div
      className="viewer"
      onClickCapture={(e) => {
        // A swipe or double-tap must not also count as a click that closes the viewer.
        if (suppressClick.current) {
          suppressClick.current = false;
          e.stopPropagation();
        }
      }}
      onClick={() => {
        // Clicking the margin closes on desktop. On touch it doesn't: the first
        // half of a double-tap near the edge would otherwise close the viewer.
        if (lastPointerType.current === 'mouse') onClose();
      }}
    >
      <div className="viewer-head">
        <span className="viewer-title mono">
          {albumName && <span style={{ marginRight: 10 }}>{albumName}</span>}
          {img.filename}
        </span>
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

      <div
        className="viewer-stage"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      >
        <img
          key={img.id}
          src={`/i/${img.preview}`}
          alt={img.filename}
          draggable={false}
          onClick={(e) => e.stopPropagation()}
          style={{
            transform: dragX ? `translateX(${dragX}px)` : undefined,
            transition: settling ? 'transform 0.18s ease-out' : 'none',
          }}
        />
        {pulse && (
          <span key={pulse.key} className="viewer-pulse" onAnimationEnd={() => setPulse(null)}>
            {pulse.on ? '♥' : '♡'}
          </span>
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
                if (!window.confirm(`Delete ${img.filename}? Its selections go with it. This cannot be undone.`)) return;
                await onDelete(img.id);
              }}
            >
              Delete image
            </button>
          )}
          <span className="meta hint-keys">← → to move · F or Space to select · Esc to close</span>
          <span className="meta hint-touch">Swipe · double-tap to select</span>
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
