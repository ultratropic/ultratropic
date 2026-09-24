/**
 * Filename helpers shared by the Worker (export, duplicate detection) and the
 * browser (pre-upload warnings), so both sides agree on what "the same frame" is.
 */

export function stripExt(filename: string): string {
  const i = filename.lastIndexOf('.');
  return i > 0 ? filename.slice(0, i) : filename;
}

/**
 * macOS and most exporters resolve a name collision by appending " 1", " 2" or
 * " copy". Those files are different JPEGs of the SAME camera frame, so they all
 * point at one RAW. Only strip the suffix when what precedes it ends in a digit —
 * a frame number — so a genuine name like "Look 2" is left alone.
 */
const COPY_SUFFIX = /^(.*\d)(?: \d{1,2}| copy(?: \d{1,2})?)$/i;

/** The name Capture One would match against: extension and copy suffix removed. */
export function rawMatch(filename: string): string {
  const base = stripExt(filename);
  const m = base.match(COPY_SUFFIX);
  return m ? m[1]! : base;
}

/** AppleDouble resource forks ("._IMG_1.jpg") and zip metadata are never photos. */
export function isJunk(path: string): boolean {
  const name = path.split('/').pop() ?? path;
  return name.startsWith('._') || path.includes('__MACOSX/') || name.startsWith('.');
}
