import { useEffect } from 'react';
import type { Img } from './Grid';

/**
 * Full-screen review. Keyboard-first: the whole point is to sit and move through
 * hundreds of frames without returning to the grid between each one.
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
}) {
  const img = images[index];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight') onIndex(Math.min(index + 1, images.length - 1));
      else if (e.key === 'ArrowLeft') onIndex(Math.max(index - 1, 0));
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, images.length, onIndex, onClose]);

  // Prefetch the next few so arrowing through feels instant rather than staged.
  useEffect(() => {
    for (let i = index + 1; i <= Math.min(index + 3, images.length - 1); i++) {
      const next = images[i];
      if (next) new Image().src = `/i/${next.preview}`;
    }
  }, [index, images]);

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  if (!img) return null;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 50, background: 'var(--bg)',
        display: 'flex', flexDirection: 'column',
      }}
    >
      <div
        style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '12px 16px', flexShrink: 0,
        }}
      >
        <span className="mono" style={{ color: 'var(--muted)' }}>
          {albumName && <span style={{ marginRight: 10 }}>{albumName}</span>}
          {img.filename}
        </span>
        <span className="meta">
          {img.selects ? `${img.selects} select${img.selects === 1 ? '' : 's'} · ` : ''}
          {index + 1} / {images.length}
        </span>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 16px 16px' }}>
        <img
          src={`/i/${img.preview}`}
          alt={img.filename}
          onClick={(e) => e.stopPropagation()}
          style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', cursor: 'default' }}
        />
      </div>

      <div style={{ padding: '0 16px 16px', flexShrink: 0, display: 'flex',
        alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
        {onToggle ? (
          <button
            className={`heart big${img.mine ? ' on' : ''}`}
            aria-pressed={!!img.mine}
            onClick={(e) => { e.stopPropagation(); onToggle(img.id); }}
          >
            {img.mine ? '♥' : '♡'} {img.mine ? 'Selected' : 'Select'}
          </button>
        ) : <span />}
        <span style={{ display: 'flex', gap: 18, alignItems: 'center' }}>
          {onSetCover && (
            img.id === coverId ? (
              <span className="meta">Project cover</span>
            ) : (
              <button
                className="text-btn"
                onClick={(e) => { e.stopPropagation(); onSetCover(img.id); }}
              >
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
          <span className="meta">← → to move · F or Space to select · Esc to close</span>
        </span>
      </div>
    </div>
  );
}
