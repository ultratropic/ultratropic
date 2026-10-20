import { useEffect, useRef, useState } from 'react';

export interface Note {
  id: string;
  parentId: string | null;
  /** Pin position as a fraction of the photo's width and height; null for a general note. */
  x: number | null;
  y: number | null;
  body: string;
  author: string;
  mine: boolean;
  createdAt: number;
  resolvedAt: number | null;
  resolvedBy: string | null;
}

export interface NotesApi {
  list: (imageId: string) => Promise<Note[]>;
  add: (imageId: string, input: { x?: number; y?: number; body: string; parentId?: string }) => Promise<Note[]>;
  resolve: (noteId: string, resolved: boolean) => Promise<Note[]>;
  remove: (noteId: string) => Promise<Note[]>;
}

/** Pinned top-level notes, numbered in the order they were made. Resolving one keeps its number. */
export function pinNumbers(notes: Note[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const n of notes) if (!n.parentId && n.x !== null) m.set(n.id, m.size + 1);
  return m;
}

function when(ms: number): string {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** A textarea that sends on ⌘/Ctrl-Enter and cancels on Escape. */
function Composer({ placeholder, label, onSubmit, onCancel, autoFocus }: {
  placeholder: string;
  label: string;
  onSubmit: (body: string) => Promise<void>;
  onCancel?: () => void;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (autoFocus) ref.current?.focus(); }, [autoFocus]);
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      await onSubmit(text.trim());
      setText('');
    } catch (err) {
      setError((err as Error).message || 'Could not save that note.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="note-composer">
      <textarea
        ref={ref}
        rows={2}
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); }
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel?.(); (e.target as HTMLElement).blur(); }
        }}
      />
      <div className="note-composer-actions">
        <button className="small" disabled={!text.trim() || busy} onClick={() => void send()}>{busy ? 'Saving…' : label}</button>
        {onCancel && <button className="text-btn" onClick={onCancel}>Cancel</button>}
        {error && <span className="err">{error}</span>}
      </div>
    </div>
  );
}

export default function NotesPanel({
  notes,
  loadError,
  activeId,
  onActivate,
  draft,
  draftNumber,
  onDraftCancel,
  onAdd,
  onResolve,
  onDelete,
  canDelete,
  onClose,
  touch,
}: {
  notes: Note[] | null;
  loadError: string;
  activeId: string | null;
  onActivate: (id: string | null) => void;
  /** A pin placed on the photo, waiting for its text. */
  draft: { x: number; y: number } | null;
  draftNumber: number;
  onDraftCancel: () => void;
  onAdd: (input: { x?: number; y?: number; body: string; parentId?: string }) => Promise<void>;
  onResolve: (id: string, resolved: boolean) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  canDelete: (n: Note) => boolean;
  onClose: () => void;
  touch: boolean;
}) {
  const [showResolved, setShowResolved] = useState(false);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const numbers = pinNumbers(notes ?? []);
  const top = (notes ?? []).filter((n) => !n.parentId);
  const resolved = top.filter((n) => n.resolvedAt);
  const shown = top.filter((n) => showResolved || !n.resolvedAt || n.id === activeId);
  const replies = (id: string) => (notes ?? []).filter((n) => n.parentId === id);

  // Clicking a pin on the photo brings its note into view.
  useEffect(() => {
    if (!activeId) return;
    listRef.current?.querySelector(`[data-note="${activeId}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeId]);

  return (
    <aside className="notes-panel" onClick={(e) => e.stopPropagation()} aria-label="Notes">
      <div className="notes-head">
        <strong>Notes</strong>
        <span className="meta">{top.length - resolved.length} open</span>
        {resolved.length > 0 && (
          <button className="text-btn" onClick={() => setShowResolved((v) => !v)}>
            {showResolved ? 'Hide' : 'Show'} {resolved.length} resolved
          </button>
        )}
        <button className="notes-close" aria-label="Close notes" onClick={onClose}>×</button>
      </div>

      <div className="notes-list" ref={listRef}>
        {draft && (
          <div className="note draft">
            <div className="note-meta"><span className="pin-badge">{draftNumber}</span> New note</div>
            <Composer
              autoFocus
              label="Add note"
              placeholder="What should change here?"
              onSubmit={(body) => onAdd({ x: draft.x, y: draft.y, body })}
              onCancel={onDraftCancel}
            />
          </div>
        )}

        {notes === null && !loadError && <p className="meta">Loading…</p>}
        {loadError && <p className="err">{loadError}</p>}
        {notes !== null && top.length === 0 && !draft && (
          <p className="meta notes-empty">
            {touch ? 'Tap' : 'Click'} the photo to pin a note to that spot, or add a general note below.
          </p>
        )}

        {shown.map((n) => (
          <div
            key={n.id}
            data-note={n.id}
            className={`note${n.resolvedAt ? ' resolved' : ''}${n.id === activeId ? ' active' : ''}`}
            onClick={() => onActivate(n.id === activeId ? null : n.id)}
          >
            <div className="note-meta">
              {numbers.has(n.id) ? <span className="pin-badge">{numbers.get(n.id)}</span> : <span className="pin-badge general">•</span>}
              <span className="note-author">{n.mine ? 'You' : n.author}</span>
              <span className="meta">{when(n.createdAt)}</span>
              {n.resolvedAt && <span className="meta">· resolved{n.resolvedBy ? ` by ${n.resolvedBy}` : ''}</span>}
            </div>
            <p className="note-body">{n.body}</p>
            {replies(n.id).map((r) => (
              <div key={r.id} className="note-reply">
                <div className="note-meta">
                  <span className="note-author">{r.mine ? 'You' : r.author}</span>
                  <span className="meta">{when(r.createdAt)}</span>
                  {canDelete(r) && (
                    <button className="text-btn" onClick={(e) => {
                      e.stopPropagation();
                      if (window.confirm('Delete this reply?')) void onDelete(r.id);
                    }}>Delete</button>
                  )}
                </div>
                <p className="note-body">{r.body}</p>
              </div>
            ))}
            <div className="note-actions" onClick={(e) => e.stopPropagation()}>
              <button className="text-btn" onClick={() => setReplyTo(replyTo === n.id ? null : n.id)}>Reply</button>
              <button className="text-btn" onClick={() => void onResolve(n.id, !n.resolvedAt)}>
                {n.resolvedAt ? 'Reopen' : 'Resolve'}
              </button>
              {canDelete(n) && (
                <button className="text-btn danger" onClick={() => {
                  if (window.confirm('Delete this note and its replies?')) void onDelete(n.id);
                }}>Delete</button>
              )}
            </div>
            {replyTo === n.id && (
              <div onClick={(e) => e.stopPropagation()}>
                <Composer
                  autoFocus
                  label="Reply"
                  placeholder="Reply…"
                  onSubmit={async (body) => { await onAdd({ body, parentId: n.id }); setReplyTo(null); }}
                  onCancel={() => setReplyTo(null)}
                />
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="notes-foot">
        <Composer label="Add" placeholder="General note for this photo…" onSubmit={(body) => onAdd({ body })} />
      </div>
    </aside>
  );
}
