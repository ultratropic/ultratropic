import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Context } from 'hono';
import { sign, unsign } from './crypto';
import type { AdminSession, Env, ReviewerSession, Vars } from '../types';

export const ADMIN_COOKIE = 'rv_admin';
const LEGACY_REVIEWER_COOKIE = 'rv_reviewer';

const ADMIN_TTL = 1000 * 60 * 60 * 24 * 14; // 14 days
const REVIEWER_TTL = 1000 * 60 * 60 * 24 * 90; // 90 days — reviewers come back to a shoot for weeks

type Ctx = Context<{ Bindings: Env; Variables: Vars }>;

function cookieOpts(ttlMs: number) {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax' as const,
    path: '/',
    maxAge: Math.floor(ttlMs / 1000),
  };
}

export async function issueAdminCookie(c: Ctx): Promise<void> {
  const session: AdminSession = { admin: true, exp: Date.now() + ADMIN_TTL };
  setCookie(c, ADMIN_COOKIE, await sign(session, c.env.COOKIE_SECRET), cookieOpts(ADMIN_TTL));
}

export async function readAdmin(c: Ctx): Promise<AdminSession | null> {
  return unsign<AdminSession>(getCookie(c, ADMIN_COOKIE), c.env.COOKIE_SECRET);
}

export function clearAdminCookie(c: Ctx): void {
  deleteCookie(c, ADMIN_COOKIE, { path: '/' });
}

export const reviewerCookieName = (projectId: string) => `rv_r_${projectId}`;

export async function issueReviewerCookie(
  c: Ctx,
  session: Omit<ReviewerSession, 'exp'>,
): Promise<void> {
  const full: ReviewerSession = { ...session, exp: Date.now() + REVIEWER_TTL };
  setCookie(
    c,
    reviewerCookieName(session.pid),
    await sign(full, c.env.COOKIE_SECRET),
    cookieOpts(REVIEWER_TTL),
  );
}

export async function readReviewerFor(c: Ctx, projectId: string): Promise<ReviewerSession | null> {
  const s = await unsign<ReviewerSession>(
    getCookie(c, reviewerCookieName(projectId)),
    c.env.COOKIE_SECRET,
  );
  if (s && s.pid === projectId) return { ...s, albums: s.albums ?? [], all: s.all === true };

  // Sessions from before per-project cookies covered exactly one project, fully.
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
  deleteCookie(c, reviewerCookieName(projectId), { path: '/' });
  deleteCookie(c, LEGACY_REVIEWER_COOKIE, { path: '/' });
}

/** Cheap pre-check before any database work: does this request carry a reviewer session at all? */
export function hasAnyReviewerCookie(c: Ctx): boolean {
  const header = c.req.header('cookie') ?? '';
  return header.includes('rv_r_') || header.includes(`${LEGACY_REVIEWER_COOKIE}=`);
}

export function canSeeAlbum(s: ReviewerSession, albumId: string): boolean {
  return s.all || s.albums.includes(albumId);
}
