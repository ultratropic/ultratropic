import { Hono } from 'hono';
import { ulid } from '../lib/ids';
import { readAdmin } from '../lib/auth';
import { buildGallery } from '../lib/gallery';
import type { Env, Vars } from '../types';

const sel = new Hono<{ Bindings: Env; Variables: Vars }>();

sel.use('*', async (c, next) => {
  const session = await readAdmin(c);
  if (!session) return c.json({ error: 'unauthorized' }, 401);
  c.set('admin', session);
  await next();
});

/**
 * The admin selects too, so they need a reviewer identity like anyone else —
 * the whole point of the model is that nobody's picks overwrite anybody else's.
 * A reserved address keeps that row from ever colliding with a real reviewer's
 * email, which is what identifies reviewers within a project.
 */
const ADMIN_EMAIL = '__admin__';

async function adminReviewer(c: { env: Env }, projectId: string, name?: string): Promise<string> {
  const now = Date.now();
  const existing = await c.env.DB.prepare(
    `SELECT id FROM reviewers WHERE project_id = ? AND email_norm = ?`,
  )
    .bind(projectId, ADMIN_EMAIL)
    .first<{ id: string }>();

  if (existing) {
    if (name?.trim()) {
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

  const id = ulid();
  await c.env.DB.prepare(
    `INSERT INTO reviewers (id, project_id, email_norm, display_name, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, projectId, ADMIN_EMAIL, name?.trim() || c.env.ADMIN_NAME || 'Ultratropic', now, now)
    .run();
  return id;
}

/** Rename the admin's own reviewer identity for a project. */
sel.post('/projects/:pid/me', async (c) => {
  const projectId = c.req.param('pid');
  const { name } = await c.req.json<{ name?: string }>().catch(() => ({ name: undefined }));
  const reviewerId = await adminReviewer(c, projectId, name);
  const row = await c.env.DB.prepare(`SELECT display_name FROM reviewers WHERE id = ?`)
    .bind(reviewerId)
    .first<{ display_name: string }>();
  return c.json({ reviewerId, name: row?.display_name ?? c.env.ADMIN_NAME });
});

/** The owner's gallery: every album, plus share settings and duplicate flags. */
sel.get('/projects/:pid/gallery', async (c) => {
  const projectId = c.req.param('pid');
  const reviewerId = await adminReviewer(c, projectId);
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

  await c.env.DB.prepare(`DELETE FROM selections WHERE image_id = ? AND reviewer_id = ?`)
    .bind(imageId, reviewerId)
    .run();

  const count = await c.env.DB.prepare(`SELECT COUNT(*) n FROM selections WHERE image_id = ?`)
    .bind(imageId)
    .first<{ n: number }>();
  return c.json({ selected: false, count: count?.n ?? 0 });
});

export default sel;
