import { talentGroupName, groupFromBoard, talentLabel, type TalentGroup } from '../../shared/names';
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

/** Everything the view-only page needs, and nothing more: no picks, no reviewers, no notes. */
export async function viewPayload(env: Env, link: ViewLink, token: string) {
  const [inScope, albumsRes, imagesRes] = await Promise.all([
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
  ]);
  const albumName = new Map(albumsRes.results.map((a) => [a.id, a.name]));
  const shown = imagesRes.results.filter(inScope);
  const casting = link.kind === 'casting';

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

  // The token rides on each image address: it's what lets this page load them.
  const q = `?v=${token}`;
  return {
    project: { name: link.project_name, kind: casting ? 'casting' : 'shoot' },
    // Client-facing: just "Selects", never whose.
    title: 'Selects',
    images: shown.map((i) => {
      const person = casting ? talentGroupName(i.talent_name, i.original_filename) ?? `photo:${i.id}` : null;
      return {
        id: i.id,
        filename: i.original_filename,
        thumb: i.thumb_key + q,
        preview: i.preview_key + q,
        w: i.width,
        h: i.height,
        board: albumName.get(i.album_id) ?? '',
        ...(casting ? {
          person,
          name: talentLabel(i.talent_name, i.original_filename),
          link: i.link,
          info: i.info,
          group: groupOf.get(person!) ?? null,
        } : {}),
      };
    }),
  };
}
