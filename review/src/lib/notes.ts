import { ulid } from './ids';
import type { Env } from '../types';

/**
 * Retouch notes, shared by the owner's routes and the reviewer routes; each
 * caller has already checked that the viewer may see the image.
 *
 * Visibility follows selections: a hidden reviewer's notes are seen only by
 * the owner and by themselves.
 */

export interface NoteOut {
  id: string;
  parentId: string | null;
  x: number | null;
  y: number | null;
  body: string;
  author: string;
  mine: boolean;
  createdAt: number;
  resolvedAt: number | null;
  resolvedBy: string | null;
}

const MAX_BODY = 2000;

export async function listNotes(env: Env, imageId: string, viewerId: string, admin: boolean): Promise<NoteOut[]> {
  const { results } = await env.DB.prepare(
    `SELECT n.id, n.parent_id, n.x, n.y, n.body, n.created_at, n.resolved_at, n.reviewer_id,
            r.display_name AS author, rb.display_name AS resolver
       FROM notes n
       JOIN reviewers r ON r.id = n.reviewer_id
       LEFT JOIN reviewers rb ON rb.id = n.resolved_by
      WHERE n.image_id = ?1 AND (?2 OR r.hidden = 0 OR r.id = ?3)
      ORDER BY n.created_at`,
  )
    .bind(imageId, admin ? 1 : 0, viewerId)
    .all<{
      id: string; parent_id: string | null; x: number | null; y: number | null; body: string;
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
      author: n.author,
      mine: n.reviewer_id === viewerId,
      createdAt: n.created_at,
      resolvedAt: n.resolved_at,
      resolvedBy: n.resolved_at ? n.resolver : null,
    }));
}

type Input = { x?: unknown; y?: unknown; body?: unknown; parentId?: unknown };

/** Returns the new note's id, or an error message. */
export async function addNote(
  env: Env, projectId: string, imageId: string, reviewerId: string, input: Input,
): Promise<{ id: string } | { error: string }> {
  const body = typeof input.body === 'string' ? input.body.trim().slice(0, MAX_BODY) : '';
  if (!body) return { error: 'body required' };
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
  } else if (input.x !== undefined && input.x !== null) {
    if (!inUnit(input.x) || !inUnit(input.y)) return { error: 'x and y must be between 0 and 1' };
    x = input.x as number;
    y = input.y as number;
  }
  const id = ulid();
  await env.DB.prepare(
    `INSERT INTO notes (id, project_id, image_id, reviewer_id, parent_id, x, y, body, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, projectId, imageId, reviewerId, parentId, x, y, body, Date.now())
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
