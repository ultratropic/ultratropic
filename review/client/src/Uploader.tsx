import { useMemo, useState } from 'react';
import { api } from './api';
import { uploadFiles, type Progress, type UploadFile } from './uploadPipeline';
import { detectSplits, albumFor, type SplitOption } from './split';
import { expandZip } from './zip';
import { isJunk, rawMatch } from '../../shared/names';

const isJpeg = (name: string) => /\.jpe?g$/i.test(name);
const isZip = (name: string) => /\.zip$/i.test(name);

function fromFile(file: File, folder: string): UploadFile {
  return { name: file.name, folder, load: () => file.arrayBuffer() };
}

/** Files from a picker. A folder pick carries each file's path; its parent directory is the album. */
async function fromPicked(list: FileList, fallbackFolder: string): Promise<UploadFile[]> {
  const out: UploadFile[] = [];
  for (const f of [...list]) {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    if (isJunk(rel)) continue;
    if (isZip(f.name)) out.push(...(await expandZip(f)));
    else if (isJpeg(f.name)) {
      const parts = rel.split('/');
      out.push(fromFile(f, parts.length > 1 ? parts[parts.length - 2]! : fallbackFolder));
    }
  }
  return out;
}

function readAllEntries(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  // readEntries returns at most ~100 entries per call; it must be called until it
  // comes back empty, or large folders silently lose most of their files.
  const reader = dir.createReader();
  const all: FileSystemEntry[] = [];
  return new Promise((resolve, reject) => {
    const next = () =>
      reader.readEntries((batch) => {
        if (!batch.length) resolve(all);
        else { all.push(...batch); next(); }
      }, reject);
    next();
  });
}

async function walk(entry: FileSystemEntry, parent: string, out: UploadFile[]): Promise<void> {
  if (entry.isDirectory) {
    for (const child of await readAllEntries(entry as FileSystemDirectoryEntry)) {
      await walk(child, entry.name, out);
    }
    return;
  }
  if (isJunk(entry.fullPath)) return;
  const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
  if (isZip(file.name)) out.push(...(await expandZip(file)));
  else if (isJpeg(file.name)) out.push(fromFile(file, parent));
}

export default function Uploader({
  projectId,
  projectName,
  previewEdge,
  onDone,
}: {
  projectId: string;
  projectName: string;
  previewEdge: number;
  onDone: () => void;
}) {
  const [staged, setStaged] = useState<UploadFile[] | null>(null);
  const [splits, setSplits] = useState<SplitOption[]>([]);
  const [chosen, setChosen] = useState(-1);
  const [existing, setExisting] = useState<Record<string, string>>({});
  const [skipExisting, setSkipExisting] = useState(true);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [over, setOver] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');

  async function stage(files: UploadFile[]) {
    setReading(false);
    if (!files.length) {
      setError('No JPEGs found there.');
      return;
    }
    setError('');
    setStaged(files);
    setSplits(detectSplits(files.map((f) => f.name)));
    setChosen(-1);
    setProgress(null);
    try {
      const res = await api<{ existing: Record<string, string> }>(
        `/api/admin/projects/${projectId}/existing`,
        { method: 'POST', body: JSON.stringify({ names: files.map((f) => f.name) }) },
      );
      setExisting(res.existing);
    } catch {
      setExisting({});
    }
  }

  async function onPick(list: FileList | null) {
    if (!list?.length) return;
    setReading(true);
    try {
      await stage(await fromPicked(list, projectName));
    } catch (err) {
      setReading(false);
      setError((err as Error).message);
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setOver(false);
    // Entries must be taken synchronously: the browser empties the DataTransfer
    // as soon as this handler returns.
    const entries = [...e.dataTransfer.items]
      .filter((i) => i.kind === 'file')
      .map((i) => i.webkitGetAsEntry?.() ?? null);
    const loose = [...e.dataTransfer.files];
    setReading(true);
    void (async () => {
      try {
        const out: UploadFile[] = [];
        if (entries.some(Boolean)) {
          for (const entry of entries) if (entry) await walk(entry, projectName, out);
        } else {
          const dt = new DataTransfer();
          loose.forEach((f) => dt.items.add(f));
          out.push(...(await fromPicked(dt.files, projectName)));
        }
        await stage(out);
      } catch (err) {
        setReading(false);
        setError((err as Error).message);
      }
    })();
  }

  const resolved = useMemo(
    () => (staged ?? []).map((f) => ({ ...f, folder: albumFor(f.name, f.folder, chosen) })),
    [staged, chosen],
  );

  /** Two different files in this batch that would resolve to one RAW in Capture One. */
  const rawCollisions = useMemo(() => {
    const byRaw = new Map<string, string[]>();
    for (const f of resolved) {
      const k = rawMatch(f.name).toLowerCase();
      (byRaw.get(k) ?? byRaw.set(k, []).get(k)!).push(f.name);
    }
    return [...byRaw.values()].filter((g) => g.length > 1);
  }, [resolved]);

  const albumSummary = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of resolved) m.set(f.folder, (m.get(f.folder) ?? 0) + 1);
    return [...m.entries()];
  }, [resolved]);

  const alreadyThere = resolved.filter((f) => existing[f.name]);
  const toUpload = skipExisting ? resolved.filter((f) => !existing[f.name]) : resolved;

  async function begin() {
    setProgress({ total: toUpload.length, done: 0, failed: 0, skipped: 0,
      current: 'starting…', phase: 'resizing', errors: [] });
    try {
      await uploadFiles(projectId, toUpload, previewEdge, setProgress);
      setStaged(null);
    } catch (err) {
      setProgress((p) => ({
        ...(p ?? { total: toUpload.length, done: 0, failed: 0, skipped: 0, current: '', phase: 'done' as const }),
        phase: 'done',
        errors: [`upload could not start: ${(err as Error).message}`],
      }));
    }
    onDone();
  }

  if (progress) {
    const pct = Math.round(((progress.done + progress.failed + progress.skipped) / Math.max(progress.total, 1)) * 100);
    return (
      <div>
        <div className="bar"><div style={{ width: `${pct}%` }} /></div>
        <p className="meta">
          {progress.done} done · {progress.failed} failed · {progress.skipped} already uploaded · {progress.phase}
        </p>
        {progress.current && <p className="mono" style={{ color: 'var(--muted)' }}>{progress.current}</p>}
        {progress.errors.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <label>Why they failed</label>
            {progress.errors.map((e, i) => (
              <p key={i} className="mono err" style={{ margin: '0 0 6px' }}>{e}</p>
            ))}
          </div>
        )}
        {progress.phase === 'done' && (
          <button className="ghost" style={{ marginTop: 16 }} onClick={() => setProgress(null)}>Add more</button>
        )}
      </div>
    );
  }

  if (staged) {
    return (
      <div style={{ borderTop: '1px solid var(--line)', paddingTop: 24, marginTop: 8 }}>
        <p className="sub" style={{ marginBottom: 20 }}>
          {staged.length} images ready · {albumSummary.length} {albumSummary.length === 1 ? 'album' : 'albums'}
        </p>

        {splits.length > 1 && (
          <div className="field">
            <label>Split into albums</label>
            {splits.map((s) => (
              <label key={s.index} className="radio">
                <input type="radio" name="split" checked={chosen === s.index} onChange={() => setChosen(s.index)} />
                <span>{s.label}</span>
              </label>
            ))}
          </div>
        )}

        {alreadyThere.length > 0 && (
          <div className="notice">
            <strong>{alreadyThere.length} already in this project.</strong>{' '}
            Same filenames, e.g. {alreadyThere.slice(0, 2).map((f) => f.name).join(', ')}
            {' '}(in {existing[alreadyThere[0]!.name]}).
            <label className="radio" style={{ marginTop: 10 }}>
              <input type="checkbox" checked={skipExisting} onChange={(e) => setSkipExisting(e.target.checked)} />
              <span>Skip them</span>
            </label>
          </div>
        )}

        {rawCollisions.length > 0 && (
          <div className="notice">
            <strong>{rawCollisions.length} {rawCollisions.length === 1 ? 'frame has' : 'frames have'} more than one JPEG.</strong>{' '}
            These are different files that point at the same RAW in Capture One:
            {rawCollisions.slice(0, 4).map((g) => (
              <div key={g[0]} className="mono" style={{ marginTop: 6 }}>{g.join('  ·  ')}</div>
            ))}
            {rawCollisions.length > 4 && <div className="meta" style={{ marginTop: 6 }}>…and {rawCollisions.length - 4} more</div>}
            <div className="meta" style={{ marginTop: 8 }}>They'll upload as separate images and be flagged in exports.</div>
          </div>
        )}

        <div style={{ marginTop: 20 }}>
          <button onClick={begin} disabled={toUpload.length === 0}>
            Upload {toUpload.length} {toUpload.length === 1 ? 'image' : 'images'}
          </button>{' '}
          <button className="ghost" onClick={() => setStaged(null)}>Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`drop${over ? ' over' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      {reading ? (
        <p style={{ margin: 0 }}>Reading files…</p>
      ) : (
        <>
          <p style={{ margin: '0 0 6px', color: 'var(--fg)' }}>Drop folders or a .zip here</p>
          <p style={{ margin: '0 0 18px' }}>Each folder becomes an album.</p>
          <label className="pick">
            Choose folder
            <input type="file" multiple hidden
              // @ts-expect-error non-standard but supported in every target browser
              webkitdirectory="" directory=""
              onChange={(e) => { void onPick(e.target.files); e.target.value = ''; }} />
          </label>
          <label className="pick">
            Choose files or .zip
            <input type="file" multiple hidden accept=".jpg,.jpeg,.zip,image/jpeg,application/zip"
              onChange={(e) => { void onPick(e.target.files); e.target.value = ''; }} />
          </label>
        </>
      )}
      {error && <p className="err">{error}</p>}
    </div>
  );
}
