import { talentGroupName } from '../../shared/names';
import type { Env } from '../types';

export interface VideoOut { id: string; name: string; src: string; poster: string | null; w: number; h: number; duration: number | null }

/**
 * A project's casting videos of the people this page shows (by grouping key),
 * so a client never learns of a clip of someone outside their link.
 * `q` rides on each address, as view-only links do for photos.
 */
export async function videosFor(env: Env, projectId: string, people: Set<string>, q = ''): Promise<VideoOut[]> {
  const res = await env.DB.prepare(
    `SELECT id, talent_name, key, poster_key, width, height, duration FROM videos WHERE project_id = ? ORDER BY created_at`,
  )
    .bind(projectId)
    .all<{ id: string; talent_name: string; key: string; poster_key: string | null; width: number; height: number; duration: number | null }>()
    .catch(() => ({ results: [] as never[] })); // before the migration: no videos
  return res.results
    .filter((v) => people.has(talentGroupName(v.talent_name, '') ?? ''))
    .map((v) => ({
      id: v.id, name: v.talent_name, src: v.key + q, poster: v.poster_key ? v.poster_key + q : null,
      w: v.width, h: v.height, duration: v.duration,
    }));
}
