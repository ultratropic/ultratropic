import type { Env } from '../types';
import { layout, LEGAL, esc } from './layout';

const FEATURES: [string, string][] = [
  ['Everyone picks, nobody overwrites', 'The brand, the agency and your team each heart their own picks. Filter to what two or more people chose, or what everyone agreed on.'],
  ['Built for a shoot', 'Albums per look or setup. Thousands of frames upload in minutes because photos are resized in your browser, and your originals never leave your machine.'],
  ['No accounts for reviewers', 'Send a link. Reviewers type their name and start picking, on a laptop or a phone. Lock a client album with its own password if you like.'],
  ['Retouch notes', 'Pin a note on the spot that needs work, draw on the frame, and export a retouch sheet as a PDF for whoever is retouching.'],
  ['Casting', 'One tile per model, agencies as albums, links and availability on every face, and the same picks and filters.'],
  ['Back into Capture One', 'Pull everyone\'s selects straight into a Capture One album, or export a CSV that matches your RAW files.'],
];

export function landing(env: Env): Response {
  const product = env.PRODUCT_NAME ?? 'Review';
  return layout(env, {
    path: '/',
    title: `${product} — selects for shoots`,
    description: 'Share a shoot. Everyone picks their own selects, nobody overwrites anyone, and you see where they agree.',
    body: `
<section class="hero">
  <h1>Selects, without the email thread.</h1>
  <p>Share a shoot with the brand, the agency and your team. Everyone picks on their own, nobody overwrites anyone, and you see at a glance where they agree.</p>
  <div class="actions">
    <a class="btn" href="/login">Start free</a>
    <a class="btn ghost" href="/pricing">See pricing</a>
  </div>
  <p class="small" style="margin-top:18px">Free for one project. No card needed.</p>
</section>
<section class="features">
${FEATURES.map(([h, p]) => `  <div class="feature"><h3>${esc(h)}</h3><p>${esc(p)}</p></div>`).join('\n')}
</section>
<section class="band">
  <h2>Pay for the shoot, not a subscription.</h2>
  <p>A project costs $6 and stays live for 90 days. Shooting every week? Studio is $9 a month for unlimited projects.</p>
  <a class="btn ghost" href="/pricing">Pricing</a>
</section>`,
  });
}

export function pricing(env: Env): Response {
  const product = env.PRODUCT_NAME ?? 'Review';
  const plan = (name: string, price: string, per: string, items: string[], cta: string) => `
  <div class="plan">
    <h3>${name}</h3>
    <div class="price">${price}</div>
    <div class="per">${per}</div>
    <ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>
    <a class="btn${name === 'Project' ? '' : ' ghost'}" href="/login">${cta}</a>
  </div>`;
  return layout(env, {
    path: '/pricing',
    title: `Pricing — ${product}`,
    description: `${product} pricing: free for one project, $6 per project, or $9 a month for unlimited projects.`,
    body: `
<section class="hero" style="padding-bottom:40px">
  <h1>Simple pricing.</h1>
  <p>Every plan has every feature and unlimited reviewers. Plans differ only in how much is live and for how long.</p>
</section>
<section class="plans">
${plan('Free', '$0', 'to try it on a real job', ['1 live project', 'Up to 300 photos', 'Live for 14 days', 'All features, unlimited reviewers'], 'Start free')}
${plan('Project', '$6', 'one-time, per project · 5 for $25', ['Up to 3,000 photos', 'Live for 90 days', 'Extend 90 days for $3', 'All features, unlimited reviewers'], 'Start a project')}
${plan('Studio', '$9', 'a month, or $79 a year', ['Unlimited projects', 'Up to 5,000 photos per project', 'Your logo on galleries', '3 team seats'], 'Go Studio')}
</section>
<p class="small">Prices in US dollars. Sales tax or VAT is added at checkout where it applies.</p>
<section class="band faq">
  <h2>Questions</h2>
  <h3>Do reviewers pay or need an account?</h3>
  <p>No. Reviewers open your link, type their name and start picking. Only the person running the project needs an account.</p>
  <h3>What happens when a project ends?</h3>
  <p>It becomes read-only for 30 days, so you can still export the selects, and we email you before it's deleted. You can extend it any time before then.</p>
  <h3>Do you keep my original files?</h3>
  <p>No. Photos are resized in your browser before upload, and only those viewing copies are stored. Your originals stay with you.</p>
  <h3>Can I cancel Studio?</h3>
  <p>Any time. You keep Studio until the end of the period you paid for. See the <a href="/refunds">refund policy</a>.</p>
  <h3>Who handles payment?</h3>
  <p>Our reseller Paddle.com runs checkout and is the merchant of record for all orders. Paddle handles payment, tax and invoices.</p>
</section>`,
  });
}

export function terms(env: Env): Response {
  const product = esc(env.PRODUCT_NAME ?? 'Review');
  const co = esc(LEGAL.company);
  return layout(env, {
    path: '/terms',
    title: `Terms of Service — ${product}`,
    description: `Terms of Service for ${product}.`,
    body: `
<article class="legal">
<h1>Terms of Service</h1>
<p class="small">Last updated ${LEGAL.updated}</p>
<p>${product} is a service for sharing photos and collecting selections and notes on them. It is operated by ${co} ("we", "us"). By creating an account or using ${product}, you agree to these terms.</p>

<h2>1. Accounts</h2>
<p>You need an account to create projects. You are responsible for activity under your account and for keeping access to your email address secure, since that is how you sign in. People you invite to review a project ("reviewers") don't need an account. You are responsible for who you share your links with.</p>

<h2>2. Your content</h2>
<p>You keep all rights to the photos, names, notes and other material you or your reviewers add ("your content"). You give us a limited licence to store, process, resize and display your content only to provide ${product} to you and the people you share it with. We don't use your content for anything else, and we don't sell it.</p>
<p>You confirm that you have the right to upload your content and to share it with the people you invite.</p>

<h2>3. Acceptable use</h2>
<p>You may not use ${product} to upload or share material that is illegal, that infringes anyone's rights, or that sexually exploits or endangers minors. You may not try to access other people's projects, disrupt the service, or use it to send spam. We may remove content or suspend accounts that break these rules, and we report child sexual abuse material to the authorities.</p>

<h2>4. Plans, payment and expiry</h2>
<p>Our order process is conducted by our online reseller Paddle.com. Paddle.com is the Merchant of Record for all our orders. Paddle provides all customer service inquiries and handles returns.</p>
<p>A free or one-time project stays live for the period shown when you create or buy it. When that period ends, the project becomes read-only for 30 days and is then deleted, along with its photos, selections and notes. We email you before deletion. A Studio subscription renews automatically until you cancel. You can cancel at any time and keep access until the end of the paid period. Refunds follow our <a href="/refunds">refund policy</a>.</p>

<h2>5. Availability and changes</h2>
<p>We work to keep ${product} available and your content safe, but we provide the service "as is" and can't promise it will be uninterrupted or error-free. Keep your own copies of anything important; your originals are never uploaded to us. We may change or improve features. If we make a change that materially reduces what you paid for, you may ask for a pro-rated refund.</p>

<h2>6. Liability</h2>
<p>To the extent the law allows, ${co} is not liable for indirect or consequential losses, or lost profits or data. Our total liability for any claim is limited to the amount you paid us in the 12 months before it arose.</p>

<h2>7. Ending your account</h2>
<p>You can delete your projects at any time, and ask us to delete your account. We may suspend or close accounts that break these terms. When an account is closed, its content is deleted.</p>

<h2>8. Changes to these terms</h2>
<p>We may update these terms. We'll post the new version here with its date and, for significant changes, email account holders before they take effect.</p>

<h2>9. Law</h2>
<p>These terms are governed by the laws of the State of ${esc(LEGAL.state)}, United States, without regard to conflict-of-law rules. Nothing in these terms limits rights you have as a consumer under the laws of where you live.</p>

<h2>10. Contact</h2>
<p>${co} · <a href="mailto:${LEGAL.contact}">${LEGAL.contact}</a></p>
</article>`,
  });
}

export function privacy(env: Env): Response {
  const product = esc(env.PRODUCT_NAME ?? 'Review');
  const co = esc(LEGAL.company);
  return layout(env, {
    path: '/privacy',
    title: `Privacy Policy — ${product}`,
    description: `How ${product} handles your data.`,
    body: `
<article class="legal">
<h1>Privacy Policy</h1>
<p class="small">Last updated ${LEGAL.updated}</p>
<p>This policy explains what ${co} ("we") collects when you use ${product}, why, and what you can do about it. We collect only what the service needs to work.</p>

<h2>What we collect</h2>
<ul>
  <li><strong>Account details:</strong> your email address and the name you use, for signing in and for showing your picks.</li>
  <li><strong>Reviewer details:</strong> the name, and the email address where a project asks for one, that reviewers enter when they join a project.</li>
  <li><strong>Your content:</strong> resized viewing copies of the photos you upload, with their file names and dimensions. Originals are never uploaded. Also selections, notes, drawings and project settings.</li>
  <li><strong>Technical data:</strong> IP addresses and request logs, used briefly for security, rate limiting and fixing problems.</li>
  <li><strong>Payment details:</strong> handled by Paddle, our reseller and merchant of record. We never see your card number. We receive what we need to manage your plan, such as your plan, billing country and receipts.</li>
</ul>

<h2>Cookies</h2>
<p>We use only the cookies the service needs: one to keep you signed in, and one per project to remember a reviewer. We use no advertising or tracking cookies and no third-party analytics.</p>

<h2>How we use it</h2>
<p>To run ${product}: to sign you in, show your projects to the people you share them with, send the emails the service needs (such as sign-in links and expiry notices), take payment through Paddle, prevent abuse and support you. We don't sell personal data, and we don't use your content to train models.</p>

<h2>Who processes it</h2>
<ul>
  <li><strong>Cloudflare, Inc.:</strong> hosting, storage, databases and email delivery.</li>
  <li><strong>Paddle.com:</strong> checkout, payments, tax and invoicing, under its own privacy policy as merchant of record.</li>
</ul>
<p>These providers may process data in the United States and other countries, with appropriate safeguards such as standard contractual clauses.</p>

<h2>How long we keep it</h2>
<p>Project content is deleted 30 days after a project ends, or when you delete it. Account details are kept while your account is open and deleted when you ask us to close it, except records we must keep for legal or tax reasons. Logs are kept only briefly.</p>

<h2>Your rights</h2>
<p>You can ask to see, correct, export or delete your personal data, or object to how we use it, by emailing <a href="mailto:${LEGAL.contact}">${LEGAL.contact}</a>. If you're in the EU, UK or California, you have these rights under the GDPR, UK GDPR or CCPA, and you may complain to your local data protection authority. If you are a reviewer on someone else's project, you can also ask the project's owner.</p>

<h2>Children</h2>
<p>${product} is for professional use and not intended for anyone under 16.</p>

<h2>Changes</h2>
<p>We'll post any changes here with a new date, and email account holders about significant ones.</p>

<h2>Contact</h2>
<p>${co} · <a href="mailto:${LEGAL.contact}">${LEGAL.contact}</a></p>
</article>`,
  });
}

export function refunds(env: Env): Response {
  const product = esc(env.PRODUCT_NAME ?? 'Review');
  return layout(env, {
    path: '/refunds',
    title: `Refund Policy — ${product}`,
    description: `Refund policy for ${product}.`,
    body: `
<article class="legal">
<h1>Refund Policy</h1>
<p class="small">Last updated ${LEGAL.updated}</p>
<p>Payments for ${product} are processed by our reseller Paddle.com, the merchant of record, which also issues refunds.</p>

<h2>Projects and project packs</h2>
<p>You can get a full refund within 14 days of purchase for any project pass you haven't used yet. Within those 14 days, a pack is refunded for its unused passes. A pass is used once you upload photos to the project it unlocked.</p>

<h2>Studio subscription</h2>
<p>You can cancel at any time from your account. Cancelling stops future renewals, and you keep Studio until the end of the period you've paid for. We don't refund partial periods. If you cancel a new subscription within 14 days of first paying for it, we'll refund that first payment in full.</p>

<h2>How to ask</h2>
<p>Email <a href="mailto:${LEGAL.contact}">${LEGAL.contact}</a> from your account's address, or contact Paddle through your receipt. Refunds go back to the original payment method, usually within 5 to 10 business days.</p>

<h2>Your legal rights</h2>
<p>This policy doesn't limit any refund or cancellation rights you have under the consumer laws of where you live.</p>
</article>`,
  });
}
