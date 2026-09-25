import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { ulid, normalizeEmail } from '../lib/ids';
import { verifyPassword, sign, unsign } from '../lib/crypto';
import {
  issueReviewerCookie,
  readReviewerFor,
  clearReviewerCookie,
  canSeeAlbum,
  overLimit,
  visitor,
} from '../lib/auth';
import { buildGallery } from '../lib/gallery';
import type { Env, ReviewerSession, Vars } from '../types';

type Ctx = Context<{ Bindings: Env; Variables: Vars }>;

interface Target {
  project: {
    id: string;
    name: string;
    status: string;
    password_hash: string | null;
    password_salt: string | null;
  };
  /** Set when the link is a client album link rather than the project link. */
  album: {
    id: string;
    name: string;
    password_hash: string | null;
    password_salt: string | null;
  } | null;
}

type Resolve = (env: Env, key: string) => Promise<Target | null>;

/** /p/<slug>: the internal link — every album, guarded by the project password. */
export const byProjectSlug: Resolve = async (env, slug) => {
  const p = await env.DB.prepare(
    `SELECT id, name, status, password_hash, password_salt FROM projects WHERE slug = ?`,
  )
    .bind(slug)
    .first<Target['project']>();
  return p ? { project: p, album: null } : null;
};

/** /a/<token>: a client link — one album, guarded by its own password if it has one. */
export const byAlbumToken: Resolve = async (env, token) => {
  const row = await env.DB.prepare(
    `SELECT a.id AS a_id, a.name AS a_name, a.password_hash AS a_hash, a.password_salt AS a_salt,
            p.id, p.name, p.status, p.password_hash, p.password_salt
       FROM albums a JOIN projects p ON p.id = a.project_id
      WHERE a.share_token = ?`,
  )
    .bind(token)
    .first<Target['project'] & { a_id: string; a_name: string; a_hash: string | null; a_salt: string | null }>();
  if (!row) return null;
  return {
    project: {
      id: row.id,
      name: row.name,
      status: row.status,
      password_hash: row.password_hash,
      password_salt: row.password_salt,
    },
    album: { id: row.a_id, name: row.a_name, password_hash: row.a_hash, password_salt: row.a_salt },
  };
};

const UNLOCK_COOKIE = 'rv_unlock';
const UNLOCK_TTL = 1000 * 60 * 30; // long enough to type a name, not a standing key

const scopeOf = (t: Target) => (t.album ? `album:${t.album.id}` : `project:${t.project.id}`);

/**
 * Which password guards this link. An album's own password wins; an album without
 * one falls back to the project's, so sharing an album can never be LESS protected
 * than the project it came from.
 */
function passwordFor(t: Target): { hash: string; salt: string } | null {
  if (t.album?.password_hash && t.album.password_salt) {
    return { hash: t.album.password_hash, salt: t.album.password_salt };
  }
  if (t.project.password_hash && t.project.password_salt) {
    return { hash: t.project.password_hash, salt: t.project.password_salt };
  }
  return null;
}

/** A session whose reviewer has been removed is no session: clear it. */
async function liveSession(c: Ctx, t: Target): Promise<ReviewerSession | null> {
  const s = await readReviewerFor(c, t.project.id);
  if (!s) return null;
  const exists = await c.env.DB.prepare(`SELECT 1 FROM reviewers WHERE id = ? AND project_id = ?`)
    .bind(s.rid, t.project.id)
    .first();
  if (exists) return s;
  clearReviewerCookie(c, t.project.id);
  return null;
}

const covers = (s: ReviewerSession, t: Target) => (t.album ? canSeeAlbum(s, t.album.id) : s.all);

function extend(s: Omit<ReviewerSession, 'exp'>, t: Target): Omit<ReviewerSession, 'exp'> {
  if (!t.album) return { ...s, all: true };
  return { ...s, albums: [...new Set([...s.albums, t.album.id])] };
}

/**
 * How many picks this reviewer is allowed to know a frame has: hidden people's
 * picks are left out, except their own. Returned after every toggle, so it must
 * agree with the gallery or the number would give a hidden reviewer away.
 */
async function visibleCount(c: Ctx, imageId: string, viewerId: string): Promise<{ n: number } | null> {
  return c.env.DB.prepare(
    `SELECT COUNT(*) n FROM selections s JOIN reviewers r ON r.id = s.reviewer_id
      WHERE s.image_id = ? AND (r.hidden = 0 OR r.id = ?)`,
  )
    .bind(imageId, viewerId)
    .first<{ n: number }>();
}

export function reviewerRoutes(resolve: Resolve) {
  const r = new Hono<{ Bindings: Env; Variables: Vars }>();

  async function load(c: Ctx): Promise<Target | null> {
    const key = c.req.param('key');
    if (!key || !/^[A-Za-z0-9]{6,64}$/.test(key)) return null;
    const t = await resolve(c.env, key);
    return t && t.project.status === 'active' ? t : null;
  }

  async function requireAccess(c: Ctx): Promise<{ t: Target; s: ReviewerSession } | Response> {
    const t = await load(c);
    if (!t) return c.json({ error: 'not found' }, 404);
    const s = await liveSession(c, t);
    if (!s || !covers(s, t)) return c.json({ error: 'not joined' }, 401);
    return { t, s };
  }

  /** Public. Reveals only names and whether a password is needed. */
  r.get('/:key', async (c) => {
    const t = await load(c);
    if (!t) return c.json({ error: 'not found' }, 404);
    const s = await liveSession(c, t);
    let reviewerName: string | null = null;
    if (s) {
      const row = await c.env.DB.prepare(`SELECT display_name FROM reviewers WHERE id = ?`)
        .bind(s.rid)
        .first<{ display_name: string }>();
      reviewerName = row?.display_name ?? null;
    }
    return c.json({
      name: t.project.name,
      album: t.album?.name ?? null,
      hasPassword: !!passwordFor(t),
      joined: !!s && covers(s, t),
      known: !!s,
      reviewerName,
    });
  });

  r.post('/:key/unlock', async (c) => {
    const t = await load(c);
    if (!t) return c.json({ error: 'not found' }, 404);
    const pw = passwordFor(t);
    if (pw) {
      if (await overLimit(c.env.UNLOCK_LIMIT, `unlock:${visitor(c)}:${scopeOf(t)}`)) {
        return c.json({ error: 'too many attempts' }, 429);
      }
      const { password } = await c.req
        .json<{ password?: string }>()
        .catch(() => ({ password: undefined }));
      if (!password || !(await verifyPassword(password, pw.hash, pw.salt))) {
        return c.json({ error: 'incorrect password' }, 401);
      }
    }

    // Someone already identified in this project (another album link, say) just
    // gains this album — no second round of name and email.
    const s = await liveSession(c, t);
    if (s) {
      await issueReviewerCookie(c, extend(s, t));
      return c.json({ ok: true, joined: true });
    }

    if (pw) {
      const token = await sign({ scope: scopeOf(t), exp: Date.now() + UNLOCK_TTL }, c.env.COOKIE_SECRET);
      setCookie(c, UNLOCK_COOKIE, token, {
        httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: UNLOCK_TTL / 1000,
      });
    }
    return c.json({ ok: true, joined: false });
  });

  /**
   * No account, no password, no verification email: the normalised address is the
   * identity within this project. Returning with the same address restores that
   * person's selections. The display name is kept from first entry so a later typo
   * cannot rename someone mid-shoot.
   */
  r.post('/:key/join', async (c) => {
    const t = await load(c);
    if (!t) return c.json({ error: 'not found' }, 404);

    if (passwordFor(t)) {
      const unlock = await unsign<{ scope: string }>(getCookie(c, UNLOCK_COOKIE), c.env.COOKIE_SECRET);
      if (unlock?.scope !== scopeOf(t)) return c.json({ error: 'locked' }, 403);
    }

    const body = await c.req
      .json<{ name?: string; email?: string }>()
      .catch(() => ({}) as { name?: string; email?: string });
    const name = body.name?.trim();
    const email = normalizeEmail(body.email ?? '');
    if (!name) return c.json({ error: 'name required' }, 400);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return c.json({ error: 'valid email required' }, 400);

    const now = Date.now();
    const existing = await c.env.DB.prepare(
      `SELECT id, display_name FROM reviewers WHERE project_id = ? AND email_norm = ?`,
    )
      .bind(t.project.id, email)
      .first<{ id: string; display_name: string }>();

    let reviewerId: string;
    if (existing) {
      reviewerId = existing.id;
      await c.env.DB.prepare(`UPDATE reviewers SET last_seen_at = ? WHERE id = ?`)
        .bind(now, reviewerId)
        .run();
    } else {
      reviewerId = ulid();
      await c.env.DB.prepare(
        `INSERT INTO reviewers (id, project_id, email_norm, display_name, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
        .bind(reviewerId, t.project.id, email, name, now, now)
        .run();
    }

    // Keep any access this device already had in the project — unless it belonged
    // to someone else, in which case start clean.
    const prior = await liveSession(c, t);
    const base =
      prior && prior.rid === reviewerId
        ? prior
        : { rid: reviewerId, pid: t.project.id, all: false, albums: [] as string[] };
    await issueReviewerCookie(c, extend(base, t));
    deleteCookie(c, UNLOCK_COOKIE, { path: '/' });

    return c.json({ name: existing?.display_name ?? name, returning: !!existing });
  });

  /** "Not you?" on a shared device. */
  r.post('/:key/leave', async (c) => {
    const t = await load(c);
    if (t) clearReviewerCookie(c, t.project.id);
    return c.json({ ok: true });
  });

  r.get('/:key/gallery', async (c) => {
    const gate = await requireAccess(c);
    if (gate instanceof Response) return gate;
    const { t, s } = gate;

    await c.env.DB.prepare(`UPDATE reviewers SET last_seen_at = ? WHERE id = ?`)
      .bind(Date.now(), s.rid)
      .run();

    const payload = await buildGallery(c.env, {
      projectId: t.project.id,
      reviewerId: s.rid,
      albumIds: t.album ? [t.album.id] : null,
      admin: false,
      // A client on an album link must never learn the project link.
      includeSlug: !t.album,
    });
    if (!payload) return c.json({ error: 'not found' }, 404);
    return c.json(payload);
  });

  async function imageInScope(c: Ctx, t: Target, imageId: string): Promise<boolean> {
    const img = await c.env.DB.prepare(
      `SELECT album_id FROM images WHERE id = ? AND project_id = ?`,
    )
      .bind(imageId, t.project.id)
      .first<{ album_id: string }>();
    if (!img) return false;
    return t.album ? img.album_id === t.album.id : true;
  }

  r.put('/:key/selections/:imageId', async (c) => {
    const gate = await requireAccess(c);
    if (gate instanceof Response) return gate;
    const imageId = c.req.param('imageId');
    if (!(await imageInScope(c, gate.t, imageId))) return c.json({ error: 'not found' }, 404);

    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO selections (project_id, image_id, reviewer_id, created_at)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(gate.t.project.id, imageId, gate.s.rid, Date.now())
      .run();

    const count = await visibleCount(c, imageId, gate.s.rid);
    return c.json({ selected: true, count: count?.n ?? 1 });
  });

  r.delete('/:key/selections/:imageId', async (c) => {
    const gate = await requireAccess(c);
    if (gate instanceof Response) return gate;
    const imageId = c.req.param('imageId');
    if (!(await imageInScope(c, gate.t, imageId))) return c.json({ error: 'not found' }, 404);

    await c.env.DB.prepare(`DELETE FROM selections WHERE image_id = ? AND reviewer_id = ?`)
      .bind(imageId, gate.s.rid)
      .run();

    const count = await visibleCount(c, imageId, gate.s.rid);
    return c.json({ selected: false, count: count?.n ?? 0 });
  });

  return r;
}
