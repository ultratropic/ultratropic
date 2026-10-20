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

/**
 * Image files the uploader accepts. Every one is converted to the same stored
 * format, so what goes in only has to be something a browser can decode.
 */
export const PHOTO_EXT = /\.(jpe?g|png|webp|heic|heif|tiff?|avif|gif|bmp)$/i;
export const isPhoto = (name: string) => PHOTO_EXT.test(name);

/** Formats only some browsers can decode (HEIC and TIFF: Safari; AVIF: recent browsers). */
export const MAYBE_UNSUPPORTED = /\.(heic|heif|tiff?|avif)$/i;

export const extOf = (name: string) => (name.match(/\.([^.]+)$/)?.[1] ?? '').toUpperCase();

/** "trevor_stewart-02.jpg" → "Trevor Stewart": uploads named after the person. */
export function talentFromFilename(filename: string): string {
  return filename
    .replace(/\.[^.]+$/, '')
    .replace(/[-_ ]\d{1,3}$/, '')
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

/**
 * The name photos are grouped under in a casting, or null if this photo should
 * stand alone. A name set on the photo always counts. One read from the
 * filename only counts if it looks like a person — two or more words of
 * letters ("trevor_stewart_02" → "Trevor Stewart") — so camera files like
 * IMG_001 … IMG_999 don't all collapse into one "Img".
 */
export function talentGroupName(talentName: string | null | undefined, filename: string): string | null {
  if (talentName?.trim()) return talentName.trim().toLowerCase();
  const derived = talentFromFilename(filename);
  const words = derived.split(/\s+/).filter((w) => /^\p{L}[\p{L}'.]*$/u.test(w));
  return words.length >= 2 && words.length === derived.split(/\s+/).length ? derived.toLowerCase() : null;
}

/** What a casting photo is labelled: its name, a person's name read from the filename, or else the filename itself. */
export function talentLabel(talentName: string | null | undefined, filename: string): string {
  if (talentName?.trim()) return talentName.trim();
  return talentGroupName(null, filename) ? talentFromFilename(filename) : filename.replace(/\.[^.]+$/, '');
}
