import type { Env } from '../types';

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * Send one transactional email through Cloudflare Email Service. Returns false
 * (and logs why) instead of throwing, so a caller can answer "couldn't send"
 * rather than a bare 500. Without the binding — local dev on the internal
 * config — the message is only logged.
 */
export async function sendMail(env: Env, mail: Mail): Promise<boolean> {
  if (!env.EMAIL) {
    console.log('[mail] (not sent, no EMAIL binding)', mail.to, mail.subject, '\n' + mail.text);
    return true;
  }
  try {
    await env.EMAIL.send({
      to: mail.to,
      from: { email: env.MAIL_FROM ?? 'no-reply@ultra-tropic.com', name: env.PRODUCT_NAME ?? 'Review' },
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });
    return true;
  } catch (err) {
    const e = err as { code?: string; message?: string };
    console.error('[mail] send failed', e.code, e.message);
    return false;
  }
}

/** Escape text for the HTML half of an email. */
export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}
