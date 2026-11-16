import { Hono } from 'hono';
import { findViewLink, viewPayload } from '../lib/views';
import type { Env, Vars } from '../types';

/** /api/v/<token>: the view-only page's one request. Public; the token is the key. */
const view = new Hono<{ Bindings: Env; Variables: Vars }>();

view.get('/:token', async (c) => {
  const token = c.req.param('token');
  const link = await findViewLink(c.env, token);
  if (!link) return c.json({ error: 'not found' }, 404);
  const res = c.json(await viewPayload(c.env, link, token));
  // Live: always ask again, so a changed pick shows on the next open.
  res.headers.set('cache-control', 'no-store');
  return res;
});

export default view;
