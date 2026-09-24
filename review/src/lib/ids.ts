const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford, no I/L/O/U
const B62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** ULID: 48-bit timestamp + 80 bits random. Lexicographically sortable by creation time. */
export function ulid(now = Date.now()): string {
  let ts = '';
  for (let i = 9; i >= 0; i--) {
    ts = B32[now % 32] + ts;
    now = Math.floor(now / 32);
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let rand = '';
  for (let i = 0; i < 16; i++) rand += B32[bytes[i]! % 32];
  return ts + rand;
}

/** Unguessable URL token. 10 chars of base62 ~ 59 bits. */
export function token(len = 10): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = '';
  for (let i = 0; i < len; i++) out += B62[bytes[i]! % 62];
  return out;
}

/** Random R2 object key segment — 32 chars, so a leaked URL stays unguessable. */
export function storageKey(): string {
  return token(32);
}

/** Human-readable slug, used for album URLs. Falls back to a token if nothing survives. */
export function slugify(input: string): string {
  const s = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return s || token(6);
}

/** Email identity: trim, lowercase, NFC. Prevents duplicate reviewer rows from casing. */
export function normalizeEmail(email: string): string {
  return email.normalize('NFC').trim().toLowerCase();
}

/** Filename minus its final extension — what Capture One matches a RAW against. */
export function baseName(filename: string): string {
  const i = filename.lastIndexOf('.');
  return i > 0 ? filename.slice(0, i) : filename;
}
