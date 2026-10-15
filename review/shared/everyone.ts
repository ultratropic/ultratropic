/**
 * "Everyone": frames every active reviewer selected. Shared by the gallery and
 * the export so both agree on who counts and which frames qualify.
 *
 * Someone who signed in and picked nothing, or barely anything, would otherwise
 * empty the view, so a reviewer only counts once they've selected at least
 * ACTIVE_SHARE of the photos.
 */
export const ACTIVE_SHARE = 0.05;

/** Fewer active reviewers than this and "everyone" means nothing yet. */
export const MIN_ACTIVE = 2;

export function activeReviewers(picksByReviewer: Record<string, readonly string[]>, totalImages: number): string[] {
  const needed = Math.max(1, ACTIVE_SHARE * totalImages);
  return Object.entries(picksByReviewer)
    .filter(([, picks]) => picks.length >= needed)
    .map(([id]) => id);
}

/** Frames every active reviewer selected; empty while there are fewer than MIN_ACTIVE of them. */
export function selectedByEveryone(
  picksByReviewer: Record<string, readonly string[]>,
  totalImages: number,
): { ids: Set<string>; active: string[] } {
  const active = activeReviewers(picksByReviewer, totalImages);
  if (active.length < MIN_ACTIVE) return { ids: new Set(), active };
  const [first, ...rest] = active.map((id) => new Set(picksByReviewer[id]));
  const ids = new Set([...first!].filter((img) => rest.every((s) => s.has(img))));
  return { ids, active };
}
