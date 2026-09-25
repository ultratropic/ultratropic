import { Hono } from 'hono';
import adminRoutes from './routes/admin';
import uploadRoutes from './routes/upload';
import selectionRoutes from './routes/selections';
import { reviewerRoutes, byProjectSlug, byAlbumToken } from './routes/reviewer';
import exportRoutes from './routes/export';
import { readAdmin, readReviewerFor, canSeeAlbum, hasAnyReviewerCookie } from './lib/auth';
import type { Env, Vars } from './types';

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

app.get('/api/health', async (c) => {
  // Touch both bindings so a misconfigured deploy fails loudly here, not mid-upload.
  const db = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM projects').first<{ n: number }>();
  let bucket: string;
  try {
    await c.env.BUCKET.head('__healthcheck__');
    bucket = 'ok';
  } catch (err) {
    bucket = `error: ${(err as Error).message}`;
  }
  return c.json({ ok: true, projects: db?.n ?? 0, bucket });
});

/**
 * Derivative serving. The bucket stays private; this is the only way out.
 * Keys are 32 random chars, so a leaked URL is still not a guessable one.
 * Immutable caching means a reviewer pays the request cost once, not per scroll.
 */
app.get('/i/:key', async (c) => {
  const key = c.req.param('key');
  if (!/^[A-Za-z0-9]{32}$/.test(key)) return c.text('not found', 404);

  // The owner sees everything. Anyone else must hold a session for the project
  // this frame belongs to, covering its album — so neither a reviewer of another
  // shoot nor a client of another album can fetch it, even holding the key.
  const admin = await readAdmin(c);
  if (!admin) {
    if (!hasAnyReviewerCookie(c)) return c.text('unauthorized', 401);
    const owner = await c.env.DB.prepare(
      `SELECT project_id, album_id FROM images WHERE thumb_key = ?1 OR preview_key = ?1 LIMIT 1`,
    )
      .bind(key)
      .first<{ project_id: string; album_id: string }>();
    if (!owner) return c.text('not found', 404);
    const session = await readReviewerFor(c, owner.project_id);
    if (!session || !canSeeAlbum(session, owner.album_id)) return c.text('not found', 404);
  }

  // Two cache policies for one image. The browser gets `private`: a shared
  // proxy must never keep a copy. Cloudflare's edge cache, though, won't store a
  // `private` response at all — so it gets its own `public` copy. That's safe
  // because the edge cache is only reachable through this Worker, and the access
  // check above has already run by the time it's consulted.
  const cache = (caches as unknown as { default: Cache }).default;
  const cacheKey = new Request(new URL(c.req.url).toString(), { method: 'GET' });
  const browserHeaders = (from: Headers) => {
    const h = new Headers(from);
    h.set('cache-control', 'private, max-age=31536000, immutable');
    return h;
  };

  const hit = await cache.match(cacheKey);
  if (hit) {
    const h = browserHeaders(hit.headers);
    h.set('x-review-cache', 'hit');
    return new Response(hit.body, { headers: h });
  }

  const object = await c.env.BUCKET.get(key);
  if (!object) return c.text('not found', 404);
  const bytes = await object.arrayBuffer();

  const base = new Headers({
    'content-type': object.httpMetadata?.contentType ?? 'application/octet-stream',
    etag: object.httpEtag,
  });
  const edge = new Headers(base);
  edge.set('cache-control', 'public, max-age=31536000, immutable');
  c.executionCtx.waitUntil(cache.put(cacheKey, new Response(bytes, { headers: edge })));

  const h = browserHeaders(base);
  h.set('x-review-cache', 'miss');
  return new Response(bytes, { headers: h });
});

app.route('/api/admin', adminRoutes);
app.route('/api/admin', uploadRoutes);
app.route('/api/admin', selectionRoutes);
app.route('/api/admin', exportRoutes);
app.route('/api/p', reviewerRoutes(byProjectSlug));
app.route('/api/a', reviewerRoutes(byAlbumToken));

app.all('/api/*', (c) => c.json({ error: 'not found' }, 404));

// Everything else is the SPA, served from Workers Assets.
app.get('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
