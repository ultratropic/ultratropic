import { Hono } from 'hono';
import { slugify } from '../lib/ids';
import { rawMatch, talentGroupName, talentLabel } from '../../shared/names';
import { selectedByEveryone } from '../../shared/everyone';
import { listProjectNotes, notesLine } from '../lib/notes';
import type { Env, Vars } from '../types';

const exp = new Hono<{ Bindings: Env; Variables: Vars }>();

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
 * GET /projects/:pid/export?format=csv|txt&reviewer=all|<id>&album=<id>&min=<n>
 *
 * reviewer=all exports the union of all selects; an id exports one
 * person's. min=2 keeps only frames at least that many people picked;
 * everyone=1 keeps frames every active reviewer picked (shared/everyone.ts).
 * Rows follow gallery order: album, then frame.
 */
exp.get('/projects/:pid/export', async (c) => {
  const projectId = c.req.param('pid');
  const format = c.req.query('format') === 'txt' ? 'txt' : 'csv';
  const reviewerParam = c.req.query('reviewer') ?? 'all';
  const albumParam = c.req.query('album') ?? null;
  const minPickers = Math.max(1, Number.parseInt(c.req.query('min') ?? '1', 10) || 1);
  const everyoneOnly = c.req.query('everyone') === '1';

  const project = await c.env.DB.prepare(`SELECT id, name, kind FROM projects WHERE id = ?`)
    .bind(projectId)
    .first<{ id: string; name: string; kind: string }>();
  if (!project) return c.json({ error: 'project not found' }, 404);

  const [albums, images, selections, reviewers] = await Promise.all([
    c.env.DB.prepare(`SELECT id, name, seq FROM albums WHERE project_id = ? ORDER BY seq`)
      .bind(projectId)
      .all<{ id: string; name: string; seq: number }>(),
    c.env.DB.prepare(
      `SELECT i.id, i.original_filename, i.album_id, i.capture_time, i.talent_name, i.link, i.info
         FROM images i JOIN albums a ON a.id = i.album_id
        WHERE i.project_id = ?
        ORDER BY a.seq, i.seq`,
    )
      .bind(projectId)
      .all<{
        id: string; original_filename: string; album_id: string; capture_time: number | null;
        talent_name: string | null; link: string | null; info: string | null;
      }>(),
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

  // A casting shortlist is about people: who, which agency, where to see more.
  const casting = project.kind === 'casting';
  const talent = (img: { talent_name: string | null; original_filename: string }) =>
    talentLabel(img.talent_name, img.original_filename);

  /**
   * What a select is a vote for: a photo in a shoot, a model in a casting (any
   * of their photos in that album) — the same units the gallery's filters use,
   * so "2+" and "Everyone" export exactly what they show.
   */
  const unitOf = (img: (typeof images.results)[number]) => {
    const name = casting ? talentGroupName(img.talent_name, img.original_filename) : null;
    return name ? `${img.album_id}:${name}` : img.id;
  };
  const unitById = new Map(images.results.map((img) => [img.id, unitOf(img)]));

  const pickers = new Map<string, string[]>();
  for (const s of selections.results) {
    const u = unitById.get(s.image_id);
    if (!u) continue;
    const list = pickers.get(u) ?? pickers.set(u, []).get(u)!;
    if (!list.includes(s.reviewer_id)) list.push(s.reviewer_id);
  }

  const picksByReviewer: Record<string, string[]> = {};
  for (const [u, who] of pickers) for (const rid of who) (picksByReviewer[rid] ??= []).push(u);
  const everyone = everyoneOnly ? selectedByEveryone(picksByReviewer, new Set(unitById.values()).size).ids : null;

  const chosen = images.results.filter((img) => {
    if (albumParam && img.album_id !== albumParam) return false;
    const u = unitById.get(img.id)!;
    if (everyone && !everyone.has(u)) return false;
    const who = pickers.get(u);
    if (!who || who.length < minPickers) return false;
    return reviewerParam === 'all' || who.includes(reviewerParam);
  });

  const who = reviewerParam === 'all' ? 'all' : slugify(reviewerName.get(reviewerParam)!);
  const where = albumParam ? `-${slugify(albumName.get(albumParam)!)}` : '';
  const atLeast = everyoneOnly ? '-everyone' : minPickers > 1 ? `-${minPickers}plus` : '';
  const filename = `${slugify(project.name)}-selects-${who}${atLeast}${where}.${format}`;

  // Retouch notes per frame, appended to the CSV as one readable column.
  const notesBy = new Map<string, Parameters<typeof notesLine>[0]>();
  if (format === 'csv') {
    for (const n of await listProjectNotes(c.env, projectId, '')) {
      (notesBy.get(n.imageId) ?? notesBy.set(n.imageId, []).get(n.imageId)!).push(n);
    }
  }
  const notesFor = (id: string) => csvField(safeName(notesLine(notesBy.get(id) ?? [])));

  let body: string;
  // One row per model in a casting (their first photo's details, all their files).
  const people = new Map<string, Array<(typeof chosen)[number]>>();
  if (casting) for (const img of chosen) (people.get(unitById.get(img.id)!) ?? people.set(unitById.get(img.id)!, []).get(unitById.get(img.id)!)!).push(img);

  if (casting && format === 'txt') {
    const rows = [...people.values()].map(([img]) => `${talent(img!)} — ${albumName.get(img!.album_id) ?? ''}`);
    body = rows.join('\n') + (rows.length ? '\n' : '');
  } else if (casting) {
    const lines = ['name,agency,portfolio,status,select_count,selected_by,photos,filenames,notes'];
    for (const [u, photos] of people) {
      const img = photos[0]!;
      const names = (pickers.get(u) ?? []).map((id) => safeName(reviewerName.get(id) ?? '?'));
      const notes = photos.map((p) => notesLine(notesBy.get(p.id) ?? [])).filter(Boolean).join(' | ');
      lines.push([
        csvField(safeName(talent(img))),
        csvField(safeName(albumName.get(img.album_id) ?? '')),
        csvField(img.link ?? ''),
        csvField(safeName(img.info ?? '')),
        String(names.length),
        csvField(names.join('; ')),
        String(photos.length),
        csvField(photos.map((p) => p.original_filename).join('; ')),
        csvField(safeName(notes)),
      ].join(','));
    }
    body = lines.join('\r\n') + '\r\n';
  } else if (format === 'txt') {
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

    // project and view (which selection this is: "All", "2+", "Everyone", or a
    // person) let the Capture One script name its albums without guessing from
    // the file name. They go last so older readers of the first columns still work.
    const view = everyoneOnly ? 'Everyone'
      : minPickers > 1 ? `${minPickers}+`
        : reviewerParam === 'all' ? 'All'
          : safeName(reviewerName.get(reviewerParam)!);
    const viewWithAlbum = albumParam ? `${view} (${albumName.get(albumParam)})` : view;
    const lines = ['filename,raw_match,album,select_count,selected_by,capture_time,note,project,view,retouch_notes'];
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
          csvField(project.name),
          csvField(viewWithAlbum),
          notesFor(img.id),
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
