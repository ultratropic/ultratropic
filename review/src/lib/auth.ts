import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Context } from 'hono';
import { sign, unsign } from './crypto';
import { INTERNAL_OWNER, INTERNAL_WORKSPACE } from '../types';
import type { Env, OwnerSession, ReviewerSession, Vars } from '../types';

const ADMIN_COOKIE = 'rv_admin';
const LEGACY_REVIEWER_COOKIE = 'rv_reviewer';

const ADMIN_TTL = 1000 * 60 * 60 * 24 * 14; // 14 days
const REVIEWER_TTL = 1000 * 60 * 60 * 24 * 90; // 90 days — reviewers come back to a shoot for weeks

type Ctx = Context<{ Bindings: Env; Variables: Vars }>;

/**
 * The public product's cookies carry the __Host- prefix: the browser then
 * refuses any copy set by another subdomain of the same site, so a page
 * elsewhere on the domain can't plant its own session in a visitor's browser.
 * The internal deployment keeps its old names so nobody is signed out.
 */
export const cookieName = (c: Ctx, base: string) => (c.env.MODE === 'public' ? `__Host-${base}` : base);

export function dropCookie(c: Ctx, base: string): void {
  deleteCookie(c, cookieName(c, base), { path: '/', secure: true });
}

function cookieOpts(ttlMs: number) {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax' as const,
    path: '/',
    maxAge: Math.floor(ttlMs / 1000),
  };
}

export async function issueOwnerCookie(c: Ctx, uid: string, wid: string): Promise<void> {
  // `t` marks the kind: every cookie is signed with the same secret, so a value
  // lifted from some other cookie must never read as an owner session.
  const session = { t: 'owner', uid, wid, exp: Date.now() + ADMIN_TTL };
  setCookie(c, cookieName(c, ADMIN_COOKIE), await sign(session, c.env.COOKIE_SECRET), cookieOpts(ADMIN_TTL));
}

/**
 * The signed-in owner, if any. Signature and expiry only; the gate also checks
 * they're still a member of the workspace. A cookie from before accounts
 * ({ admin: true }) is the internal owner — only on the internal deployment.
 */
export async function readOwner(c: Ctx): Promise<OwnerSession | null> {
  const s = await unsign<OwnerSession & { t?: string; admin?: true }>(getCookie(c, cookieName(c, ADMIN_COOKIE)), c.env.COOKIE_SECRET);
  if (!s || typeof s.exp !== 'number') return null;
  if (s.t === 'owner' && typeof s.uid === 'string' && typeof s.wid === 'string') return { uid: s.uid, wid: s.wid, exp: s.exp };
  if (s.admin === true && c.env.MODE !== 'public') return { uid: INTERNAL_OWNER, wid: INTERNAL_WORKSPACE, exp: s.exp };
  return null;
}

export function clearAdminCookie(c: Ctx): void {
  dropCookie(c, ADMIN_COOKIE);
}

export const reviewerCookieName = (projectId: string) => `rv_r_${projectId}`;

export async function issueReviewerCookie(
  c: Ctx,
  session: Omit<ReviewerSession, 'exp'>,
): Promise<void> {
  const full: ReviewerSession = { ...session, exp: Date.now() + REVIEWER_TTL };
  setCookie(
    c,
    cookieName(c, reviewerCookieName(session.pid)),
    await sign(full, c.env.COOKIE_SECRET),
    cookieOpts(REVIEWER_TTL),
  );
}

export async function readReviewerFor(c: Ctx, projectId: string): Promise<ReviewerSession | null> {
  const s = await unsign<ReviewerSession>(
    getCookie(c, cookieName(c, reviewerCookieName(projectId))),
    c.env.COOKIE_SECRET,
  );
  if (s && s.pid === projectId) return { ...s, albums: s.albums ?? [], all: s.all === true };

  // Sessions from before per-project cookies covered exactly one project, fully.
  // Only the internal deployment ever issued them.
  if (c.env.MODE === 'public') return null;
  const legacy = await unsign<{ rid: string; pid: string; exp: number }>(
    getCookie(c, LEGACY_REVIEWER_COOKIE),
    c.env.COOKIE_SECRET,
  );
  if (legacy && legacy.pid === projectId) {
    return { rid: legacy.rid, pid: projectId, all: true, albums: [], exp: legacy.exp };
  }
  return null;
}

export function clearReviewerCookie(c: Ctx, projectId: string): void {
  dropCookie(c, reviewerCookieName(projectId));
  if (c.env.MODE !== 'public') dropCookie(c, LEGACY_REVIEWER_COOKIE);
}

/** Cheap pre-check before any database work: does this request carry a reviewer session at all? */
export function hasAnyReviewerCookie(c: Ctx): boolean {
  const header = c.req.header('cookie') ?? '';
  return header.includes('rv_r_') || header.includes(`${LEGACY_REVIEWER_COOKIE}=`);
}

/**
 * Password endpoints take at most N attempts a minute per visitor. Counted
 * before the password is checked, so the answer never depends on whether the
 * guess was right.
 */
export async function overLimit(limiter: RateLimit | undefined, key: string): Promise<boolean> {
  if (!limiter) return false;
  const { success } = await limiter.limit({ key });
  return !success;
}

export const visitor = (c: Ctx) => c.req.header('cf-connecting-ip') ?? 'local';

export function canSeeAlbum(s: ReviewerSession, albumId: string): boolean {
  return s.all || s.albums.includes(albumId);
}
