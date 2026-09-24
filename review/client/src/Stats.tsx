interface Album { id: string; name: string }
interface Reviewer { id: string; name: string; isMe: boolean; count: number; lastSeen?: number }
interface Img { id: string; album: number; selects: number }

function ago(ms?: number): string {
  if (!ms) return '—';
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 2) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * Plain counts, no score. "All" means every person who has selected anything —
 * someone who opened the link and picked nothing isn't holding out a consensus.
 */
export default function Stats({
  albums,
  images,
  reviewers,
  selectedBy,
}: {
  albums: Album[];
  images: Img[];
  reviewers: Reviewer[];
  selectedBy: Record<string, string[]>;
}) {
  const active = reviewers.filter((r) => r.count > 0);
  const pickedBy = new Map<string, Set<string>>();
  for (const [rid, ids] of Object.entries(selectedBy)) {
    for (const id of ids) (pickedBy.get(id) ?? pickedBy.set(id, new Set()).get(id)!).add(rid);
  }
  const everyone = (id: string) => active.length > 1 && (pickedBy.get(id)?.size ?? 0) === active.length;

  const rows = albums.map((a, i) => {
    const list = images.filter((img) => img.album === i);
    return {
      name: a.name,
      total: list.length,
      selected: list.filter((x) => x.selects > 0).length,
      twoPlus: list.filter((x) => x.selects >= 2).length,
      all: list.filter((x) => everyone(x.id)).length,
      per: active.map((r) => list.filter((x) => pickedBy.get(x.id)?.has(r.id)).length),
    };
  });
  const sum = (k: 'total' | 'selected' | 'twoPlus' | 'all') => rows.reduce((n, r) => n + r[k], 0);

  return (
    <div style={{ maxWidth: 1000 }}>
      <h3 className="stats-title">Reviewers</h3>
      <table className="table">
        <thead><tr><th>Name</th><th className="num">Selects</th><th className="num">Last active</th></tr></thead>
        <tbody>
          {reviewers.map((r) => (
            <tr key={r.id}>
              <td>{r.name}{r.isMe && <span className="meta"> · you</span>}</td>
              <td className="num">{r.count}</td>
              <td className="num meta">{ago(r.lastSeen)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3 className="stats-title">By album</h3>
      <div style={{ overflowX: 'auto' }}>
        <table className="table">
          <thead>
            <tr>
              <th>Album</th>
              <th className="num">Images</th>
              <th className="num">Selected</th>
              <th className="num" title="Picked by at least two people">2+</th>
              <th className="num" title="Picked by everyone who has selected anything">All {active.length > 1 ? active.length : ''}</th>
              {active.map((r) => <th key={r.id} className="num">{r.name}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name}>
                <td>{r.name}</td>
                <td className="num">{r.total}</td>
                <td className="num">{r.selected || '—'}</td>
                <td className="num">{r.twoPlus || '—'}</td>
                <td className="num">{r.all || '—'}</td>
                {r.per.map((n, i) => <td key={i} className="num">{n || '—'}</td>)}
              </tr>
            ))}
            <tr className="total">
              <td>Total</td>
              <td className="num">{sum('total')}</td>
              <td className="num">{sum('selected')}</td>
              <td className="num">{sum('twoPlus')}</td>
              <td className="num">{sum('all')}</td>
              {active.map((r) => <td key={r.id} className="num">{r.count}</td>)}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
