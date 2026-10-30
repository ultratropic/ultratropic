import type { Context, Next } from 'hono';
import { readOwner } from './auth';
import type { Env, Vars } from '../types';

type Ctx = Context<{ Bindings: Env; Variables: Vars }>;

/** Owner routes that need no sign-in. */
const OPEN = new Set(['/login', '/logout']);

/** Owner routes that name no project, album, photo or reviewer; each scopes itself by workspace. */
const UNSCOPED = new Set(['/me', '/projects', '/blob']);

/**
 * Which workspace a thing named in a path belongs to. Every lookup ends at the
 * project's workspace_id, so there's one rule to get right, not one per route.
 */
const OWNER_OF: Record<string, string> = {
  projects: `SELECT workspace_id AS wid FROM projects WHERE id = ?`,
  albums: `SELECT p.workspace_id AS wid FROM albums a JOIN projects p ON p.id = a.project_id WHERE a.id = ?`,
  images: `SELECT p.workspace_id AS wid FROM images i JOIN projects p ON p.id = i.project_id WHERE i.id = ?`,
  reviewers: `SELECT p.workspace_id AS wid FROM reviewers r JOIN projects p ON p.id = r.project_id WHERE r.id = ?`,
};

/**
 * The one door in front of every /api/admin route: a signed-in member of a
 * workspace, acting only on that workspace's things. Anything it doesn't
 * recognise is refused, so a new route is closed until it's thought about.
 * Someone else's project answers exactly like a missing one (404), so ids
 * can't be probed.
 */
export async function ownerGate(c: Ctx, next: Next) {
  const path = c.req.path.slice('/api/admin'.length) || '/';
  if (OPEN.has(path)) return next();

  const session = await readOwner(c);
  if (!session) return c.json({ error: 'unauthorized' }, 401);
  // A signed cookie outlives a removed member; membership is checked every time.
  const member = await c.env.DB.prepare(`SELECT 1 FROM members WHERE workspace_id = ? AND user_id = ?`)
    .bind(session.wid, session.uid)
    .first();
  if (!member) return c.json({ error: 'unauthorized' }, 401);
  c.set('owner', { uid: session.uid, wid: session.wid });

  const m = /^\/(projects|albums|images|reviewers)\/([^/]+)(?:\/|$)/.exec(path);
  if (m) {
    const row = await c.env.DB.prepare(OWNER_OF[m[1]!]!).bind(decodeURIComponent(m[2]!)).first<{ wid: string | null }>();
    if (!row || row.wid !== session.wid) return c.json({ error: 'not found' }, 404);
  } else if (!UNSCOPED.has(path)) {
    return c.json({ error: 'not found' }, 404);
  }
  await next();
}

/** The signed-in owner, for handlers behind the gate. */
export function owner(c: Ctx): { uid: string; wid: string } {
  const o = c.get('owner');
  if (!o) throw new Error('owner route reached without the gate');
  return o;
}
