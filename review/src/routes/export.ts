import { Hono } from 'hono';
import { readAdmin } from '../lib/auth';
import { slugify } from '../lib/ids';
import { rawMatch } from '../../shared/names';
import type { Env, Vars } from '../types';

const exp = new Hono<{ Bindings: Env; Variables: Vars }>();

exp.use('*', async (c, next) => {
  if (!(await readAdmin(c))) return c.json({ error: 'unauthorized' }, 401);
  await next();
});

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Reviewer names are the one piece of free text a stranger controls. A name like
 * =HYPERLINK(...) would execute when the CSV opens in a spreadsheet, so neutralise
 * it. Filenames are deliberately NOT touched: they must survive byte-for-byte to
 * match files back in Capture One.
 */
function safeName(name: string): string {
  return /^[=+\-@\t\r]/.test(name) ? `'${name}` : name;
}

/** EXIF times are camera-local with no zone, so print them without one. */
function localTime(ms: number | null): string {
  if (ms == null) return '';
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * GET /projects/:pid/export?format=csv|txt&reviewer=all|<id>&album=<id>
 *
 * reviewer=all exports the union of all selects; an id exports one
 * person's. Rows follow gallery order: album, then frame.
 */
exp.get('/projects/:pid/export', async (c) => {
  const projectId = c.req.param('pid');
  const format = c.req.query('format') === 'txt' ? 'txt' : 'csv';
  const reviewerParam = c.req.query('reviewer') ?? 'all';
  const albumParam = c.req.query('album') ?? null;

  const project = await c.env.DB.prepare(`SELECT id, name FROM projects WHERE id = ?`)
    .bind(projectId)
    .first<{ id: string; name: string }>();
  if (!project) return c.json({ error: 'project not found' }, 404);

  const [albums, images, selections, reviewers] = await Promise.all([
    c.env.DB.prepare(`SELECT id, name, seq FROM albums WHERE project_id = ? ORDER BY seq`)
      .bind(projectId)
      .all<{ id: string; name: string; seq: number }>(),
    c.env.DB.prepare(
      `SELECT i.id, i.original_filename, i.album_id, i.capture_time
         FROM images i JOIN albums a ON a.id = i.album_id
        WHERE i.project_id = ?
        ORDER BY a.seq, i.seq`,
    )
      .bind(projectId)
      .all<{ id: string; original_filename: string; album_id: string; capture_time: number | null }>(),
    c.env.DB.prepare(
      `SELECT image_id, reviewer_id FROM selections WHERE project_id = ? ORDER BY created_at`,
    )
      .bind(projectId)
      .all<{ image_id: string; reviewer_id: string }>(),
    c.env.DB.prepare(`SELECT id, display_name FROM reviewers WHERE project_id = ?`)
      .bind(projectId)
      .all<{ id: string; display_name: string }>(),
  ]);

  const reviewerName = new Map(reviewers.results.map((r) => [r.id, r.display_name]));
  if (reviewerParam !== 'all' && !reviewerName.has(reviewerParam)) {
    return c.json({ error: 'reviewer not in project' }, 404);
  }
  const albumName = new Map(albums.results.map((a) => [a.id, a.name]));
  if (albumParam && !albumName.has(albumParam)) return c.json({ error: 'album not in project' }, 404);

  const pickers = new Map<string, string[]>();
  for (const s of selections.results) {
    (pickers.get(s.image_id) ?? pickers.set(s.image_id, []).get(s.image_id)!).push(s.reviewer_id);
  }

  const chosen = images.results.filter((img) => {
    if (albumParam && img.album_id !== albumParam) return false;
    const who = pickers.get(img.id);
    if (!who) return false;
    return reviewerParam === 'all' || who.includes(reviewerParam);
  });

  const who = reviewerParam === 'all' ? 'all' : slugify(reviewerName.get(reviewerParam)!);
  const where = albumParam ? `-${slugify(albumName.get(albumParam)!)}` : '';
  const filename = `${slugify(project.name)}-selects-${who}${where}.${format}`;

  let body: string;
  if (format === 'txt') {
    // The simplest possible handoff: one original filename per line, exactly as uploaded.
    body = chosen.map((i) => i.original_filename).join('\n') + (chosen.length ? '\n' : '');
  } else {
    // Two different exports of one frame ("X.jpg" and "X 1.jpg") resolve to the same
    // RAW. Say so in the file, so the match back in Capture One is never a silent guess.
    const byRaw = new Map<string, string[]>();
    for (const img of chosen) {
      const key = rawMatch(img.original_filename).toLowerCase();
      (byRaw.get(key) ?? byRaw.set(key, []).get(key)!).push(img.original_filename);
    }

    const lines = ['filename,raw_match,album,select_count,selected_by,capture_time,note'];
    for (const img of chosen) {
      const raw = rawMatch(img.original_filename);
      const siblings = (byRaw.get(raw.toLowerCase()) ?? []).filter((f) => f !== img.original_filename);
      const names = (pickers.get(img.id) ?? []).map((id) => safeName(reviewerName.get(id) ?? '?'));
      lines.push(
        [
          csvField(img.original_filename),
          csvField(raw),
          csvField(albumName.get(img.album_id) ?? ''),
          String(names.length),
          csvField(names.join('; ')),
          localTime(img.capture_time),
          siblings.length ? csvField(`same RAW as ${siblings.join(', ')}`) : '',
        ].join(','),
      );
    }
    body = lines.join('\r\n') + '\r\n';
  }

  return new Response(body, {
    headers: {
      'content-type': format === 'txt' ? 'text/plain; charset=utf-8' : 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'cache-control': 'no-store',
    },
  });
});

export default exp;
