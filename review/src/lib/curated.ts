import { talentGroupName } from '../../shared/names';
import type { Env } from '../types';

/**
 * Curated links (/c/<token>): a client page of chosen people in titled sections,
 * no sidebar, where anyone with the link can still make their own selects. The
 * people are listed by name in the link, so the page stays as it was laid out
 * whatever anyone hearts or un-hearts. It reaches only those people's photos.
 */
export interface CuratedSection { title: string; people: string[] }
export interface CuratedLink {
  id: string;
  project_id: string;
  title: string | null;
  sections: CuratedSection[];
}

/** A random token, or a readable slug set on the link (lowercase words joined by hyphens). */
export const CURATED_TOKEN = /^(?:[A-Za-z0-9]{24,64}|[a-z0-9]+(?:-[a-z0-9]+)*)$/;

function parse(row: { id: string; project_id: string; title: string | null; layout: string }): CuratedLink | null {
  try {
    const l = JSON.parse(row.layout) as { sections?: unknown };
    if (!Array.isArray(l.sections)) return null;
    const sections = l.sections
      .filter((s): s is CuratedSection => !!s && typeof s.title === 'string' && Array.isArray(s.people))
      .map((s) => ({ title: s.title, people: s.people.filter((p): p is string => typeof p === 'string') }));
    return { id: row.id, project_id: row.project_id, title: row.title, sections };
  } catch {
    return null;
  }
}

/** The links (by id, within one project) a reviewer's session was opened through. */
export async function curatedLinksById(env: Env, projectId: string, ids: string[]): Promise<CuratedLink[]> {
  if (!ids.length) return [];
  const res = await env.DB.prepare(
    `SELECT id, project_id, title, layout FROM curated_links
      WHERE project_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
  )
    .bind(projectId, ...ids)
    .all<{ id: string; project_id: string; title: string | null; layout: string }>();
  return res.results.flatMap((r) => parse(r) ?? []);
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
    .first<{
      id: string; project_id: string; title: string | null; layout: string;
      p_name: string; p_status: string; password_hash: string | null; password_salt: string | null;
    }>();
  if (!row) return null;
  const link = parse(row);
  return link ? { link, project: { id: row.project_id, name: row.p_name, status: row.p_status, password_hash: row.password_hash, password_salt: row.password_salt } } : null;
}

/** Who a photo is of, in the form the link's names are compared in. */
const keyOf = (talentName: string | null, filename: string) => talentGroupName(talentName, filename);

/** Section index of each person on the link, by grouping key. */
function placement(link: CuratedLink): Map<string, { section: number; order: number }> {
  const m = new Map<string, { section: number; order: number }>();
  link.sections.forEach((s, section) => s.people.forEach((name, order) => {
    const k = name.trim().toLowerCase();
    if (k && !m.has(k)) m.set(k, { section, order });
  }));
  return m;
}

export function inCurated(link: CuratedLink, talentName: string | null, filename: string): boolean {
  const k = keyOf(talentName, filename);
  return !!k && placement(link).has(k);
}

/**
 * The page's sections, in the gallery's terms: each with the ids of its people's
 * photos, people in the order the link lists them.
 */
export function curatedSections(
  link: CuratedLink,
  images: Array<{ id: string; talent_name: string | null; original_filename: string }>,
): Array<{ title: string; ids: string[] }> {
  const place = placement(link);
  const out = link.sections.map((s) => ({ title: s.title, rows: [] as Array<{ id: string; order: number }> }));
  for (const i of images) {
    const p = place.get(keyOf(i.talent_name, i.original_filename) ?? '');
    if (p) out[p.section]!.rows.push({ id: i.id, order: p.order });
  }
  // Stable sort keeps each person's photos in their usual order.
  return out.map((s) => ({ title: s.title, ids: s.rows.sort((a, b) => a.order - b.order).map((r) => r.id) }));
}
