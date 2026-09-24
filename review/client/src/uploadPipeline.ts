import type { ResizeRequest, ResizeResult } from './resize.worker';

/**
 * One photo to upload. Bytes are fetched on demand via `load`, not held up front:
 * a folder pick already works this way, and a ZIP entry has to — expanding a 3 GB
 * archive into memory before the first resize would take the tab down.
 */
export interface UploadFile {
  name: string;
  load: () => Promise<ArrayBuffer>;
  /** Folder this file came from, i.e. the album it lands in. */
  folder: string;
}

export interface Progress {
  total: number;
  done: number;
  failed: number;
  skipped: number;
  current: string;
  phase: 'idle' | 'resizing' | 'committing' | 'done';
  /** First few failures, verbatim. A bare count tells you nothing actionable. */
  errors: string[];
}

const THUMB_EDGE = 400;
const COMMIT_BATCH = 100;
const DB_NAME = 'review-uploads';
const STORE = 'completed';

/**
 * Records which (project, album, filename) triples are already safely committed, so
 * closing the tab mid-upload costs only the in-flight files. The server is also
 * idempotent per (album, filename), so this is an optimisation, not the safety net.
 */
async function openDb(): Promise<IDBDatabase | null> {
  // Safari's indexedDB.open can hang forever rather than failing — notably in
  // private browsing and shortly after a page load. Resume is an optimisation
  // (the server is idempotent per album+filename), so it must never be able to
  // block an upload: time it out and carry on without it.
  return Promise.race([
    new Promise<IDBDatabase | null>((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    }),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
  ]);
}

async function idbGetAll(db: IDBDatabase | null): Promise<Set<string>> {
  if (!db) return new Set();
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAllKeys();
      req.onsuccess = () => resolve(new Set(req.result.map(String)));
      req.onerror = () => resolve(new Set());
    } catch {
      resolve(new Set());
    }
  });
}

async function idbPut(db: IDBDatabase | null, key: string): Promise<void> {
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(1, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', ...init });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function putBlob(blob: Blob): Promise<string> {
  if (!blob.type) throw new Error('encoder returned a blob with no type');
  const res = await fetch('/api/admin/blob', {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'content-type': blob.type },
    body: blob,
  });
  if (!res.ok) {
    throw new Error(`upload ${res.status}: ${(await res.text()).slice(0, 160)} (sent ${blob.type})`);
  }
  return ((await res.json()) as { key: string }).key;
}

/** Retry transient network failures; a flaky hotel wifi shouldn't cost the whole shoot. */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 400 * 2 ** i));
    }
  }
  throw lastErr;
}

export async function uploadFiles(
  projectId: string,
  files: UploadFile[],
  previewEdge: number,
  onProgress: (p: Progress) => void,
): Promise<Progress> {
  const db = await openDb();
  const alreadyDone = await idbGetAll(db);

  // Resolve each distinct folder to an album up front. The endpoint is idempotent,
  // so re-dropping a folder maps to the same album rather than making a second one.
  const folders = [...new Set(files.map((f) => f.folder))];
  const albumIds = new Map<string, string>();
  for (const folder of folders) {
    const { album } = await api<{ album: { id: string } }>(
      `/api/admin/projects/${projectId}/albums`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: folder }),
      },
    );
    albumIds.set(folder, album.id);
  }

  const pending = files.filter(
    (f) => !alreadyDone.has(`${projectId}:${albumIds.get(f.folder)}:${f.name}`),
  );

  const progress: Progress = {
    total: files.length,
    done: 0,
    failed: 0,
    skipped: files.length - pending.length,
    current: '',
    phase: 'resizing',
    errors: [],
  };
  onProgress({ ...progress });

  const poolSize = Math.max(2, Math.min(navigator.hardwareConcurrency || 4, 8));
  const workers = Array.from({ length: poolSize }, () =>
    new Worker(new URL('./resize.worker.ts', import.meta.url), { type: 'module' }),
  );

  const queue = [...pending];
  const commitBuffer: Array<Record<string, unknown>> = [];

  async function flush(force = false): Promise<void> {
    if (commitBuffer.length === 0) return;
    if (!force && commitBuffer.length < COMMIT_BATCH) return;
    const batch = commitBuffer.splice(0, commitBuffer.length);
    await withRetry(() =>
      api(`/api/admin/projects/${projectId}/images`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ images: batch }),
      }),
    );
    for (const img of batch) {
      await idbPut(db, `${projectId}:${img.albumId}:${img.filename}`);
    }
  }

  async function runWorker(worker: Worker): Promise<void> {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      const albumId = albumIds.get(item.folder)!;
      progress.current = item.name;

      try {
        const buffer = await item.load();
        const result = await new Promise<ResizeResult>((resolve, reject) => {
          const onMessage = (e: MessageEvent<ResizeResult>) => {
            worker.removeEventListener('message', onMessage);
            e.data.error ? reject(new Error(e.data.error)) : resolve(e.data);
          };
          worker.addEventListener('message', onMessage);
          const req: ResizeRequest = {
            id: item.name,
            filename: item.name,
            buffer,
            thumbEdge: THUMB_EDGE,
            previewEdge,
          };
          worker.postMessage(req, [buffer]);
        });

        const [thumbKey, previewKey] = await Promise.all([
          withRetry(() => putBlob(result.thumb)),
          withRetry(() => putBlob(result.preview)),
        ]);

        commitBuffer.push({
          albumId,
          filename: result.filename,
          thumbKey,
          previewKey,
          width: result.width,
          height: result.height,
          captureTime: result.captureTime,
          checksum: result.checksum,
        });
        progress.done++;
        await flush();
      } catch (err) {
        progress.failed++;
        const message = `${item.name}: ${(err as Error).message}`;
        if (progress.errors.length < 5) progress.errors.push(message);
        console.error('[upload]', message, err);
      }
      onProgress({ ...progress });
    }
  }

  await Promise.all(workers.map(runWorker));
  progress.phase = 'committing';
  onProgress({ ...progress });
  await flush(true);

  workers.forEach((w) => w.terminate());
  db?.close();

  progress.phase = 'done';
  progress.current = '';
  onProgress({ ...progress });
  return progress;
}
