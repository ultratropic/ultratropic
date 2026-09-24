import type { UploadFile } from './uploadPipeline';
import { isJunk, stripExt } from '../../shared/names';

interface Entry {
  path: string;
  method: number;
  compressedSize: number;
  localOffset: number;
}

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX_U32 = 0xffffffff;

const u64 = (v: DataView, o: number) => Number(v.getBigUint64(o, true));

/**
 * Read a ZIP's table of contents without reading its contents.
 *
 * A shoot zipped for handoff is routinely several gigabytes, so inflating it
 * all in memory (what the common libraries do) would crash the tab before the
 * first resize. Instead: read only the central directory at the end of the file,
 * then slice each photo out of the archive when the pipeline reaches it. Stored
 * entries — the norm for JPEGs, which don't compress — are a zero-copy slice of
 * the file on disk. Handles ZIP64, which macOS switches to past 4 GB.
 */
async function readDirectory(file: File): Promise<Entry[]> {
  const tailSize = Math.min(file.size, 22 + 0xffff + 20);
  const tailStart = file.size - tailSize;
  const tail = new DataView(await file.slice(tailStart).arrayBuffer());

  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');

  let count = tail.getUint16(eocd + 10, true);
  let dirSize = tail.getUint32(eocd + 12, true);
  let dirOffset = tail.getUint32(eocd + 16, true);

  if (count === 0xffff || dirSize === MAX_U32 || dirOffset === MAX_U32) {
    const loc = eocd - 20;
    if (loc < 0 || tail.getUint32(loc, true) !== ZIP64_LOCATOR) throw new Error('corrupt zip64 archive');
    const recOffset = u64(tail, loc + 8);
    const rec = new DataView(await file.slice(recOffset, recOffset + 56).arrayBuffer());
    if (rec.getUint32(0, true) !== ZIP64_EOCD) throw new Error('corrupt zip64 archive');
    count = u64(rec, 32);
    dirSize = u64(rec, 40);
    dirOffset = u64(rec, 48);
  }

  const dir = new DataView(await file.slice(dirOffset, dirOffset + dirSize).arrayBuffer());
  const decoder = new TextDecoder();
  const entries: Entry[] = [];
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (dir.getUint32(p, true) !== CENTRAL) throw new Error('corrupt zip directory');
    const flags = dir.getUint16(p + 8, true);
    const method = dir.getUint16(p + 10, true);
    let compressedSize = dir.getUint32(p + 20, true);
    let uncompressedSize = dir.getUint32(p + 24, true);
    const nameLen = dir.getUint16(p + 28, true);
    const extraLen = dir.getUint16(p + 30, true);
    const commentLen = dir.getUint16(p + 32, true);
    let localOffset = dir.getUint32(p + 42, true);
    const path = decoder.decode(new Uint8Array(dir.buffer, dir.byteOffset + p + 46, nameLen));

    // ZIP64 extra field: carries, in order, only the values that overflowed.
    let x = p + 46 + nameLen;
    const extraEnd = x + extraLen;
    while (x + 4 <= extraEnd) {
      const id = dir.getUint16(x, true);
      const size = dir.getUint16(x + 2, true);
      if (id === 0x0001) {
        let q = x + 4;
        if (uncompressedSize === MAX_U32) { uncompressedSize = u64(dir, q); q += 8; }
        if (compressedSize === MAX_U32) { compressedSize = u64(dir, q); q += 8; }
        if (localOffset === MAX_U32) { localOffset = u64(dir, q); }
      }
      x += 4 + size;
    }
    p = extraEnd + commentLen;

    if (path.endsWith('/')) continue; // directory marker
    if (flags & 0x1) throw new Error(`${path}: encrypted zips aren't supported`);
    if (method !== 0 && method !== 8) throw new Error(`${path}: unsupported compression (${method})`);
    entries.push({ path, method, compressedSize, localOffset });
  }
  return entries;
}

async function loadEntry(file: File, e: Entry): Promise<ArrayBuffer> {
  // The local header's own name/extra lengths can differ from the central
  // directory's, so the data offset has to be read from here, not assumed.
  const head = new DataView(await file.slice(e.localOffset, e.localOffset + 30).arrayBuffer());
  if (head.getUint32(0, true) !== LOCAL) throw new Error('corrupt zip entry');
  const start = e.localOffset + 30 + head.getUint16(26, true) + head.getUint16(28, true);
  const raw = file.slice(start, start + e.compressedSize);
  if (e.method === 0) return raw.arrayBuffer();
  const inflated = raw.stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(inflated).arrayBuffer();
}

/**
 * The JPEGs in a ZIP, each assigned to an album: the folder it sits in inside
 * the archive, or the archive's own name for files at the top level. Resource
 * forks under __MACOSX/ and "._" files — which macOS adds and which also end in
 * .jpg — are dropped.
 */
export async function expandZip(file: File): Promise<UploadFile[]> {
  const entries = await readDirectory(file);
  const fallback = stripExt(file.name);
  return entries
    .filter((e) => /\.jpe?g$/i.test(e.path) && !isJunk(e.path))
    .map((e) => {
      const parts = e.path.split('/');
      return {
        name: parts[parts.length - 1]!,
        folder: parts.length > 1 ? parts[parts.length - 2]! : fallback,
        load: () => loadEntry(file, e),
      };
    });
}
