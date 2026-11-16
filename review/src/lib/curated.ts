import { talentGroupName, groupFromBoard, type TalentGroup } from '../../shared/names';
import type { Env } from '../types';

/**
 * Curated links (/c/<token>): a client page of people in titled sections, no
 * sidebar, where anyone with the link can still make their own selects. It
 * reaches only the photos of the people on it.
 *
 * A section lists people by name (fixed), or follows someone's selects (live):
 *   { title, people: [names] }                      — always these people, in this order
 *   { title, from: <reviewer id>, group: 'kids' }   — that person's current picks in this group
 *   { title, from: <reviewer id> }                  — the rest of that person's current picks
 * Someone named in a fixed section stays there; live sections fill A to Z.
 */
export interface CuratedSection { title: string; people?: string[]; from?: string; group?: TalentGroup }
export interface CuratedLink {
  id: string;
  project_id: string;
  title: string | null;
  sections: CuratedSection[];
  /** Where each person on the page goes (by grouping key), filled by resolve(). */
  place: Map<string, { section: number; order: number }>;
}

/** A random token, or a readable slug set on the link (lowercase words joined by hyphens). */
export const CURATED_TOKEN = /^(?:[A-Za-z0-9]{24,64}|[a-z0-9]+(?:-[a-z0-9]+)*)$/;

/** Who a photo is of, in the form the link's names are compared in. */
const keyOf = (talentName: string | null, filename: string) => talentGroupName(talentName, filename);

type Row = { id: string; project_id: string; title: string | null; layout: string };

function parse(row: Row): CuratedLink | null {
  try {
    const l = JSON.parse(row.layout) as { sections?: unknown };
    if (!Array.isArray(l.sections)) return null;
    const sections: CuratedSection[] = l.sections
      .filter((s): s is Record<string, unknown> => !!s && typeof s.title === 'string')
      .map((s) => ({
        title: s.title as string,
        people: Array.isArray(s.people) ? s.people.filter((p): p is string => typeof p === 'string') : undefined,
        from: typeof s.from === 'string' ? s.from : undefined,
        group: s.group === 'men' || s.group === 'women' || s.group === 'kids' ? s.group : undefined,
      }));
    return { id: row.id, project_id: row.project_id, title: row.title, sections, place: new Map() };
  } catch {
    return null;
  }
}

/** Places everyone on the page: the named people, then (live) whoever the followed person has picked. */
async function resolve(env: Env, link: CuratedLink): Promise<CuratedLink> {
  const place = new Map<string, { section: number; order: number }>();
  link.sections.forEach((s, section) => (s.people ?? []).forEach((name, order) => {
    const k = name.trim().toLowerCase();
    if (k && !place.has(k)) place.set(k, { section, order });
  }));

  const followed = [...new Set(link.sections.map((s) => s.from).filter((r): r is string => !!r))];
  for (const rid of followed) {
    const res = await env.DB.prepare(
      `SELECT i.talent_name, i.original_filename, i.talent_group, a.name AS album,
              EXISTS (SELECT 1 FROM selections s WHERE s.image_id = i.id AND s.reviewer_id = ?1) AS picked
         FROM images i JOIN albums a ON a.id = i.album_id
        WHERE i.project_id = ?2`,
    )
      .bind(rid, link.project_id)
      .all<{ talent_name: string | null; original_filename: string; talent_group: string | null; album: string; picked: number }>();
    // Each person: picked on any of their photos? Their group: one set on them, else what a board's name says.
    const people = new Map<string, { picked: boolean; set: TalentGroup | null; board: TalentGroup | null }>();
    for (const r of res.results) {
      const k = talentGroupName(r.talent_name, r.original_filename);
      if (!k) continue;
      const p = people.get(k) ?? { picked: false, set: null, board: null };
      if (r.picked) p.picked = true;
      if (r.talent_group === 'men' || r.talent_group === 'women' || r.talent_group === 'kids') p.set = r.talent_group;
      p.board ??= groupFromBoard(r.album);
      people.set(k, p);
    }
    const picked = [...people].filter(([k, p]) => p.picked && !place.has(k)).sort(([a], [b]) => a.localeCompare(b));
    for (const [k, p] of picked) {
      const group = p.set ?? p.board;
      let section = link.sections.findIndex((s) => s.from === rid && s.group && s.group === group);
      if (section < 0) section = link.sections.findIndex((s) => s.from === rid && !s.group);
      // No group known and no catch-all section: rather than drop a pick, use the first section following them.
      if (section < 0) section = link.sections.findIndex((s) => s.from === rid);
      if (section < 0) continue;
      place.set(k, { section, order: place.size });
    }
  }
  return { ...link, place };
}

/** The links (by id, within one project) a reviewer's session was opened through — not yet placed. */
export async function curatedLinksById(env: Env, projectId: string, ids: string[]): Promise<CuratedLink[]> {
  if (!ids.length) return [];
  const res = await env.DB.prepare(
    `SELECT id, project_id, title, layout FROM curated_links
      WHERE project_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
  )
    .bind(projectId, ...ids)
    .all<Row>();
  return res.results.flatMap((r) => parse(r) ?? []);
}

/**
 * Is this photo's person on the link? The cheap form of resolve() for the image
 * route, which runs once per thumbnail: a named person, or anyone a followed
 * reviewer has picked (every pick finds a section — see resolve()).
 */
export async function curatedAllows(env: Env, link: CuratedLink, talentName: string | null, filename: string): Promise<boolean> {
  const k = keyOf(talentName, filename);
  if (!k) return false;
  if (link.sections.some((s) => (s.people ?? []).some((p) => p.trim().toLowerCase() === k))) return true;
  for (const rid of new Set(link.sections.map((s) => s.from).filter((r): r is string => !!r))) {
    const res = await env.DB.prepare(
      `SELECT i.talent_name, i.original_filename FROM selections s JOIN images i ON i.id = s.image_id
        WHERE s.reviewer_id = ? AND s.project_id = ?`,
    )
      .bind(rid, link.project_id)
      .all<{ talent_name: string | null; original_filename: string }>();
    if (res.results.some((r) => keyOf(r.talent_name, r.original_filename) === k)) return true;
  }
  return false;
}

export async function curatedByToken(env: Env, token: string) {
  if (!CURATED_TOKEN.test(token)) return null;
  const row = await env.DB.prepare(
    `SELECT c.id, c.project_id, c.title, c.layout,
            p.name AS p_name, p.status AS p_status, p.password_hash, p.password_salt
       FROM curated_links c JOIN projects p ON p.id = c.project_id
      WHERE c.token = ?1 OR c.slug = ?1`,
  )
    .bind(token)
    .first<Row & { p_name: string; p_status: string; password_hash: string | null; password_salt: string | null }>();
  if (!row) return null;
  const link = parse(row);
  if (!link) return null;
  return {
    link: await resolve(env, link),
    project: { id: row.project_id, name: row.p_name, status: row.p_status, password_hash: row.password_hash, password_salt: row.password_salt },
  };
}


export function inCurated(link: CuratedLink, talentName: string | null, filename: string): boolean {
  const k = keyOf(talentName, filename);
  return !!k && link.place.has(k);
}

/** The page's sections, in the gallery's terms: each with the ids of its people's photos, in page order. */
export function curatedSections(
  link: CuratedLink,
  images: Array<{ id: string; talent_name: string | null; original_filename: string }>,
): Array<{ title: string; ids: string[] }> {
  const out = link.sections.map((s) => ({ title: s.title, rows: [] as Array<{ id: string; order: number }> }));
  for (const i of images) {
    const p = link.place.get(keyOf(i.talent_name, i.original_filename) ?? '');
    if (p) out[p.section]!.rows.push({ id: i.id, order: p.order });
  }
  // Stable sort keeps each person's photos in their usual order.
  return out.map((s) => ({ title: s.title, ids: s.rows.sort((a, b) => a.order - b.order).map((r) => r.id) }));
}
