import { rawMatch } from '../../shared/names';
import type { Env } from '../types';

interface Options {
  projectId: string;
  reviewerId: string;
  /** Restrict to these albums (a client album link). Null means every album. */
  albumIds: string[] | null;
  /** Owner view: share settings, activity, duplicate flags. */
  admin: boolean;
  /** Only a project-wide session may learn the project link. */
  includeSlug: boolean;
}

/**
 * The single payload every gallery runs on — owner and reviewer alike. Counts are
 * derived here from one pass over the project's selections rather than with a
 * correlated subquery per image, which matters at a few thousand frames.
 */
export async function buildGallery(env: Env, o: Options) {
  const project = await env.DB.prepare(
    `SELECT id, name, slug, preview_edge, cover_image_id, allow_downloads, kind, description,
            password_hash IS NOT NULL AS has_password
       FROM projects WHERE id = ?`,
  )
    .bind(o.projectId)
    .first<{
      id: string; name: string; slug: string; preview_edge: number;
      cover_image_id: string | null; allow_downloads: number; has_password: number;
      kind: string; description: string | null;
    }>();
  if (!project) return null;

  const [albumsRes, imagesRes, selectionsRes, reviewersRes, notesRes] = await Promise.all([
    env.DB.prepare(
      `SELECT id, name, slug, share_token, password_hash IS NOT NULL AS has_password
         FROM albums WHERE project_id = ? ORDER BY seq`,
    )
      .bind(o.projectId)
      .all<{ id: string; name: string; slug: string; share_token: string | null; has_password: number }>(),
    env.DB.prepare(
      `SELECT i.id, i.original_filename, i.thumb_key, i.preview_key, i.width, i.height,
              i.album_id, i.checksum, i.talent_name, i.link, i.info
         FROM images i JOIN albums a ON a.id = i.album_id
        WHERE i.project_id = ?
        ORDER BY a.seq, i.seq`,
    )
      .bind(o.projectId)
      .all<{
        id: string; original_filename: string; thumb_key: string; preview_key: string;
        width: number; height: number; album_id: string; checksum: string | null;
        talent_name: string | null; link: string | null; info: string | null;
      }>(),
    env.DB.prepare(`SELECT reviewer_id, image_id FROM selections WHERE project_id = ?`)
      .bind(o.projectId)
      .all<{ reviewer_id: string; image_id: string }>(),
    env.DB.prepare(
      `SELECT id, display_name, last_seen_at, hidden FROM reviewers WHERE project_id = ? ORDER BY created_at`,
    )
      .bind(o.projectId)
      .all<{ id: string; display_name: string; last_seen_at: number; hidden: number }>(),
    // Top-level notes only: replies don't add a pin.
    env.DB.prepare(
      `SELECT image_id, reviewer_id, resolved_at FROM notes WHERE project_id = ? AND parent_id IS NULL`,
    )
      .bind(o.projectId)
      .all<{ image_id: string; reviewer_id: string; resolved_at: number | null }>(),
  ]);

  const allowed = o.albumIds ? new Set(o.albumIds) : null;
  const albums = albumsRes.results.filter((a) => !allowed || allowed.has(a.id));
  const albumIndex = new Map(albums.map((a, i) => [a.id, i]));
  const images = imagesRes.results.filter((i) => albumIndex.has(i.album_id));
  const visibleIds = new Set(images.map((i) => i.id));

  // A hidden reviewer is invisible to everyone but the owner and themselves —
  // their picks don't appear in filters, in heart counts, or anywhere else.
  const hiddenFromMe = new Set(
    o.admin ? [] : reviewersRes.results.filter((r) => r.hidden && r.id !== o.reviewerId).map((r) => r.id),
  );

  // Only selections on frames this caller can see count toward anything they see.
  const selectionsByReviewer: Record<string, string[]> = {};
  const selectCount = new Map<string, number>();
  const mine = new Set<string>();
  for (const s of selectionsRes.results) {
    if (!visibleIds.has(s.image_id) || hiddenFromMe.has(s.reviewer_id)) continue;
    (selectionsByReviewer[s.reviewer_id] ??= []).push(s.image_id);
    selectCount.set(s.image_id, (selectCount.get(s.image_id) ?? 0) + 1);
    if (s.reviewer_id === o.reviewerId) mine.add(s.image_id);
  }

  // Notes per frame, under the same visibility rule as selections.
  const noteCount = new Map<string, number>();
  const openNotes = new Map<string, number>();
  for (const n of notesRes.results) {
    if (!visibleIds.has(n.image_id) || hiddenFromMe.has(n.reviewer_id)) continue;
    noteCount.set(n.image_id, (noteCount.get(n.image_id) ?? 0) + 1);
    if (!n.resolved_at) openNotes.set(n.image_id, (openNotes.get(n.image_id) ?? 0) + 1);
  }

  // Possible duplicates: two frames that would resolve to the same RAW, or the
  // same file uploaded twice. Computed across the whole project for the owner.
  const dup = new Set<string>();
  if (o.admin) {
    const byRaw = new Map<string, string[]>();
    const bySum = new Map<string, string[]>();
    for (const img of imagesRes.results) {
      const r = rawMatch(img.original_filename).toLowerCase();
      (byRaw.get(r) ?? byRaw.set(r, []).get(r)!).push(img.id);
      if (img.checksum) (bySum.get(img.checksum) ?? bySum.set(img.checksum, []).get(img.checksum)!).push(img.id);
    }
    for (const group of [...byRaw.values(), ...bySum.values()]) {
      if (group.length > 1) group.forEach((id) => dup.add(id));
    }
  }

  const me = reviewersRes.results.find((r) => r.id === o.reviewerId);

  return {
    project: {
      id: project.id,
      name: project.name,
      slug: o.includeSlug ? project.slug : null,
      previewEdge: project.preview_edge,
      allowDownloads: project.allow_downloads === 1,
      kind: project.kind === 'casting' ? 'casting' : 'shoot',
      // The description doubles as a casting brief; shoots don't show it.
      brief: project.kind === 'casting' ? project.description : null,
      ...(o.admin ? { hasPassword: project.has_password === 1, coverImageId: project.cover_image_id } : {}),
    },
    reviewerId: o.reviewerId,
    me: { id: o.reviewerId, name: me?.display_name ?? '' },
    albums: albums.map((a) => ({
      id: a.id,
      name: a.name,
      slug: a.slug,
      ...(o.admin ? { shareToken: a.share_token, hasPassword: a.has_password === 1 } : {}),
    })),
    reviewers: reviewersRes.results
      .filter((r) => !hiddenFromMe.has(r.id))
      .map((r) => ({
        id: r.id,
        name: r.display_name,
        isMe: r.id === o.reviewerId,
        count: selectionsByReviewer[r.id]?.length ?? 0,
        ...(o.admin ? { lastSeen: r.last_seen_at, hidden: r.hidden === 1 } : {}),
      }))
      .filter((r) => r.isMe || r.count > 0 || o.admin),
    selectionsByReviewer,
    fields: ['id', 'filename', 'thumb', 'preview', 'w', 'h', 'album', 'selects', 'mine', 'dup', 'name', 'link', 'info', 'notes', 'notesOpen'],
    rows: images.map((i) => [
      i.id,
      i.original_filename,
      i.thumb_key,
      i.preview_key,
      i.width,
      i.height,
      albumIndex.get(i.album_id)!,
      selectCount.get(i.id) ?? 0,
      mine.has(i.id) ? 1 : 0,
      dup.has(i.id) ? 1 : 0,
      i.talent_name,
      i.link,
      i.info,
      noteCount.get(i.id) ?? 0,
      openNotes.get(i.id) ?? 0,
    ]),
  };
}
