/// <reference lib="webworker" />
/**
 * Decode -> orient -> downscale -> encode, off the main thread.
 * One instance per hardware thread; the pool in uploader.ts feeds these.
 */

export interface ResizeRequest {
  id: string;
  filename: string;
  buffer: ArrayBuffer;
  thumbEdge: number;
  previewEdge: number;
}

export interface ResizeResult {
  id: string;
  filename: string;
  thumb: Blob;
  preview: Blob;
  width: number;
  height: number;
  captureTime: number | null;
  /** SHA-256 of the original bytes, for spotting the same file uploaded twice. */
  checksum: string;
  error?: string;
}

/**
 * EXIF DateTimeOriginal, read straight from the APP1 segment.
 * Worth the ~60 lines: it is the only reliable capture order for a multi-camera
 * shoot, and file mtime is not it (an export rewrites mtime to the export date).
 */
function readCaptureTime(buf: ArrayBuffer): number | null {
  const view = new DataView(buf);
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null; // not a JPEG

  let offset = 2;
  while (offset + 4 < view.byteLength) {
    if (view.getUint8(offset) !== 0xff) break;
    const marker = view.getUint8(offset + 1);
    const size = view.getUint16(offset + 2);
    if (marker === 0xe1) {
      const start = offset + 4;
      // "Exif\0\0"
      if (view.getUint32(start) !== 0x45786966) return null;
      const tiff = start + 6;
      const little = view.getUint16(tiff) === 0x4949;
      const get16 = (o: number) => view.getUint16(o, little);
      const get32 = (o: number) => view.getUint32(o, little);
      if (get16(tiff + 2) !== 0x002a) return null;

      const ifd0 = tiff + get32(tiff + 4);
      const count = get16(ifd0);
      let exifIfd = 0;
      for (let i = 0; i < count; i++) {
        const entry = ifd0 + 2 + i * 12;
        if (get16(entry) === 0x8769) exifIfd = tiff + get32(entry + 8);
      }
      if (!exifIfd) return null;

      const subCount = get16(exifIfd);
      for (let i = 0; i < subCount; i++) {
        const entry = exifIfd + 2 + i * 12;
        const tag = get16(entry);
        // 0x9003 DateTimeOriginal, 0x9004 DateTimeDigitized as a fallback
        if (tag === 0x9003 || tag === 0x9004) {
          const len = get32(entry + 4);
          const valueOffset = len > 4 ? tiff + get32(entry + 8) : entry + 8;
          let s = '';
          for (let j = 0; j < Math.min(len, 19); j++) s += String.fromCharCode(view.getUint8(valueOffset + j));
          // "2026:09:16 14:22:03"
          const m = s.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
          if (m) {
            return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
          }
        }
      }
      return null;
    }
    if (marker === 0xda) break; // start of scan, no more metadata
    offset += 2 + size;
  }
  return null;
}

/** Fit inside a square of `edge` without distorting, and never upscale. */
function fit(width: number, height: number, edge: number): { w: number; h: number } {
  const scale = Math.min(edge / Math.max(width, height), 1);
  return { w: Math.max(1, Math.round(width * scale)), h: Math.max(1, Math.round(height * scale)) };
}

async function encode(bitmap: ImageBitmap, edge: number, quality: number): Promise<Blob> {
  const { w, h } = fit(bitmap.width, bitmap.height, edge);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);

  // Not every browser can ENCODE WebP even when it decodes it happily — Safari
  // silently hands back a PNG instead of refusing. A PNG of a photograph is many
  // times larger than the JPEG it should have been, so fall back deliberately
  // rather than storing whatever turned up.
  const webp = await canvas.convertToBlob({ type: 'image/webp', quality });
  if (webp.type === 'image/webp') return webp;

  const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
  if (jpeg.type === 'image/jpeg') return jpeg;

  throw new Error(`browser cannot encode webp or jpeg (produced ${jpeg.type || 'unknown'})`);
}

self.onmessage = async (e: MessageEvent<ResizeRequest>) => {
  const { id, filename, buffer, thumbEdge, previewEdge } = e.data;
  try {
    if (typeof OffscreenCanvas === 'undefined') {
      throw new Error('this browser has no OffscreenCanvas (needs Safari 16.4+, or use Chrome)');
    }
    if (typeof createImageBitmap === 'undefined') {
      throw new Error('this browser has no createImageBitmap');
    }
    const captureTime = readCaptureTime(buffer);
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    const checksum = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');

    // imageOrientation: 'from-image' applies the EXIF rotation during decode, so
    // everything downstream works in display orientation. Files with the tag already
    // baked in are unaffected.
    const bitmap = await createImageBitmap(new Blob([buffer]), { imageOrientation: 'from-image' });

    const [preview, thumb] = await Promise.all([
      encode(bitmap, previewEdge, 0.72),
      encode(bitmap, thumbEdge, 0.7),
    ]);
    const { w, h } = fit(bitmap.width, bitmap.height, previewEdge);
    bitmap.close();

    const result: ResizeResult = {
      id, filename, thumb, preview, width: w, height: h, captureTime, checksum,
    };
    (self as unknown as Worker).postMessage(result);
  } catch (err) {
    (self as unknown as Worker).postMessage({
      id,
      filename,
      error: (err as Error).message,
    } as ResizeResult);
  }
};
