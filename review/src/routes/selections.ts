import { Hono } from 'hono';
import { ulid } from '../lib/ids';
import { owner } from '../lib/owner';
import { buildGallery } from '../lib/gallery';
import { listNotes, listProjectNotes, addNote, noteImage, resolveNote, deleteNote } from '../lib/notes';
import { INTERNAL_OWNER } from '../types';
import type { Env, Vars } from '../types';
import type { Context } from 'hono';

type Ctx = Context<{ Bindings: Env; Variables: Vars }>;

const sel = new Hono<{ Bindings: Env; Variables: Vars }>();

/**
 * The people running a project select too, so each needs a reviewer identity
 * like anyone else — the whole point of the model is that nobody's picks
 * overwrite anybody else's. The row is tied to their account (user_id), and
 * its reserved address can never collide with a real reviewer's email, which
 * is what identifies reviewers within a project. The internal owner keeps the
 * address its picks were made under before accounts existed.
 */
const ownerAddress = (uid: string) => (uid === INTERNAL_OWNER ? '__admin__' : `__user__:${uid}`);

async function adminReviewer(c: Ctx, projectId: string, name?: string): Promise<string | null> {
  // Never mint an identity in a project that doesn't exist: the insert would
  // fail its foreign key and surface as a 500 instead of a 404.
  const project = await c.env.DB.prepare(`SELECT id FROM projects WHERE id = ?`).bind(projectId).first();
  if (!project) return null;
  const { uid, wid } = owner(c);
  const now = Date.now();
  const existing = await c.env.DB.prepare(
    `SELECT id FROM reviewers WHERE project_id = ? AND user_id = ?`,
  )
    .bind(projectId, uid)
    .first<{ id: string }>();

  if (existing) {
    if (name?.trim() && name.trim().length <= 80) {
      await c.env.DB.prepare(`UPDATE reviewers SET display_name = ?, last_seen_at = ? WHERE id = ?`)
        .bind(name.trim(), now, existing.id)
        .run();
    } else {
      await c.env.DB.prepare(`UPDATE reviewers SET last_seen_at = ? WHERE id = ?`)
        .bind(now, existing.id)
        .run();
    }
    return existing.id;
  }

  // First visit: named after the person, else their workspace (the studio).
  const who = await c.env.DB.prepare(
    `SELECT u.name AS person, w.name AS studio FROM users u, workspaces w WHERE u.id = ? AND w.id = ?`,
  )
    .bind(uid, wid)
    .first<{ person: string | null; studio: string | null }>();
  const id = ulid();
  await c.env.DB.prepare(
    `INSERT INTO reviewers (id, project_id, email_norm, display_name, created_at, last_seen_at, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, projectId, ownerAddress(uid),
      name?.trim() || who?.person || who?.studio || c.env.ADMIN_NAME || 'Owner', now, now, uid)
    .run();
  return id;
}

/** Rename the admin's own reviewer identity for a project. */
sel.post('/projects/:pid/me', async (c) => {
  const projectId = c.req.param('pid');
  const { name } = await c.req.json<{ name?: string }>().catch(() => ({ name: undefined }));
  const reviewerId = await adminReviewer(c, projectId, name);
  if (!reviewerId) return c.json({ error: 'project not found' }, 404);
  const row = await c.env.DB.prepare(`SELECT display_name FROM reviewers WHERE id = ?`)
    .bind(reviewerId)
    .first<{ display_name: string }>();
  return c.json({ reviewerId, name: row?.display_name ?? c.env.ADMIN_NAME });
});

/** The owner's gallery: every album, plus share settings and duplicate flags. */
sel.get('/projects/:pid/gallery', async (c) => {
  const projectId = c.req.param('pid');
  const reviewerId = await adminReviewer(c, projectId);
  if (!reviewerId) return c.json({ error: 'project not found' }, 404);
  const payload = await buildGallery(c.env, {
    projectId,
    reviewerId,
    albumIds: null,
    admin: true,
    includeSlug: true,
  });
  if (!payload) return c.json({ error: 'project not found' }, 404);
  return c.json(payload);
});

/**
 * Toggling is idempotent on both sides: the composite primary key makes a repeat
 * select a no-op and a repeat deselect harmless. Two people hitting the same
 * frame at the same moment both persist, which is the entire point.
 */
sel.put('/projects/:pid/selections/:imageId', async (c) => {
  const projectId = c.req.param('pid');
  const imageId = c.req.param('imageId');
  const reviewerId = await adminReviewer(c, projectId);
  if (!reviewerId) return c.json({ error: 'project not found' }, 404);

  const image = await c.env.DB.prepare(`SELECT id FROM images WHERE id = ? AND project_id = ?`)
    .bind(imageId, projectId)
    .first();
  if (!image) return c.json({ error: 'image not in project' }, 404);

  await c.env.DB.prepare(
    `INSERT OR IGNORE INTO selections (project_id, image_id, reviewer_id, created_at)
     VALUES (?, ?, ?, ?)`,
  )
    .bind(projectId, imageId, reviewerId, Date.now())
    .run();

  const count = await c.env.DB.prepare(`SELECT COUNT(*) n FROM selections WHERE image_id = ?`)
    .bind(imageId)
    .first<{ n: number }>();
  return c.json({ selected: true, count: count?.n ?? 1 });
});

sel.delete('/projects/:pid/selections/:imageId', async (c) => {
  const projectId = c.req.param('pid');
  const imageId = c.req.param('imageId');
  const reviewerId = await adminReviewer(c, projectId);
  if (!reviewerId) return c.json({ error: 'project not found' }, 404);

  await c.env.DB.prepare(`DELETE FROM selections WHERE image_id = ? AND reviewer_id = ?`)
    .bind(imageId, reviewerId)
    .run();

  const count = await c.env.DB.prepare(`SELECT COUNT(*) n FROM selections WHERE image_id = ?`)
    .bind(imageId)
    .first<{ n: number }>();
  return c.json({ selected: false, count: count?.n ?? 0 });
});

// ---- retouch notes (owner) ----

/** Every note in the project at once: what the retouch sheet is built from. */
sel.get('/projects/:pid/notes', async (c) => {
  const projectId = c.req.param('pid');
  const reviewerId = await adminReviewer(c, projectId);
  if (!reviewerId) return c.json({ error: 'project not found' }, 404);
  return c.json({ notes: await listProjectNotes(c.env, projectId, reviewerId) });
});

sel.get('/projects/:pid/images/:imageId/notes', async (c) => {
  const projectId = c.req.param('pid');
  const reviewerId = await adminReviewer(c, projectId);
  if (!reviewerId) return c.json({ error: 'project not found' }, 404);
  return c.json({ notes: await listNotes(c.env, c.req.param('imageId'), reviewerId, true) });
});

sel.post('/projects/:pid/images/:imageId/notes', async (c) => {
  const projectId = c.req.param('pid');
  const imageId = c.req.param('imageId');
  const reviewerId = await adminReviewer(c, projectId);
  if (!reviewerId) return c.json({ error: 'project not found' }, 404);
  const image = await c.env.DB.prepare(`SELECT id FROM images WHERE id = ? AND project_id = ?`)
    .bind(imageId, projectId)
    .first();
  if (!image) return c.json({ error: 'image not in project' }, 404);
  const res = await addNote(c.env, projectId, imageId, reviewerId, await c.req.json().catch(() => ({})));
  if ('error' in res) return c.json(res, 400);
  return c.json({ id: res.id, notes: await listNotes(c.env, imageId, reviewerId, true) }, 201);
});

sel.post('/projects/:pid/notes/:noteId/resolve', async (c) => {
  const projectId = c.req.param('pid');
  const reviewerId = await adminReviewer(c, projectId);
  if (!reviewerId) return c.json({ error: 'project not found' }, 404);
  const note = await noteImage(c.env, c.req.param('noteId'), projectId);
  if (!note) return c.json({ error: 'note not found' }, 404);
  const { resolved } = await c.req.json<{ resolved?: boolean }>().catch(() => ({ resolved: undefined }));
  if (typeof resolved !== 'boolean') return c.json({ error: 'resolved: boolean required' }, 400);
  await resolveNote(c.env, c.req.param('noteId'), reviewerId, resolved);
  return c.json({ notes: await listNotes(c.env, note.image_id, reviewerId, true) });
});

/** The owner can remove anyone's note. */
sel.delete('/projects/:pid/notes/:noteId', async (c) => {
  const projectId = c.req.param('pid');
  const reviewerId = await adminReviewer(c, projectId);
  if (!reviewerId) return c.json({ error: 'project not found' }, 404);
  const note = await noteImage(c.env, c.req.param('noteId'), projectId);
  if (!note) return c.json({ error: 'note not found' }, 404);
  await deleteNote(c.env, c.req.param('noteId'));
  return c.json({ notes: await listNotes(c.env, note.image_id, reviewerId, true) });
});

export default sel;
