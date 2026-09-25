/**
 * Downloads, all in the browser: one frame as a JPEG, or a set as a ZIP.
 *
 * What's stored is the 2400px review copy (originals are never uploaded), mostly
 * as WebP. Clients expect JPEGs, so each frame is re-encoded as it downloads and
 * named with its original filename — the same name that matches the RAW in
 * Capture One. The ZIP is "stored" (JPEGs don't compress) with a folder per album.
 */

const JPEG_QUALITY = 0.92;

let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function asJpeg(blob: Blob): Promise<Blob> {
  if (blob.type === 'image/jpeg') return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
  bitmap.close();
  const out = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', JPEG_QUALITY));
  canvas.width = canvas.height = 0; // release the pixels now, not at GC
  if (!out) throw new Error('could not encode JPEG');
  return out;
}

async function fetchFrame(previewKey: string, signal?: AbortSignal): Promise<Blob> {
  const res = await fetch(`/i/${previewKey}`, { credentials: 'same-origin', signal });
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  return asJpeg(await res.blob());
}

/** The original name, but always ending .jpg/.jpeg since that's what it now is. */
function jpegName(filename: string): string {
  return /\.jpe?g$/i.test(filename) ? filename : `${filename.replace(/\.[^.]+$/, '')}.jpg`;
}

function save(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function downloadOne(frame: { filename: string; preview: string }): Promise<void> {
  save(await fetchFrame(frame.preview), jpegName(frame.filename));
}

const safeSegment = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '-').replace(/^\.+/, '').trim() || 'album';

export interface ZipItem { filename: string; preview: string; album: string }

export async function downloadZip(
  items: ZipItem[],
  zipName: string,
  onProgress: (done: number, total: number) => void,
  signal: AbortSignal,
): Promise<void> {
  const enc = new TextEncoder();
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

  interface Entry { name: Uint8Array<ArrayBuffer>; crc: number; size: number; offset: number; data: Blob }
  const entries: Array<Entry | undefined> = new Array(items.length);
  let done = 0;
  let next = 0;

  // A few frames at a time: enough to keep the network busy without holding
  // dozens of decoded 2400px bitmaps at once.
  async function worker() {
    while (next < items.length) {
      if (signal.aborted) throw new DOMException('cancelled', 'AbortError');
      const i = next++;
      const item = items[i]!;
      const data = await fetchFrame(item.preview, signal);
      const crc = crc32(new Uint8Array(await data.arrayBuffer()));
      entries[i] = {
        name: enc.encode(`${safeSegment(item.album)}/${jpegName(item.filename)}`),
        crc, size: data.size, offset: 0, data,
      };
      onProgress(++done, items.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, worker));

  const parts: BlobPart[] = [];
  let offset = 0;
  for (const e of entries as Entry[]) {
    e.offset = offset;
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true);
    h.setUint16(4, 20, true);          // version needed
    h.setUint16(6, 0x0800, true);      // UTF-8 names
    h.setUint16(8, 0, true);           // stored
    h.setUint16(10, dosTime, true);
    h.setUint16(12, dosDate, true);
    h.setUint32(14, e.crc, true);
    h.setUint32(18, e.size, true);
    h.setUint32(22, e.size, true);
    h.setUint16(26, e.name.length, true);
    parts.push(h.buffer, e.name, e.data);
    offset += 30 + e.name.length + e.size;
  }
  if (offset > 0xfff00000) throw new Error('too large for one ZIP; download fewer at a time');

  const dirStart = offset;
  for (const e of entries as Entry[]) {
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true);
    c.setUint16(12, dosTime, true);
    c.setUint16(14, dosDate, true);
    c.setUint32(16, e.crc, true);
    c.setUint32(20, e.size, true);
    c.setUint32(24, e.size, true);
    c.setUint16(28, e.name.length, true);
    c.setUint32(42, e.offset, true);
    parts.push(c.buffer, e.name);
    offset += 46 + e.name.length;
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, offset - dirStart, true);
  end.setUint32(16, dirStart, true);
  parts.push(end.buffer);

  save(new Blob(parts, { type: 'application/zip' }), `${safeSegment(zipName)}.zip`);
}
