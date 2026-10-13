import { stripExt } from '../../shared/names';

export interface SplitOption {
  /** Token position within the filename, or -1 for "don't split". */
  index: number;
  label: string;
  groups: Array<{ value: string; count: number }>;
}


/**
 * Find filename segments that look like shoot groupings.
 *
 * Shoot exports are almost always <date>_<client>_<setup>_<frame>. The setup
 * segment repeats across many files; the frame segment is unique to each. So a
 * candidate is any segment that has more than one distinct value but far fewer
 * than one per file. Splitting on `_` and `-` only — not whitespace — keeps
 * macOS duplicate suffixes like "051 1" attached to their frame number.
 */
export function detectSplits(filenames: string[], folders: string[] = []): SplitOption[] {
  const folderCount = new Set(folders).size;
  const none: SplitOption = {
    index: -1,
    // "One album" next to twelve dropped folders reads as "merge them all".
    label: folderCount > 1 ? `Keep the ${folderCount} folders as albums` : 'One album',
    groups: [{ value: 'all', count: filenames.length }],
  };
  if (filenames.length < 4) return [none];

  const tokenized = filenames.map((n) => stripExt(n).split(/[_-]/));
  const folderOf = new Map(tokenized.map((t, i) => [t, folders[i] ?? '']));
  const counts = new Map<number, number>();
  for (const t of tokenized) counts.set(t.length, (counts.get(t.length) ?? 0) + 1);
  const [modalLength] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;
  const conforming = tokenized.filter((t) => t.length === modalLength);
  if (conforming.length < filenames.length * 0.8) return [none];

  const options: SplitOption[] = [];
  for (let i = 0; i < modalLength; i++) {
    const tally = new Map<string, number>();
    for (const t of conforming) {
      const v = t[i]!;
      tally.set(v, (tally.get(v) ?? 0) + 1);
    }
    const distinct = tally.size;
    // Constant segment (client name, date) or a per-frame unique one: neither groups.
    if (distinct < 2 || distinct > Math.min(60, conforming.length / 2)) continue;

    // The folders already separate this segment (each folder holds one value):
    // splitting on it would only rename "01" to "01 01".
    const perFolder = new Map<string, Set<string>>();
    for (const t of conforming) {
      const f = folderOf.get(t)!;
      (perFolder.get(f) ?? perFolder.set(f, new Set()).get(f)!).add(t[i]!);
    }
    const albums = [...perFolder.values()].reduce((n, v) => n + v.size, 0);
    if (folderCount > 1 && albums === perFolder.size) continue;

    const groups = [...tally.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => a.value.localeCompare(b.value, undefined, { numeric: true }));

    options.push({
      index: i,
      label:
        folderCount > 1
          ? `Split each folder further · ${albums} albums`
          : `${distinct} albums · ${groups.slice(0, 4).map((g) => g.value).join(', ')}${distinct > 4 ? '…' : ''}`,
      groups,
    });
  }

  // Prefer the segment closest to the frame number: that is the setup, not the date.
  options.sort((a, b) => b.index - a.index);
  return [none, ...options];
}

/** Album name for one file under a chosen split. Non-conforming files fall back. */
export function albumFor(filename: string, folder: string, splitIndex: number): string {
  if (splitIndex < 0) return folder;
  const tokens = stripExt(filename).split(/[_-]/);
  const value = tokens[splitIndex];
  return value ? `${folder} ${value}` : `${folder} unsorted`;
}
