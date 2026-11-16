import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import Grid, { type Img } from './Grid';
import Viewer from './Viewer';
import Logo from './Logo';

type TalentGroup = 'men' | 'women' | 'kids';
const GROUPS: Array<{ key: TalentGroup; label: string }> = [
  { key: 'men', label: 'Men' }, { key: 'women', label: 'Women' }, { key: 'kids', label: 'Kids' },
];

interface ViewImg extends Img {
  board: string;
  person?: string;
  group?: TalentGroup | null;
}

interface Payload {
  project: { name: string; kind: 'casting' | 'shoot' };
  title: string;
  images: ViewImg[];
}

/** "Wilhelmina — Men" → "Wilhelmina". */
const agencyLabel = (board: string) => board.split(/\s+[—–-]\s+/)[0]?.trim() || board;

/**
 * /v/<token>: what a client is sent to look at — one person's selects, or
 * everyone's. Read-only: no sidebar, no hearts, no notes, no downloads. A
 * casting shows one tile per person, A to Z; opening a person steps through
 * all of their photos, then on to the next person.
 */
export default function ViewOnly({ token }: { token: string }) {
  const [data, setData] = useState<Payload | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [who, setWho] = useState<'all' | TalentGroup>('all');
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    api<Payload>(`/api/v/${token}`)
      .then((d) => {
        setData(d);
        document.title = `${d.title} · ${d.project.name}`;
      })
      .catch(() => setNotFound(true));
  }, [token]);

  const casting = data?.project.kind === 'casting';

  /** Casting: each person's photos, people A to Z. */
  const people = useMemo(() => {
    if (!data || !casting) return [];
    const m = new Map<string, ViewImg[]>();
    for (const img of data.images) {
      const k = img.person ?? img.id;
      (m.get(k) ?? m.set(k, []).get(k)!).push(img);
    }
    return [...m.values()].sort((a, b) =>
      (a[0]!.name ?? '').localeCompare(b[0]!.name ?? '', undefined, { sensitivity: 'base' }));
  }, [data, casting]);

  const shownPeople = who === 'all' ? people : people.filter((p) => p[0]!.group === who);
  const groupCount = (g: TalentGroup) => people.filter((p) => p[0]!.group === g).length;
  const groupsPresent = GROUPS.filter((g) => groupCount(g.key) > 0);

  // What the grid shows (one tile per person in a casting) and what full screen steps through.
  const tiles: ViewImg[] = casting
    ? shownPeople.map((p) => ({ ...p[0]!, count: p.length > 1 ? p.length : undefined }))
    : data?.images ?? [];
  const viewerList: ViewImg[] = casting ? shownPeople.flat() : data?.images ?? [];
  const startOf = useMemo(() => {
    const m = new Map<string, number>();
    let i = 0;
    for (const p of shownPeople) { m.set(p[0]!.id, i); i += p.length; }
    return m;
  }, [shownPeople]);

  if (notFound) {
    return (
      <div className="wrap" style={{ maxWidth: 380 }}>
        <Logo width={150} style={{ marginBottom: 44 }} />
        <h1>Not found</h1>
        <p className="sub">This link is no longer active.</p>
      </div>
    );
  }
  if (!data) return null;

  const boardsOf = (img: ViewImg) => {
    const p = people.find((x) => x[0]!.person === img.person);
    return [...new Set((p ?? [img]).map((m) => agencyLabel(m.board)))].filter(Boolean).join(', ');
  };
  const count = casting ? shownPeople.length : tiles.length;
  const unit = casting ? (count === 1 ? 'person' : 'people') : count === 1 ? 'photo' : 'photos';

  return (
    <div className="view-only gallery no-save">
      <main className="main">
        <header className="view-head">
          <Logo width={110} />
          <div>
            <h1>{data.title}</h1>
            <p className="meta">{data.project.name}</p>
          </div>
        </header>

        {casting && groupsPresent.length > 1 && (
          <div className="who-row" role="group" aria-label="Men, women or kids">
            {([{ key: 'all' as const, label: 'All' }, ...groupsPresent]).map((g) => (
              <button key={g.key} className={`who-pill${who === g.key ? ' on' : ''}`}
                aria-pressed={who === g.key} onClick={() => setWho(g.key)}>
                {g.label}
                <span className="who-n">{g.key === 'all' ? people.length : groupCount(g.key)}</span>
              </button>
            ))}
          </div>
        )}

        <section>
          <header className="section-head">
            <h3>{who === 'all' ? (casting ? 'Everyone' : 'Photos') : GROUPS.find((g) => g.key === who)!.label}</h3>
            <span className="meta">{count} {unit}</span>
          </header>
          {tiles.length === 0 ? (
            <p className="meta">Nothing selected yet.</p>
          ) : (
            <Grid
              images={tiles}
              onOpen={(i) => {
                const img = tiles[i];
                if (!img) return;
                setOpen(casting ? startOf.get(img.id) ?? 0 : i);
              }}
              caption={casting ? (img) => ({
                title: img.name ?? img.filename,
                tag: boardsOf(img as ViewImg) || null,
                sub: img.info,
              }) : undefined}
            />
          )}
        </section>
      </main>

      {open !== null && viewerList[open] && (
        <Viewer
          images={viewerList}
          index={open}
          onIndex={setOpen}
          onClose={() => setOpen(null)}
          albumName={viewerList[open]!.board}
          talent={casting ? (img) => {
            const v = img as ViewImg;
            const members = people.find((p) => p[0]!.person === v.person) ?? [v];
            const at = members.findIndex((m) => m.id === v.id);
            return {
              name: v.name ?? v.filename, link: v.link, info: v.info,
              of: members.length > 1 ? `photo ${at + 1} of ${members.length}` : null,
            };
          } : undefined}
        />
      )}
    </div>
  );
}
