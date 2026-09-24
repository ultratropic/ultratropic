import { Hono } from 'hono';
import { ulid, token, slugify } from '../lib/ids';
import { hashPassword, timingSafeEqual } from '../lib/crypto';
import { issueAdminCookie, readAdmin, clearAdminCookie } from '../lib/auth';
import type { Env, Vars } from '../types';

const admin = new Hono<{ Bindings: Env; Variables: Vars }>();

/** Everything under /api/admin except login requires the admin cookie. */
admin.use('*', async (c, next) => {
  if (c.req.path.endsWith('/login')) return next();
  const session = await readAdmin(c);
  if (!session) return c.json({ error: 'unauthorized' }, 401);
  c.set('admin', session);
  await next();
});

admin.post('/login', async (c) => {
  const { password } = await c.req.json<{ password?: string }>().catch(() => ({ password: undefined }));
  if (!password || !timingSafeEqual(password, c.env.ADMIN_PASSWORD)) {
    return c.json({ error: 'invalid password' }, 401);
  }
  await issueAdminCookie(c);
  return c.json({ ok: true });
});

admin.post('/logout', (c) => {
  clearAdminCookie(c);
  return c.json({ ok: true });
});

admin.get('/me', (c) => c.json({ admin: true }));

/** Dashboard: projects with album/image/reviewer/select counts in one round trip. */
admin.get('/projects', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT p.id, p.slug, p.name, p.description, p.status, p.preview_edge, p.created_at,
            p.password_hash IS NOT NULL AS has_password,
            (SELECT COUNT(*) FROM albums    a WHERE a.project_id = p.id) AS album_count,
            (SELECT COUNT(*) FROM images    i WHERE i.project_id = p.id) AS image_count,
            (SELECT COUNT(*) FROM reviewers r WHERE r.project_id = p.id) AS reviewer_count,
            (SELECT COUNT(DISTINCT s.image_id) FROM selections s WHERE s.project_id = p.id) AS selected_count
       FROM projects p
      ORDER BY p.created_at DESC`,
  ).all();
  return c.json({ projects: results });
});

admin.post('/projects', async (c) => {
  const body = await c.req
    .json<{ name?: string; description?: string; password?: string; previewEdge?: number }>()
    .catch(() => ({}) as Record<string, never>);

  const name = body.name?.trim();
  if (!name) return c.json({ error: 'name is required' }, 400);

  const id = ulid();
  const slug = token(10);
  const previewEdge = Number.isInteger(body.previewEdge) ? body.previewEdge! : 2400;

  let hash: string | null = null;
  let salt: string | null = null;
  if (body.password?.trim()) {
    const derived = await hashPassword(body.password.trim());
    hash = derived.hash;
    salt = derived.salt;
  }

  await c.env.DB.prepare(
    `INSERT INTO projects (id, slug, name, description, password_hash, password_salt, preview_edge, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
  )
    .bind(id, slug, name, body.description?.trim() || null, hash, salt, previewEdge, Date.now())
    .run();

  return c.json({ id, slug, name, url: `/p/${slug}` }, 201);
});

/** Albums for a project, with per-album counts for the dashboard and album index. */
admin.get('/projects/:id/albums', async (c) => {
  const projectId = c.req.param('id');
  const { results } = await c.env.DB.prepare(
    `SELECT a.id, a.name, a.slug, a.seq, a.created_at,
            a.password_hash IS NOT NULL AS has_password,
            (SELECT COUNT(*) FROM images i WHERE i.album_id = a.id) AS image_count
       FROM albums a
      WHERE a.project_id = ?
      ORDER BY a.seq`,
  )
    .bind(projectId)
    .all();
  return c.json({ albums: results });
});

/** Called by the uploader before sending files: resolves a folder name to an album, idempotently. */
admin.post('/projects/:id/albums', async (c) => {
  const projectId = c.req.param('id');
  const { name } = await c.req.json<{ name?: string }>().catch(() => ({ name: undefined }));
  const albumName = name?.trim() || 'Untitled';
  const slug = slugify(albumName);

  const existing = await c.env.DB.prepare(
    `SELECT id, name, slug, seq FROM albums WHERE project_id = ? AND slug = ?`,
  )
    .bind(projectId, slug)
    .first();
  if (existing) return c.json({ album: existing, created: false });

  const project = await c.env.DB.prepare(`SELECT id FROM projects WHERE id = ?`).bind(projectId).first();
  if (!project) return c.json({ error: 'project not found' }, 404);

  const row = await c.env.DB.prepare(
    `SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM albums WHERE project_id = ?`,
  )
    .bind(projectId)
    .first<{ next: number }>();

  const id = ulid();
  const seq = row?.next ?? 0;
  await c.env.DB.prepare(
    `INSERT INTO albums (id, project_id, name, slug, seq, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, projectId, albumName, slug, seq, Date.now())
    .run();

  return c.json({ album: { id, name: albumName, slug, seq }, created: true }, 201);
});

/**
 * Delete a project and everything under it, including its R2 objects.
 * Rows are removed explicitly rather than relying on cascade, so this behaves the
 * same whether or not foreign keys are enforced.
 */
admin.delete('/projects/:id', async (c) => {
  const projectId = c.req.param('id');
  const project = await c.env.DB.prepare(`SELECT id, name FROM projects WHERE id = ?`)
    .bind(projectId)
    .first<{ id: string; name: string }>();
  if (!project) return c.json({ error: 'project not found' }, 404);

  // Drop the blobs first. A failure here leaves rows intact, so a retry still
  // knows which objects to clean up; the reverse would orphan them forever.
  const { results: keys } = await c.env.DB.prepare(
    `SELECT thumb_key, preview_key FROM images WHERE project_id = ?`,
  )
    .bind(projectId)
    .all<{ thumb_key: string; preview_key: string }>();

  const allKeys = keys.flatMap((k) => [k.thumb_key, k.preview_key]);
  for (let i = 0; i < allKeys.length; i += 900) {
    await c.env.BUCKET.delete(allKeys.slice(i, i + 900));
  }

  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM selections WHERE project_id = ?`).bind(projectId),
    c.env.DB.prepare(`DELETE FROM images     WHERE project_id = ?`).bind(projectId),
    c.env.DB.prepare(`DELETE FROM reviewers  WHERE project_id = ?`).bind(projectId),
    c.env.DB.prepare(`DELETE FROM albums     WHERE project_id = ?`).bind(projectId),
    c.env.DB.prepare(`DELETE FROM projects   WHERE id = ?`).bind(projectId),
  ]);

  return c.json({ deleted: project.name, images: keys.length, blobs: allKeys.length });
});

/**
 * Remove a reviewer and every selection they made. Their browser still holds a
 * signed session, so the reviewer routes re-check that the person exists and
 * send them back to the join screen; rejoining starts them from nothing.
 * The owner's own identity can't be removed this way.
 */
admin.delete('/reviewers/:id', async (c) => {
  const r = await c.env.DB.prepare(`SELECT id, display_name, email_norm FROM reviewers WHERE id = ?`)
    .bind(c.req.param('id'))
    .first<{ id: string; display_name: string; email_norm: string }>();
  if (!r) return c.json({ error: 'reviewer not found' }, 404);
  if (r.email_norm === '__admin__') return c.json({ error: "can't remove the owner" }, 400);

  const removed = await c.env.DB.prepare(`SELECT COUNT(*) n FROM selections WHERE reviewer_id = ?`)
    .bind(r.id)
    .first<{ n: number }>();
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM selections WHERE reviewer_id = ?`).bind(r.id),
    c.env.DB.prepare(`DELETE FROM reviewers WHERE id = ?`).bind(r.id),
  ]);
  return c.json({ removed: r.display_name, selections: removed?.n ?? 0 });
});

/** Hide a reviewer's name and picks from other reviewers, or show them again. */
admin.post('/reviewers/:id/hidden', async (c) => {
  const { hidden } = await c.req.json<{ hidden?: boolean }>().catch(() => ({ hidden: undefined }));
  if (typeof hidden !== 'boolean') return c.json({ error: 'hidden: boolean required' }, 400);
  const res = await c.env.DB.prepare(`UPDATE reviewers SET hidden = ? WHERE id = ?`)
    .bind(hidden ? 1 : 0, c.req.param('id'))
    .run();
  if (!res.meta.changes) return c.json({ error: 'reviewer not found' }, 404);
  return c.json({ hidden });
});

/** Remove one frame: its derivatives, its selections, its row. */
admin.delete('/images/:id', async (c) => {
  const img = await c.env.DB.prepare(`SELECT id, thumb_key, preview_key FROM images WHERE id = ?`)
    .bind(c.req.param('id'))
    .first<{ id: string; thumb_key: string; preview_key: string }>();
  if (!img) return c.json({ error: 'image not found' }, 404);

  await c.env.BUCKET.delete([img.thumb_key, img.preview_key]);
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM selections WHERE image_id = ?`).bind(img.id),
    c.env.DB.prepare(`DELETE FROM images WHERE id = ?`).bind(img.id),
  ]);
  return c.json({ deleted: img.id });
});

/** Remove an album and everything in it — the way to redo a botched upload. */
admin.delete('/albums/:id', async (c) => {
  const albumId = c.req.param('id');
  const album = await c.env.DB.prepare(`SELECT id, name FROM albums WHERE id = ?`)
    .bind(albumId)
    .first<{ id: string; name: string }>();
  if (!album) return c.json({ error: 'album not found' }, 404);

  const { results: keys } = await c.env.DB.prepare(
    `SELECT thumb_key, preview_key FROM images WHERE album_id = ?`,
  )
    .bind(albumId)
    .all<{ thumb_key: string; preview_key: string }>();
  const allKeys = keys.flatMap((k) => [k.thumb_key, k.preview_key]);
  for (let i = 0; i < allKeys.length; i += 900) {
    await c.env.BUCKET.delete(allKeys.slice(i, i + 900));
  }

  await c.env.DB.batch([
    c.env.DB.prepare(
      `DELETE FROM selections WHERE image_id IN (SELECT id FROM images WHERE album_id = ?)`,
    ).bind(albumId),
    c.env.DB.prepare(`DELETE FROM images WHERE album_id = ?`).bind(albumId),
    c.env.DB.prepare(`DELETE FROM albums WHERE id = ?`).bind(albumId),
  ]);
  return c.json({ deleted: album.name, images: keys.length });
});

/**
 * Create or update an album's client link. The token is minted on first share
 * and then kept, so a link already sent keeps working when the password changes.
 * password: string sets it, null removes it, omitted leaves it alone.
 */
admin.post('/albums/:id/share', async (c) => {
  const albumId = c.req.param('id');
  const body = await c.req
    .json<{ password?: string | null }>()
    .catch(() => ({}) as { password?: string | null });

  const album = await c.env.DB.prepare(
    `SELECT id, share_token, password_hash, password_salt FROM albums WHERE id = ?`,
  )
    .bind(albumId)
    .first<{ id: string; share_token: string | null; password_hash: string | null; password_salt: string | null }>();
  if (!album) return c.json({ error: 'album not found' }, 404);

  const shareToken = album.share_token ?? token(16);
  let hash = album.password_hash;
  let salt = album.password_salt;
  if (body.password === null) {
    hash = null;
    salt = null;
  } else if (typeof body.password === 'string' && body.password.trim()) {
    const derived = await hashPassword(body.password.trim());
    hash = derived.hash;
    salt = derived.salt;
  }

  await c.env.DB.prepare(
    `UPDATE albums SET share_token = ?, password_hash = ?, password_salt = ? WHERE id = ?`,
  )
    .bind(shareToken, hash, salt, albumId)
    .run();
  return c.json({ shareToken, hasPassword: !!hash });
});

/**
 * Which of these filenames are already in the project, and where. Lets the
 * uploader warn before re-uploading a folder rather than after.
 */
admin.post('/projects/:pid/existing', async (c) => {
  const { names } = await c.req
    .json<{ names?: string[] }>()
    .catch(() => ({ names: undefined }));
  if (!Array.isArray(names) || names.length > 20000) return c.json({ error: 'names[] required' }, 400);

  const { results } = await c.env.DB.prepare(
    `SELECT i.original_filename, a.name AS album
       FROM images i JOIN albums a ON a.id = i.album_id
      WHERE i.project_id = ?`,
  )
    .bind(c.req.param('pid'))
    .all<{ original_filename: string; album: string }>();

  const wanted = new Set(names);
  const existing: Record<string, string> = {};
  for (const r of results) if (wanted.has(r.original_filename)) existing[r.original_filename] = r.album;
  return c.json({ existing });
});

export default admin;
