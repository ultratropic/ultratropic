import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

export interface Img {
  id: string;
  filename: string;
  thumb: string;
  preview: string;
  w: number;
  h: number;
  selects?: number;
  mine?: boolean;
}

interface Row {
  items: Array<{ img: Img; w: number; h: number }>;
  height: number;
  top: number;
}

const GAP = 6;
const TARGET_ROW_HEIGHT = 260;
const OVERSCAN = 900; // px of off-screen rows to keep mounted

/**
 * Justified rows, the layout every photo tool converges on: each row is scaled to
 * fill the width at roughly a target height, so frames keep their true aspect ratio
 * and nothing is cropped. Portrait and landscape can then sit side by side.
 */
function layout(images: Img[], containerWidth: number): { rows: Row[]; total: number } {
  const rows: Row[] = [];
  let current: Img[] = [];
  let ratioSum = 0;
  let top = 0;

  const flush = (isLast: boolean) => {
    if (!current.length) return;
    const gaps = GAP * (current.length - 1);
    const available = containerWidth - gaps;
    // A trailing row keeps the target height rather than stretching to fill.
    const height = isLast
      ? Math.min(TARGET_ROW_HEIGHT, available / ratioSum)
      : available / ratioSum;
    rows.push({
      items: current.map((img) => ({
        img,
        w: Math.round((img.w / img.h) * height),
        h: Math.round(height),
      })),
      height: Math.round(height),
      top,
    });
    top += Math.round(height) + GAP;
    current = [];
    ratioSum = 0;
  };

  for (const img of images) {
    current.push(img);
    ratioSum += img.w / img.h;
    const gaps = GAP * (current.length - 1);
    if ((containerWidth - gaps) / ratioSum <= TARGET_ROW_HEIGHT) flush(false);
  }
  flush(true);
  return { rows, total: top };
}

export default function Grid({
  images,
  onOpen,
  onToggle,
  onDelete,
  showNames = false,
}: {
  images: Img[];
  onOpen: (index: number) => void;
  onToggle?: (id: string) => void;
  /** Owner only; shown where deleting is the point, e.g. reviewing duplicates. */
  onDelete?: (img: Img) => void;
  /** Filenames on the tiles — what tells two near-identical frames apart. */
  showNames?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [range, setRange] = useState({ top: 0, bottom: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width));
    ro.observe(el);
    setWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);

  /**
   * Track the visible window in THIS grid's own coordinates, from its live
   * bounding rect. offsetTop is relative to the offset parent, not the document,
   * so with one grid per album section every section computed an offset near
   * zero, thought it was on screen, and mounted all its tiles.
   *
   * Measured synchronously rather than inside requestAnimationFrame: rAF is
   * paused in a background tab, which would freeze the window wherever it last
   * landed. Re-rendering only when the window has moved a meaningful distance
   * keeps the cost of measuring on every scroll event down.
   */
  useEffect(() => {
    let last = { top: NaN, bottom: NaN };
    const update = () => {
      const el = ref.current;
      if (!el) return;
      const { top } = el.getBoundingClientRect();
      const next = { top: -top - OVERSCAN, bottom: -top + window.innerHeight + OVERSCAN };
      if (Math.abs(next.top - last.top) < 120 && Math.abs(next.bottom - last.bottom) < 120) return;
      last = next;
      setRange(next);
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, []);

  const { rows, total } = useMemo(
    () => (width > 0 ? layout(images, width) : { rows: [], total: 0 }),
    [images, width],
  );

  // Index of each image, so a click can open the viewer at the right position.
  const indexOf = useMemo(() => {
    const m = new Map<string, number>();
    images.forEach((img, i) => m.set(img.id, i));
    return m;
  }, [images]);

  const visible = rows.filter((r) => r.top + r.height >= range.top && r.top <= range.bottom);

  return (
    <div ref={ref} style={{ position: 'relative', height: total }}>
      {visible.map((row) => (
        <div
          key={row.top}
          style={{ position: 'absolute', top: row.top, left: 0, display: 'flex', gap: GAP }}
        >
          {row.items.map(({ img, w, h }) => (
            <div key={img.id} className={`tile${img.mine ? ' selected' : ''}`} style={{ width: w, height: h }}>
              <button
                onClick={() => onOpen(indexOf.get(img.id)!)}
                title={img.filename}
                style={{
                  width: '100%', height: '100%', padding: 0, border: 'none', borderRadius: 0,
                  background: 'var(--line)', cursor: 'zoom-in', overflow: 'hidden', display: 'block',
                }}
              >
                <img
                  src={`/i/${img.thumb}`}
                  alt={img.filename}
                  loading="lazy"
                  decoding="async"
                  width={w}
                  height={h}
                  style={{ display: 'block', width: '100%', height: '100%', objectFit: 'cover' }}
                />
              </button>
              {showNames && <span className="tile-name mono">{img.filename}</span>}
              {onDelete && (
                <button
                  className="tile-delete"
                  aria-label={`Delete ${img.filename}`}
                  onClick={(e) => { e.stopPropagation(); onDelete(img); }}
                >
                  Delete
                </button>
              )}
              {onToggle && (
                <button
                  className={`heart${img.mine ? ' on' : ''}`}
                  aria-pressed={!!img.mine}
                  aria-label={img.mine ? `Deselect ${img.filename}` : `Select ${img.filename}`}
                  onClick={(e) => { e.stopPropagation(); onToggle(img.id); }}
                >
                  {img.mine ? '♥' : '♡'}
                  {!!img.selects && img.selects > 0 && <span className="count">{img.selects}</span>}
                </button>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
