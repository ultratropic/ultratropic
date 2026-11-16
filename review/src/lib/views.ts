import { talentGroupName, groupFromBoard, type TalentGroup } from '../../shared/names';
import type { Env } from '../types';

/**
 * View-only links (/v/<token>): a client-facing page of one person's selects,
 * or of everyone's. Read-only and live — it shows the picks as they are now —
 * and the token reaches only the photos on that page, nothing else in the
 * project.
 */
export interface ViewLink {
  id: string;
  project_id: string;
  reviewer_id: string | null;
  project_name: string;
  kind: string;
  reviewer_name: string | null;
}

export const VIEW_TOKEN = /^[A-Za-z0-9]{24,64}$/;

export async function findViewLink(env: Env, token: string | undefined): Promise<ViewLink | null> {
  if (!token || !VIEW_TOKEN.test(token)) return null;
  const row = await env.DB.prepare(
    `SELECT v.id, v.project_id, v.reviewer_id, p.name AS project_name, p.kind, p.status,
            r.display_name AS reviewer_name
       FROM view_links v
       JOIN projects p ON p.id = v.project_id
       LEFT JOIN reviewers r ON r.id = v.reviewer_id AND r.project_id = v.project_id
      WHERE v.token = ?`,
  )
    .bind(token)
    .first<ViewLink & { status: string }>();
  if (!row || row.status !== 'active') return null;
  // A link to someone's selects ends when that person is removed.
  if (row.reviewer_id && row.reviewer_name === null) return null;
  return row;
}

interface Frame { id: string; talent_name: string | null; original_filename: string }

/**
 * Which photos a link shows. A shoot: the picked frames. A casting: every
 * photo of each picked person (a pick there is a vote for the person), the
 * same as opening them in the gallery.
 */
export async function viewScope(env: Env, link: ViewLink): Promise<(f: Frame) => boolean> {
  // One person's picks; or, for an all-selects link, everyone's except hidden reviewers.
  const picks = await env.DB.prepare(
    `SELECT i.id, i.talent_name, i.original_filename
       FROM selections s
       JOIN images i ON i.id = s.image_id
       JOIN reviewers r ON r.id = s.reviewer_id
      WHERE s.project_id = ?1 AND (r.id = ?2 OR (?2 IS NULL AND r.hidden = 0))`,
  )
    .bind(link.project_id, link.reviewer_id)
    .all<Frame>();
  const ids = new Set(picks.results.map((p) => p.id));
  const people = new Set<string>();
  if (link.kind === 'casting') {
    for (const p of picks.results) {
      const k = talentGroupName(p.talent_name, p.original_filename);
      if (k) people.add(k);
    }
  }
  return (f) => {
    if (ids.has(f.id)) return true;
    if (!people.size) return false;
    const k = talentGroupName(f.talent_name, f.original_filename);
    return !!k && people.has(k);
  };
}

/**
 * The view-only page is the normal gallery, read-only, so this answers in the
 * gallery's own shape (see lib/gallery.ts) — holding only the photos the link
 * reaches, and nothing about who picked them: no picks, no reviewers, no
 * notes, no brief, no downloads.
 */
export async function viewPayload(env: Env, link: ViewLink, token: string) {
  const [inScope, albumsRes, imagesRes, picksRes] = await Promise.all([
    viewScope(env, link),
    env.DB.prepare(`SELECT id, name FROM albums WHERE project_id = ? ORDER BY seq`)
      .bind(link.project_id)
      .all<{ id: string; name: string }>(),
    env.DB.prepare(
      `SELECT i.id, i.original_filename, i.thumb_key, i.preview_key, i.width, i.height, i.album_id,
              i.talent_name, i.link, i.info, i.talent_group
         FROM images i JOIN albums a ON a.id = i.album_id
        WHERE i.project_id = ?
        ORDER BY a.seq, i.seq`,
    )
      .bind(link.project_id)
      .all<{
        id: string; original_filename: string; thumb_key: string; preview_key: string;
        width: number; height: number; album_id: string;
        talent_name: string | null; link: string | null; info: string | null; talent_group: string | null;
      }>(),
    // Whose selects these are, by name, for the sidebar's People list (as in the app).
    env.DB.prepare(
      `SELECT r.id AS rid, r.display_name, s.image_id
         FROM selections s JOIN reviewers r ON r.id = s.reviewer_id
        WHERE s.project_id = ?1 AND (r.id = ?2 OR (?2 IS NULL AND r.hidden = 0))
        ORDER BY r.created_at`,
    )
      .bind(link.project_id, link.reviewer_id)
      .all<{ rid: string; display_name: string; image_id: string }>(),
  ]);
  const shown = imagesRes.results.filter(inScope);
  const casting = link.kind === 'casting';

  // Only the boards that hold something on this page, in their usual order.
  const used = new Set(shown.map((i) => i.album_id));
  const albums = albumsRes.results.filter((a) => used.has(a.id));
  const albumIndex = new Map(albums.map((a, n) => [a.id, n]));
  const albumName = new Map(albums.map((a) => [a.id, a.name]));

  // A person's group: one set on any of their photos, else what a board's name says.
  const groupOf = new Map<string, TalentGroup | null>();
  if (casting) {
    for (const i of shown) {
      const k = talentGroupName(i.talent_name, i.original_filename) ?? `photo:${i.id}`;
      const set = i.talent_group === 'men' || i.talent_group === 'women' || i.talent_group === 'kids' ? i.talent_group : null;
      if (set) groupOf.set(k, set);
      else if (!groupOf.get(k)) groupOf.set(k, groupFromBoard(albumName.get(i.album_id)));
    }
  }

  // Reviewers go out under stand-in ids (p1, p2…), never their real ones.
  const shownIds = new Set(shown.map((i) => i.id));
  const alias = new Map<string, string>();
  const reviewers: Array<{ id: string; name: string; isMe: false; count: number }> = [];
  const selectionsByReviewer: Record<string, string[]> = {};
  for (const p of picksRes.results) {
    if (!shownIds.has(p.image_id)) continue;
    let a = alias.get(p.rid);
    if (!a) {
      a = `p${alias.size + 1}`;
      alias.set(p.rid, a);
      reviewers.push({ id: a, name: p.display_name, isMe: false, count: 0 });
      selectionsByReviewer[a] = [];
    }
    selectionsByReviewer[a]!.push(p.image_id);
  }

  // The token rides on each image address: it's what lets this page load them.
  const q = `?v=${token}`;
  return {
    project: {
      id: '', name: link.project_name, slug: null, previewEdge: 0,
      allowDownloads: false, kind: casting ? 'casting' : 'shoot', brief: null,
    },
    me: { id: '', name: '' },
    albums: albums.map((a) => ({ id: a.id, name: a.name, slug: '' })),
    reviewers,
    selectionsByReviewer,
    fields: ['id', 'filename', 'thumb', 'preview', 'w', 'h', 'album', 'selects', 'mine', 'dup', 'name', 'link', 'info', 'notes', 'notesOpen', 'group'],
    rows: shown.map((i) => {
      const person = casting ? talentGroupName(i.talent_name, i.original_filename) ?? `photo:${i.id}` : null;
      return [
        i.id, i.original_filename, i.thumb_key + q, i.preview_key + q, i.width, i.height,
        albumIndex.get(i.album_id) ?? 0, 0, 0, 0,
        casting ? i.talent_name : null,
        casting ? i.link : null,
        casting ? i.info : null,
        0, 0,
        casting ? groupOf.get(person!) ?? null : null,
      ];
    }),
  };
}
