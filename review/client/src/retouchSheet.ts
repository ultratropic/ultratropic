/**
 * The retouch sheet: every photo with notes, its marks drawn on, its notes
 * numbered beside it — the handoff to a retoucher. Built entirely in the
 * browser from the 2400px review copies.
 *
 * Two forms: a PDF (one page per photo, notes in a column beside it), or a
 * ZIP of the marked-up JPEGs plus a text file of the notes, for retouchers
 * who'd rather lay the marks over the RAW in Photoshop.
 */
import { pinNumbers, type Note } from './NotesPanel';
import { geometry, HALO, HALO_COLOR, STROKE } from './marks';
import { buildZip, jpegName, safeSegment, save } from './download';

export interface SheetFrame {
  id: string;
  filename: string;
  preview: string;
  album: string;
}
export type ProjectNote = Note & { imageId: string };

const PIN = '#f5c400';
const PIN_DONE = '#9a9a9a';
const JPEG_QUALITY = 0.9;

/** One photo's part of the sheet: the notes that make it in, numbered as on screen. */
interface Page {
  frame: SheetFrame;
  notes: Note[];          // the included top-level notes and all their replies
  numbers: Map<string, number>;
}

function plan(frames: SheetFrame[], notes: ProjectNote[], includeResolved: boolean): Page[] {
  const byImage = new Map<string, Note[]>();
  for (const n of notes) (byImage.get(n.imageId) ?? byImage.set(n.imageId, []).get(n.imageId)!).push(n);
  const pages: Page[] = [];
  for (const frame of frames) {
    const all = byImage.get(frame.id) ?? [];
    const top = all.filter((n) => !n.parentId && (includeResolved || !n.resolvedAt));
    if (!top.length) continue;
    const keep = new Set(top.map((n) => n.id));
    pages.push({
      frame,
      // Numbers come from every note, resolved or not, so they match the app.
      numbers: pinNumbers(all),
      notes: all.filter((n) => keep.has(n.id) || (n.parentId && keep.has(n.parentId))),
    });
  }
  return pages;
}

/** The photo with its marks and numbered pins drawn on, as a JPEG. */
async function renderMarked(page: Page, signal: AbortSignal): Promise<{ jpeg: Blob; w: number; h: number }> {
  const res = await fetch(`/i/${page.frame.preview}`, { credentials: 'same-origin', signal });
  if (!res.ok) throw new Error(`${page.frame.filename}: download failed (${res.status})`);
  const bitmap = await createImageBitmap(await res.blob());
  const w = bitmap.width;
  const h = bitmap.height;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  // A little heavier than on screen (as if the photo were ~650px wide): on a
  // printed page or a thumbnail the photo is small, and the marks must still read.
  const px = Math.max(w, h) / 650;
  const top = page.notes.filter((n) => !n.parentId);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const n of top) {
    if (!n.shapes) continue;
    ctx.globalAlpha = n.resolvedAt ? 0.35 : 1;
    for (const s of n.shapes) {
      const g = geometry(s, w, h, px);
      const path = new Path2D();
      if (g.kind === 'ellipse') path.ellipse(g.cx, g.cy, g.rx, g.ry, 0, 0, Math.PI * 2);
      else path.addPath(new Path2D(g.d));
      ctx.strokeStyle = HALO_COLOR;
      ctx.lineWidth = STROKE * px * HALO;
      ctx.stroke(path);
      ctx.strokeStyle = s.c;
      ctx.lineWidth = STROKE * px;
      ctx.stroke(path);
    }
  }
  ctx.globalAlpha = 1;
  // Pins on top of the marks, each with its number.
  const r = 12 * px;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `600 ${Math.round(12 * px)}px -apple-system, Helvetica, Arial, sans-serif`;
  for (const n of top) {
    const num = page.numbers.get(n.id);
    if (num === undefined || n.x === null || n.y === null) continue;
    const [cx, cy] = [n.x * w, n.y * h];
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = n.resolvedAt ? PIN_DONE : PIN;
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 6 * px;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 2 * px;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    ctx.fillStyle = n.resolvedAt ? '#fff' : '#111';
    ctx.fillText(String(num), cx, cy + px * 0.5);
  }

  const jpeg = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, 'image/jpeg', JPEG_QUALITY));
  canvas.width = canvas.height = 0; // release the pixels now, not at GC
  if (!jpeg) throw new Error(`${page.frame.filename}: could not encode`);
  return { jpeg, w, h };
}

/** Plain-text lines for one photo's notes: number, words, who, and replies under them. */
function noteLines(page: Page): Array<{ num: string; text: string; meta: string; reply: boolean; resolved: boolean }> {
  const out: ReturnType<typeof noteLines> = [];
  const top = page.notes.filter((n) => !n.parentId);
  // Pinned notes in number order, then general notes.
  top.sort((a, b) => (page.numbers.get(a.id) ?? 1e9) - (page.numbers.get(b.id) ?? 1e9) || a.createdAt - b.createdAt);
  for (const n of top) {
    const num = page.numbers.get(n.id);
    out.push({
      num: num === undefined ? '•' : String(num),
      text: n.body || (n.shapes?.length ? '(see drawing)' : ''),
      meta: `${n.author}${n.resolvedAt ? ` · resolved${n.resolvedBy ? ` by ${n.resolvedBy}` : ''}` : ''}`,
      reply: false,
      resolved: !!n.resolvedAt,
    });
    for (const r of page.notes.filter((x) => x.parentId === n.id)) {
      out.push({ num: '', text: r.body, meta: r.author, reply: true, resolved: !!n.resolvedAt });
    }
  }
  return out;
}

// ---- PDF ----

/**
 * The PDF's standard Helvetica only has the Windows-1252 characters; anything
 * else (emoji, other scripts) would make pdf-lib throw, so it becomes "?".
 */
const WIN_ANSI_EXTRA = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x017d,
  0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
]);
const pdfSafe = (s: string) =>
  [...s.replace(/\t/g, ' ')].map((ch) => {
    const c = ch.codePointAt(0)!;
    return (c >= 32 && c <= 126) || (c >= 160 && c <= 255) || WIN_ANSI_EXTRA.has(c) ? ch : '?';
  }).join('');

export async function makeRetouchSheet(opts: {
  format: 'pdf' | 'zip';
  project: string;
  frames: SheetFrame[];
  notes: ProjectNote[];
  includeResolved: boolean;
  onProgress: (done: number, total: number) => void;
  signal: AbortSignal;
}): Promise<number> {
  const pages = plan(opts.frames, opts.notes, opts.includeResolved);
  if (!pages.length) throw new Error(opts.includeResolved ? 'No photos have notes.' : 'No open notes. Include resolved ones?');

  // Render a few at a time, keeping the order.
  const rendered: Array<{ jpeg: Blob; w: number; h: number } | undefined> = new Array(pages.length);
  let next = 0;
  let done = 0;
  opts.onProgress(0, pages.length);
  await Promise.all(Array.from({ length: Math.min(3, pages.length) }, async () => {
    while (next < pages.length) {
      if (opts.signal.aborted) throw new DOMException('cancelled', 'AbortError');
      const i = next++;
      rendered[i] = await renderMarked(pages[i]!, opts.signal);
      opts.onProgress(++done, pages.length);
    }
  }));

  const stamp = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const title = `${opts.project} - Retouch sheet`;

  if (opts.format === 'zip') {
    const files: Array<{ name: string; data: Blob }> = [];
    const txt: string[] = [`${opts.project} — retouch notes`, stamp, ''];
    pages.forEach((page, i) => {
      const base = jpegName(page.frame.filename).replace(/\.jpe?g$/i, '');
      files.push({ name: `${safeSegment(page.frame.album)}/${base} (notes).jpg`, data: rendered[i]!.jpeg });
      txt.push(`${page.frame.filename}  —  ${page.frame.album}`);
      for (const l of noteLines(page)) {
        txt.push(l.reply ? `      > ${l.text}  (${l.meta})` : `  ${l.num === '•' ? ' •' : `${l.num.padStart(2)}.`} ${l.text}  (${l.meta})`);
      }
      txt.push('');
    });
    files.push({ name: 'Retouch notes.txt', data: new Blob([txt.join('\r\n')], { type: 'text/plain' }) });
    save(await buildZip(files), `${safeSegment(title)}.zip`);
    return pages.length;
  }

  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  pdf.setTitle(pdfSafe(title));
  pdf.setCreator('review.ultra-tropic.com');
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  // US Letter, landscape: the photo on the left, notes in a column on the right.
  const W = 792, H = 612, M = 36;
  const COL_W = 236;
  const imgBox = { x: M, y: M, w: W - M * 3 - COL_W, h: H - M * 2 - 26 };
  const colX = W - M - COL_W;
  const ink = rgb(0.07, 0.07, 0.07);
  const grey = rgb(0.45, 0.45, 0.45);
  const yellow = rgb(0.96, 0.77, 0);
  const done_ = rgb(0.6, 0.6, 0.6);

  const wrap = (text: string, f: typeof font, size: number, width: number): string[] => {
    const lines: string[] = [];
    for (const para of pdfSafe(text).split(/\r?\n/)) {
      let line = '';
      for (const word of para.split(' ')) {
        const tryLine = line ? `${line} ${word}` : word;
        if (f.widthOfTextAtSize(tryLine, size) <= width) { line = tryLine; continue; }
        if (line) lines.push(line);
        // A word longer than the column is broken by character.
        let w = word;
        while (f.widthOfTextAtSize(w, size) > width) {
          let k = w.length;
          while (k > 1 && f.widthOfTextAtSize(w.slice(0, k), size) > width) k--;
          lines.push(w.slice(0, k));
          w = w.slice(k);
        }
        line = w;
      }
      lines.push(line);
    }
    return lines;
  };

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]!;
    const r = rendered[i]!;
    let p = pdf.addPage([W, H]);
    const header = (pg: typeof p, cont: boolean) => {
      pg.drawText(pdfSafe(page.frame.filename) + (cont ? '  (continued)' : ''), { x: M, y: H - M - 4, size: 12, font: bold, color: ink });
      const right = pdfSafe(`${page.frame.album}  ·  ${opts.project}  ·  ${stamp}  ·  ${i + 1}/${pages.length}`);
      pg.drawText(right, { x: W - M - font.widthOfTextAtSize(right, 8), y: H - M - 2, size: 8, font, color: grey });
    };
    header(p, false);

    const img = await pdf.embedJpg(new Uint8Array(await r.jpeg.arrayBuffer()));
    const scale = Math.min(imgBox.w / r.w, imgBox.h / r.h);
    const iw = r.w * scale, ih = r.h * scale;
    // Top-aligned, level with the start of the notes.
    p.drawImage(img, { x: imgBox.x + (imgBox.w - iw) / 2, y: imgBox.y + imgBox.h - ih, width: iw, height: ih });

    // The notes column, continuing onto extra pages if it's long.
    let y = H - M - 34;
    const need = (h: number) => {
      if (y - h >= M) return;
      p = pdf.addPage([W, H]);
      header(p, true);
      y = H - M - 34;
    };
    for (const l of noteLines(page)) {
      const indent = l.reply ? 34 : 24;
      const body = wrap(l.text || ' ', font, l.reply ? 9 : 10, COL_W - indent);
      const meta = wrap(l.meta, font, 7.5, COL_W - indent);
      need(body.length * 13 + meta.length * 10 + 10);
      if (!l.reply) {
        p.drawCircle({ x: colX + 8, y: y - 3, size: 8, color: l.resolved ? done_ : yellow });
        const n = pdfSafe(l.num);
        p.drawText(n, { x: colX + 8 - bold.widthOfTextAtSize(n, 8) / 2, y: y - 6, size: 8, font: bold, color: l.resolved ? rgb(1, 1, 1) : ink });
      }
      for (const line of body) {
        p.drawText(line, { x: colX + indent, y: y - 7, size: l.reply ? 9 : 10, font, color: l.resolved ? grey : ink });
        y -= 13;
      }
      for (const line of meta) {
        p.drawText(line, { x: colX + indent, y: y - 5, size: 7.5, font, color: grey });
        y -= 10;
      }
      y -= l.reply ? 4 : 8;
    }
  }

  const bytes = await pdf.save();
  save(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }), `${safeSegment(title)}.pdf`);
  return pages.length;
}
