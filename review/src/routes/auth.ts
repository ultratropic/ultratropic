import { Hono } from 'hono';
import { ulid, token } from '../lib/ids';
import { issueOwnerCookie, overLimit, visitor } from '../lib/auth';
import { sendMail, esc } from '../lib/mail';
import type { Env, Vars } from '../types';

/**
 * Sign-in by email link, for the public product. The token travels after the
 * '#' of the link, which browsers never send to a server, and the page only
 * redeems it when the person presses Sign in — so mail scanners that open
 * links can neither see it nor use it up.
 */
const auth = new Hono<{ Bindings: Env; Variables: Vars }>();

const LINK_TTL = 20 * 60 * 1000;
const LINKS_PER_ADDRESS = 3; // per 15 minutes
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function invited(env: Env, email: string): boolean {
  const list = env.SIGNUP_ALLOWLIST?.trim();
  if (!list) return true;
  return list.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    .some((entry) => (entry.startsWith('@') ? email.endsWith(entry) : email === entry));
}

/** What the client needs before anyone signs in: which product this is. */
auth.get('/config', (c) =>
  c.json({ mode: c.env.MODE ?? 'internal', product: c.env.PRODUCT_NAME ?? 'Review' }));

auth.post('/auth/start', async (c) => {
  if (c.env.MODE !== 'public') return c.json({ error: 'not found' }, 404);
  if (await overLimit(c.env.LOGIN_LIMIT, `link:${visitor(c)}`)) {
    return c.json({ error: 'Too many attempts. Wait a minute and try again.' }, 429);
  }
  const { email: raw } = await c.req.json<{ email?: string }>().catch(() => ({ email: undefined }));
  const email = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  // Length first: the pattern backtracks, so a huge input must never reach it.
  if (email.length > 254 || !EMAIL.test(email)) return c.json({ error: 'Enter a valid email address.' }, 400);

  const known = await c.env.DB.prepare(`SELECT 1 FROM users WHERE email_norm = ?`).bind(email).first();
  if (!known && !invited(c.env, email)) {
    return c.json({ error: "Sign-up is invite-only for now. Ask us for an invite." }, 403);
  }

  const now = Date.now();
  const recent = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM login_links WHERE email_norm = ? AND created_at > ?`,
  )
    .bind(email, now - 15 * 60 * 1000)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= LINKS_PER_ADDRESS) {
    return c.json({ error: 'We just sent you a link. Check your inbox, or try again in a few minutes.' }, 429);
  }

  const secret = token(32);
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM login_links WHERE created_at < ?`).bind(now - 24 * 60 * 60 * 1000),
    c.env.DB.prepare(`INSERT INTO login_links (token_hash, email_norm, created_at, expires_at) VALUES (?, ?, ?, ?)`)
      .bind(await sha256(secret), email, now, now + LINK_TTL),
  ]);

  const product = c.env.PRODUCT_NAME ?? 'Review';
  const link = `${new URL(c.req.url).origin}/signin#${secret}`;
  const sent = await sendMail(c.env, {
    to: email,
    subject: `Sign in to ${product}`,
    text: `Sign in to ${product}:\n\n${link}\n\nThe link works once and expires in 20 minutes. If you didn't ask for it, ignore this email.`,
    html: `<p>Sign in to ${esc(product)}:</p><p><a href="${esc(link)}">Sign in</a></p>` +
      `<p style="color:#777">The link works once and expires in 20 minutes. If you didn't ask for it, ignore this email.</p>`,
  });
  if (!sent) return c.json({ error: "We couldn't send the email. Try again in a minute." }, 503);
  return c.json({ ok: true });
});

auth.post('/auth/verify', async (c) => {
  if (c.env.MODE !== 'public') return c.json({ error: 'not found' }, 404);
  if (await overLimit(c.env.LOGIN_LIMIT, `verify:${visitor(c)}`)) {
    return c.json({ error: 'Too many attempts. Wait a minute and try again.' }, 429);
  }
  const { token: secret } = await c.req.json<{ token?: string }>().catch(() => ({ token: undefined }));
  if (typeof secret !== 'string' || !/^[A-Za-z0-9]{32}$/.test(secret)) {
    return c.json({ error: 'This sign-in link is not valid.' }, 400);
  }
  const now = Date.now();
  // Used up in the same statement that checks it, so a link can't be redeemed twice.
  const link = await c.env.DB.prepare(
    `UPDATE login_links SET used_at = ?1 WHERE token_hash = ?2 AND used_at IS NULL AND expires_at > ?1 RETURNING email_norm`,
  )
    .bind(now, await sha256(secret))
    .first<{ email_norm: string }>();
  if (!link) return c.json({ error: 'This sign-in link has expired or was already used. Ask for a new one.' }, 400);

  let user = await c.env.DB.prepare(`SELECT id FROM users WHERE email_norm = ?`)
    .bind(link.email_norm)
    .first<{ id: string }>();
  let wid: string | undefined;
  if (!user) {
    // First sign-in: an account, and a workspace of their own to put projects in.
    const uid = ulid();
    wid = ulid();
    const local = link.email_norm.split('@')[0]!.slice(0, 60);
    await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO users (id, email_norm, name, created_at, last_login_at) VALUES (?, ?, ?, ?, ?)`)
        .bind(uid, link.email_norm, local, now, now),
      c.env.DB.prepare(`INSERT INTO workspaces (id, name, plan, created_at) VALUES (?, ?, 'free', ?)`)
        .bind(wid, local, now),
      c.env.DB.prepare(`INSERT INTO members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)`)
        .bind(wid, uid, now),
    ]);
    user = { id: uid };
  } else {
    await c.env.DB.prepare(`UPDATE users SET last_login_at = ? WHERE id = ?`).bind(now, user.id).run();
    const m = await c.env.DB.prepare(
      `SELECT workspace_id FROM members WHERE user_id = ? ORDER BY created_at LIMIT 1`,
    )
      .bind(user.id)
      .first<{ workspace_id: string }>();
    wid = m?.workspace_id;
  }
  if (!wid) return c.json({ error: 'This account has no workspace.' }, 400);
  await issueOwnerCookie(c, user.id, wid);
  return c.json({ ok: true });
});

export default auth;
