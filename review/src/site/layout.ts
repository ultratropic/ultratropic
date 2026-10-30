import type { Env } from '../types';

/**
 * The public product's own pages (landing, pricing, policies): plain HTML from
 * the Worker, no script, so they load instantly and read the same to people,
 * search engines and Paddle's site review. Same type and colours as the app.
 */

/** Who stands behind the product, named in the footer and the policies. */
export const LEGAL = {
  company: 'Subtropic Creative, LLC',
  state: 'Florida',
  contact: 'support@ultra-tropic.com',
  updated: 'October 30, 2026',
};

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

const CSS = `
:root { --bg: #fff; --fg: #111; --muted: #777; --line: #e6e6e6; --card: #fafafa; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { --bg: #0d0d0d; --fg: #f0f0f0; --muted: #8a8a8a; --line: #262626; --card: #141414; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 400 16px/1.6 -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif; -webkit-font-smoothing: antialiased; }
a { color: inherit; }
.page { max-width: 1040px; margin: 0 auto; padding: 0 24px; }
header.top { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 28px 0; }
.mark { font-weight: 600; font-size: 20px; letter-spacing: -0.02em; text-decoration: none; }
nav.top { display: flex; gap: 24px; align-items: center; font-size: 14px; }
nav.top a { text-decoration: none; color: var(--muted); }
nav.top a:hover, nav.top a.on { color: var(--fg); }
.btn { display: inline-block; padding: 12px 22px; border-radius: 3px; background: var(--fg); color: var(--bg); text-decoration: none; font-size: 15px; border: 1px solid var(--fg); }
.btn.ghost { background: transparent; color: var(--fg); border-color: var(--line); }
nav.top .btn { padding: 8px 16px; font-size: 14px; color: var(--bg); }
.hero { padding: 96px 0 72px; max-width: 760px; }
.hero h1 { font-size: clamp(38px, 6vw, 64px); line-height: 1.05; letter-spacing: -0.035em; font-weight: 600; margin: 0 0 24px; }
.hero p { font-size: clamp(17px, 2vw, 20px); color: var(--muted); margin: 0 0 36px; max-width: 600px; }
.hero .actions { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
.small, .hero p.small { font-size: 13px; color: var(--muted); }
.features { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0 40px; padding: 24px 0 80px; }
.feature { border-top: 1px solid var(--line); padding: 22px 0 28px; }
.feature h3 { font-size: 16px; font-weight: 600; margin: 0 0 6px; letter-spacing: -0.01em; }
.feature p { margin: 0; color: var(--muted); font-size: 15px; }
.band { border-top: 1px solid var(--line); padding: 64px 0; }
.band h2 { font-size: clamp(26px, 3.4vw, 36px); letter-spacing: -0.025em; font-weight: 600; margin: 0 0 12px; line-height: 1.15; }
.band > p { color: var(--muted); max-width: 620px; margin: 0 0 28px; }
.plans { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin: 8px 0 24px; }
.plan { border: 1px solid var(--line); border-radius: 4px; padding: 26px 24px 28px; background: var(--card); display: flex; flex-direction: column; }
.plan h3 { margin: 0 0 4px; font-size: 15px; font-weight: 600; }
.plan .price { font-size: 34px; font-weight: 600; letter-spacing: -0.03em; margin: 10px 0 2px; }
.plan .per { color: var(--muted); font-size: 13px; margin-bottom: 18px; }
.plan ul { list-style: none; padding: 0; margin: 0 0 22px; font-size: 14px; flex: 1; }
.plan li { padding: 7px 0; border-top: 1px solid var(--line); }
.faq { max-width: 720px; }
.faq h3 { font-size: 16px; margin: 28px 0 6px; }
.faq p { margin: 0; color: var(--muted); }
.legal { max-width: 720px; padding: 40px 0 80px; }
.legal h1 { font-size: 34px; letter-spacing: -0.025em; margin: 0 0 6px; }
.legal h2 { font-size: 18px; margin: 36px 0 8px; letter-spacing: -0.01em; }
.legal p, .legal li { color: var(--fg); }
.legal ul { padding-left: 20px; }
footer.bottom { border-top: 1px solid var(--line); padding: 28px 0 48px; display: flex; flex-wrap: wrap; gap: 12px 24px; justify-content: space-between; font-size: 13px; color: var(--muted); }
footer.bottom nav { display: flex; flex-wrap: wrap; gap: 20px; }
footer.bottom a { color: var(--muted); text-decoration: none; }
footer.bottom a:hover { color: var(--fg); }
@media (max-width: 760px) {
  .features, .plans { grid-template-columns: 1fr; }
  .hero { padding: 56px 0 48px; }
  nav.top { gap: 16px; }
  nav.top .hide-sm { display: none; }
}
`;

export function layout(env: Env, opts: { title: string; description: string; path: string; body: string }): Response {
  const product = env.PRODUCT_NAME ?? 'Review';
  const on = (p: string) => (opts.path === p ? ' class="on"' : '');
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(opts.title)}</title>
<meta name="description" content="${esc(opts.description)}">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>${CSS}</style>
</head>
<body>
<div class="page">
<header class="top">
  <a class="mark" href="/">${esc(product)}</a>
  <nav class="top">
    <a href="/pricing"${on('/pricing')}>Pricing</a>
    <a href="/login" class="hide-sm">Sign in</a>
    <a class="btn" href="/login">Start free</a>
  </nav>
</header>
${opts.body}
<footer class="bottom">
  <span>© 2026 ${esc(LEGAL.company)}</span>
  <nav>
    <a href="/pricing">Pricing</a>
    <a href="/terms">Terms</a>
    <a href="/privacy">Privacy</a>
    <a href="/refunds">Refunds</a>
    <a href="mailto:${LEGAL.contact}">${LEGAL.contact}</a>
  </nav>
</footer>
</div>
</body>
</html>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' } });
}
