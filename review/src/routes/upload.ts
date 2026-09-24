import { Hono } from 'hono';
import { ulid, storageKey, baseName } from '../lib/ids';
import { readAdmin } from '../lib/auth';
import type { Env, Vars } from '../types';

const upload = new Hono<{ Bindings: Env; Variables: Vars }>();

upload.use('*', async (c, next) => {
  const session = await readAdmin(c);
  if (!session) return c.json({ error: 'unauthorized' }, 401);
  c.set('admin', session);
  await next();
});

const MAX_BLOB_BYTES = 12 * 1024 * 1024; // a 2400px WebP is ~300KB; 12MB is a generous ceiling
const ALLOWED_TYPES = new Set(['image/webp', 'image/jpeg']);

/**
 * Store one derivative. The server mints the key, so a client can never choose a
 * path — that rules out traversal and collisions by construction.
 */
upload.put('/blob', async (c) => {
  const contentType = c.req.header('content-type') ?? '';
  if (!ALLOWED_TYPES.has(contentType)) {
    return c.json({ error: `unsupported content-type: ${contentType}` }, 415);
  }
  const body = await c.req.arrayBuffer();
  if (body.byteLength === 0) return c.json({ error: 'empty body' }, 400);
  if (body.byteLength > MAX_BLOB_BYTES) return c.json({ error: 'blob too large' }, 413);

  const key = storageKey();
  await c.env.BUCKET.put(key, body, { httpMetadata: { contentType } });
  return c.json({ key, bytes: body.byteLength }, 201);
});

interface ImageInput {
  albumId: string;
  filename: string;
  thumbKey: string;
  previewKey: string;
  width: number;
  height: number;
  captureTime?: number | null;
  checksum?: string | null;
}

/**
 * Commit a batch of already-uploaded derivatives. Idempotent per (album, filename),
 * so an interrupted upload can replay the entire batch without creating duplicates.
 */
upload.post('/projects/:pid/images', async (c) => {
  const projectId = c.req.param('pid');
  const body = await c.req.json<{ images?: ImageInput[] }>().catch(() => ({}) as { images?: ImageInput[] });
  const images = body.images;
  if (!Array.isArray(images) || images.length === 0) {
    return c.json({ error: 'images[] required' }, 400);
  }
  if (images.length > 500) return c.json({ error: 'batch too large (max 500)' }, 400);

  const project = await c.env.DB.prepare(`SELECT id FROM projects WHERE id = ?`).bind(projectId).first();
  if (!project) return c.json({ error: 'project not found' }, 404);

  // Every album must belong to this project — prevents writing across project boundaries.
  const albumIds = [...new Set(images.map((i) => i.albumId))];
  const placeholders = albumIds.map(() => '?').join(',');
  const { results: validAlbums } = await c.env.DB.prepare(
    `SELECT id FROM albums WHERE project_id = ? AND id IN (${placeholders})`,
  )
    .bind(projectId, ...albumIds)
    .all<{ id: string }>();
  const valid = new Set(validAlbums.map((a) => a.id));
  const invalid = albumIds.filter((id) => !valid.has(id));
  if (invalid.length) return c.json({ error: `album not in project: ${invalid.join(', ')}` }, 400);

  const now = Date.now();
  const stmt = c.env.DB.prepare(
    `INSERT OR IGNORE INTO images
       (id, project_id, album_id, original_filename, base_name, seq,
        thumb_key, preview_key, width, height, capture_time, checksum, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const batch = images.map((img) =>
    stmt.bind(
      ulid(),
      projectId,
      img.albumId,
      img.filename,
      baseName(img.filename),
      img.thumbKey,
      img.previewKey,
      img.width,
      img.height,
      img.captureTime ?? null,
      typeof img.checksum === 'string' && /^[0-9a-f]{64}$/.test(img.checksum) ? img.checksum : null,
      now,
    ),
  );
  const written = await c.env.DB.batch(batch);
  const inserted = written.reduce((n, r) => n + (r.meta.changes ?? 0), 0);

  // Re-derive display order for each touched album: capture time first, filename as
  // the tiebreak. Filename order is reliable for shoot exports, which are sequential.
  for (const albumId of albumIds) {
    await c.env.DB.prepare(
      `UPDATE images SET seq = (
         SELECT rn FROM (
           SELECT id, ROW_NUMBER() OVER (
             ORDER BY COALESCE(capture_time, 0), original_filename
           ) - 1 AS rn
           FROM images WHERE album_id = ?1
         ) t WHERE t.id = images.id
       ) WHERE album_id = ?1`,
    )
      .bind(albumId)
      .run();
  }

  return c.json({ received: images.length, inserted, skipped: images.length - inserted }, 201);
});

/**
 * Image manifest for an album — the single fetch the gallery makes on open.
 *
 * Rows are positional rather than objects: repeating seven key names per row costs
 * more than the data at 5,000 images. `base_name` is omitted because only export
 * needs it. This keeps a 5,000-image album near 150KB gzipped instead of ~400KB.
 */
upload.get('/albums/:aid/manifest', async (c) => {
  const albumId = c.req.param('aid');
  const album = await c.env.DB.prepare(
    `SELECT a.id, a.name, a.project_id FROM albums a WHERE a.id = ?`,
  )
    .bind(albumId)
    .first<{ id: string; name: string; project_id: string }>();
  if (!album) return c.json({ error: 'album not found' }, 404);

  const { results } = await c.env.DB.prepare(
    `SELECT id, original_filename, thumb_key, preview_key, width, height
       FROM images WHERE album_id = ? ORDER BY seq`,
  )
    .bind(albumId)
    .all<{
      id: string;
      original_filename: string;
      thumb_key: string;
      preview_key: string;
      width: number;
      height: number;
    }>();

  return c.json({
    album: { id: album.id, name: album.name },
    fields: ['id', 'filename', 'thumb', 'preview', 'w', 'h'],
    rows: results.map((r) => [
      r.id,
      r.original_filename,
      r.thumb_key,
      r.preview_key,
      r.width,
      r.height,
    ]),
  });
});

export default upload;
