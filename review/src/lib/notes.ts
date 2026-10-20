import { ulid } from './ids';
import type { Env } from '../types';

/**
 * Retouch notes, shared by the owner's routes and the reviewer routes; each
 * caller has already checked that the viewer may see the image.
 *
 * Visibility follows selections: a hidden reviewer's notes are seen only by
 * the owner and by themselves.
 */

/** A mark on the photo; every coordinate is a fraction of its width or height. */
export type Shape =
  | { t: 'pen'; c: string; p: Array<[number, number]> }
  | { t: 'ellipse' | 'arrow'; c: string; a: [number, number]; b: [number, number] };

const COLOR = /^#[0-9a-f]{6}$/i;
const MAX_SHAPES = 30;
const MAX_POINTS = 600;

/** Validates and tidies drawn shapes; null if they aren't acceptable. */
function cleanShapes(v: unknown): Shape[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_SHAPES) return null;
  const unit = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
  const pt = (q: unknown): [number, number] | null =>
    Array.isArray(q) && q.length === 2 && unit(q[0]) && unit(q[1])
      ? [Math.round(q[0] * 1e4) / 1e4, Math.round(q[1] * 1e4) / 1e4]
      : null;
  const out: Shape[] = [];
  for (const s of v as Array<Record<string, unknown>>) {
    if (!s || typeof s !== 'object' || typeof s.c !== 'string' || !COLOR.test(s.c)) return null;
    if (s.t === 'pen') {
      if (!Array.isArray(s.p) || s.p.length < 2 || s.p.length > MAX_POINTS) return null;
      const p = s.p.map(pt);
      if (p.some((q) => !q)) return null;
      out.push({ t: 'pen', c: s.c, p: p as Array<[number, number]> });
    } else if (s.t === 'ellipse' || s.t === 'arrow') {
      const a = pt(s.a), b = pt(s.b);
      if (!a || !b) return null;
      out.push({ t: s.t, c: s.c, a, b });
    } else return null;
  }
  return out;
}

export interface NoteOut {
  id: string;
  parentId: string | null;
  x: number | null;
  y: number | null;
  body: string;
  shapes: Shape[] | null;
  author: string;
  mine: boolean;
  createdAt: number;
  resolvedAt: number | null;
  resolvedBy: string | null;
}

const MAX_BODY = 2000;

export async function listNotes(env: Env, imageId: string, viewerId: string, admin: boolean): Promise<NoteOut[]> {
  const { results } = await env.DB.prepare(
    `SELECT n.id, n.parent_id, n.x, n.y, n.body, n.shapes, n.created_at, n.resolved_at, n.reviewer_id,
            r.display_name AS author, rb.display_name AS resolver
       FROM notes n
       JOIN reviewers r ON r.id = n.reviewer_id
       LEFT JOIN reviewers rb ON rb.id = n.resolved_by
      WHERE n.image_id = ?1 AND (?2 OR r.hidden = 0 OR r.id = ?3)
      ORDER BY n.created_at`,
  )
    .bind(imageId, admin ? 1 : 0, viewerId)
    .all<{
      id: string; parent_id: string | null; x: number | null; y: number | null; body: string; shapes: string | null;
      created_at: number; resolved_at: number | null; reviewer_id: string; author: string; resolver: string | null;
    }>();
  const ids = new Set(results.map((n) => n.id));
  return results
    // A reply whose parent is hidden from this viewer has nothing to hang off.
    .filter((n) => !n.parent_id || ids.has(n.parent_id))
    .map((n) => ({
      id: n.id,
      parentId: n.parent_id,
      x: n.x,
      y: n.y,
      body: n.body,
      shapes: n.shapes ? (JSON.parse(n.shapes) as Shape[]) : null,
      author: n.author,
      mine: n.reviewer_id === viewerId,
      createdAt: n.created_at,
      resolvedAt: n.resolved_at,
      resolvedBy: n.resolved_at ? n.resolver : null,
    }));
}

/** Every note in a project, for the owner's retouch sheet and exports, in creation order. */
export async function listProjectNotes(env: Env, projectId: string, viewerId: string): Promise<Array<NoteOut & { imageId: string }>> {
  const { results } = await env.DB.prepare(
    `SELECT n.id, n.image_id, n.parent_id, n.x, n.y, n.body, n.shapes, n.created_at, n.resolved_at, n.reviewer_id,
            r.display_name AS author, rb.display_name AS resolver
       FROM notes n
       JOIN reviewers r ON r.id = n.reviewer_id
       LEFT JOIN reviewers rb ON rb.id = n.resolved_by
      WHERE n.project_id = ?
      ORDER BY n.created_at`,
  )
    .bind(projectId)
    .all<{
      id: string; image_id: string; parent_id: string | null; x: number | null; y: number | null; body: string;
      shapes: string | null; created_at: number; resolved_at: number | null; reviewer_id: string; author: string;
      resolver: string | null;
    }>();
  return results.map((n) => ({
    imageId: n.image_id,
    id: n.id,
    parentId: n.parent_id,
    x: n.x,
    y: n.y,
    body: n.body,
    shapes: n.shapes ? (JSON.parse(n.shapes) as Shape[]) : null,
    author: n.author,
    mine: n.reviewer_id === viewerId,
    createdAt: n.created_at,
    resolvedAt: n.resolved_at,
    resolvedBy: n.resolved_at ? n.resolver : null,
  }));
}

/**
 * A frame's notes as one line of text for a CSV: pinned notes by number, as on
 * screen, then general ones; replies after their note; resolved ones marked.
 */
export function notesLine(notes: Array<Pick<NoteOut, 'id' | 'parentId' | 'x' | 'body' | 'shapes' | 'author' | 'resolvedAt'>>): string {
  const numbers = new Map<string, number>();
  for (const n of notes) if (!n.parentId && n.x !== null) numbers.set(n.id, numbers.size + 1);
  const top = notes.filter((n) => !n.parentId);
  const say = (n: (typeof notes)[number]) => (n.body || (n.shapes?.length ? '(drawing)' : '')) + ` (${n.author})`;
  return top
    .map((n) => {
      const head = `${numbers.has(n.id) ? `${numbers.get(n.id)}.` : '•'} ${say(n)}${n.resolvedAt ? ' [resolved]' : ''}`;
      const replies = notes.filter((r) => r.parentId === n.id).map((r) => ` ↳ ${say(r)}`);
      return [head, ...replies].join('');
    })
    .join(' | ');
}

type Input = { x?: unknown; y?: unknown; body?: unknown; parentId?: unknown; shapes?: unknown };

/** Returns the new note's id, or an error message. */
export async function addNote(
  env: Env, projectId: string, imageId: string, reviewerId: string, input: Input,
): Promise<{ id: string } | { error: string }> {
  const body = typeof input.body === 'string' ? input.body.trim().slice(0, MAX_BODY) : '';
  let shapes: Shape[] | null = null;
  if (input.shapes !== undefined && input.shapes !== null) {
    shapes = cleanShapes(input.shapes);
    if (!shapes) return { error: 'shapes are not valid' };
  }
  // Marks can speak for themselves; anything else needs words.
  if (!body && !shapes) return { error: 'body required' };
  const inUnit = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
  let parentId: string | null = null;
  let x: number | null = null;
  let y: number | null = null;
  if (input.parentId !== undefined && input.parentId !== null) {
    if (typeof input.parentId !== 'string') return { error: 'parentId must be a string' };
    const parent = await env.DB.prepare(`SELECT id, parent_id FROM notes WHERE id = ? AND image_id = ?`)
      .bind(input.parentId, imageId)
      .first<{ id: string; parent_id: string | null }>();
    if (!parent) return { error: 'parent note not found' };
    parentId = parent.parent_id ?? parent.id; // replies stay one level deep
    shapes = null; // replies are words only
    if (!body) return { error: 'body required' };
  } else if (input.x !== undefined && input.x !== null) {
    if (!inUnit(input.x) || !inUnit(input.y)) return { error: 'x and y must be between 0 and 1' };
    x = input.x as number;
    y = input.y as number;
  }
  const id = ulid();
  await env.DB.prepare(
    `INSERT INTO notes (id, project_id, image_id, reviewer_id, parent_id, x, y, body, shapes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, projectId, imageId, reviewerId, parentId, x, y, body, shapes ? JSON.stringify(shapes) : null, Date.now())
    .run();
  return { id };
}

/** The note's image, if it belongs to this project; callers check the viewer can see that image. */
export async function noteImage(env: Env, noteId: string, projectId: string) {
  return env.DB.prepare(`SELECT image_id, reviewer_id FROM notes WHERE id = ? AND project_id = ?`)
    .bind(noteId, projectId)
    .first<{ image_id: string; reviewer_id: string }>();
}

/** Anyone who can see the photo can check a note off (or reopen it): that's the retoucher's job. */
export async function resolveNote(env: Env, noteId: string, reviewerId: string, resolved: boolean) {
  await env.DB.prepare(
    `UPDATE notes SET resolved_at = ?, resolved_by = ? WHERE id = ? AND parent_id IS NULL`,
  )
    .bind(resolved ? Date.now() : null, resolved ? reviewerId : null, noteId)
    .run();
}

/** Its replies go with it. */
export async function deleteNote(env: Env, noteId: string) {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM notes WHERE parent_id = ?`).bind(noteId),
    env.DB.prepare(`DELETE FROM notes WHERE id = ?`).bind(noteId),
  ]);
}
