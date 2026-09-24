# Selects — Architecture & MVP Plan

Multi-reviewer photo selects app. Hidden at `review.ultra-tropic.com`.

Decisions locked with Tiger (2026-09-23): `review.ultra-tropic.com` · previews only, no originals
uploaded · 2400 px previews · single admin password · Cloudflare-native stack · Workers free tier
to start · folder-per-album structure · per-album passwords in Phase 2.

**Status (2026-09-24):** Phase 1 and Phase 2 are built and live — export, image/album delete,
client album links with passwords, drag & drop + ZIP upload, duplicate detection, stats.
Phase 3 (the Capture One bridge in §1) is on hold. Sections below are the original design
record; where they say "not yet", check the code.

---

## 1. Capture One integration — findings

**Verified directly against the scripting dictionary of the Capture One installed on this Mac**
(`sdef "/Applications/Capture One.app"`), not from blog posts.

### What is actually possible

| Capability | Status | Evidence |
|---|---|---|
| Set a variant's star rating | ✅ writable | `variant.rating : integer` (no `access="r"`) |
| Set a variant's color tag | ✅ writable | `variant.color tag : integer` |
| Set pick flag | ✅ writable | `variant.pick : boolean` |
| Read a variant's filename | ✅ | `variant.name` = "the name of the parent image" (read-only) |
| Read full path / extension / EXIF capture date | ✅ | `image.path`, `image.extension`, `image.EXIF capture date` |
| Create an album | ✅ | `make new collection` + `collectionType` includes `album`, `smart album`, `project` |
| **Add specific variants to an album** | ✅ | `add inside` — *"Add one or more variants to an album collection"* |
| Select variants programmatically | ✅ | `select` command (`variant.selected` itself is read-only) |
| Apply keywords | ✅ | `apply keyword ... to <list of variants>` |
| Works on Sessions **and** Catalogs | ✅ | `document.kind` enum = `session` \| `catalog` |
| JXA (JavaScript) instead of AppleScript | ✅ | officially supported alongside AppleScript |

**There is no REST/HTTP API and no CLI.** AppleScript/JXA is the only official automation
surface, and it is macOS-local. So a browser cannot talk to Capture One directly — confirmed,
as the brief suspected. The bridge has to be a local script the photographer runs.

**Capture One Live's multi-reviewer flaw is real and officially documented.** Capture One's own
FAQ states reviewers' ratings and color tags *overwrite each other*. That is precisely the
problem this app exists to solve, and it validates the per-reviewer selection model.

### The bridge design (Phase 3, but the export format is designed for it now)

Because `add inside` can push an arbitrary variant list into an album, the bridge does **not**
have to overwrite anyone's metadata:

- **One album per reviewer** — `Selects — Alice`, `Selects — Bob`. Zero metadata collisions.
  This is the primary mechanism and it is strictly better than what Capture One Live does.
- **`rating` = consensus count** — number of reviewers who picked the image, capped at 5.
  Sort by rating in Capture One and the most-agreed-on frames rise to the top.
- **`color tag` = reviewer index** — optional, useful when you only care about one person.

Matching is on `variant.name` (= parent image name), compared base-name-only and
case-insensitively, so `IMG_4837.JPG` (web) matches `IMG_4837.CR3` (RAW). This is why the export
carries a `base_name` column.

The script is a single `.scpt`/`.jxa` file: pick a CSV, it operates on the frontmost document's
current collection. No installer, no app bundle, no notarization. **Not in the MVP.**

---

## 2. Architecture

```
review.ultra-tropic.com
        │
   Cloudflare Worker  (Hono + TypeScript)
        ├── D1      — SQLite: projects, albums, images, reviewers, selections
        ├── R2      — thumb + preview WebP only (no originals)
        └── Secrets — ADMIN_PASSWORD, COOKIE_SECRET
```

Entirely separate Worker from the Astro portfolio. The existing `ultratropic` Pages project and
`wrangler.toml` are not touched, so a bad deploy here cannot take down ultra-tropic.com.

**Why Cloudflare over Next.js/Supabase/Vercel:** R2 has zero egress fees, which matters when the
whole product is shipping images; it's the account and domain already in use; and at this volume
it is free or $5/mo. Postgres buys nothing here — the data model is four small tables.

### Image pipeline — browser-side, no server processing

Sharp doesn't run in Workers, and it doesn't need to. The admin's browser does the work:

1. `createImageBitmap(file, { imageOrientation: 'from-image' })` — decodes and applies EXIF rotation
2. Draw to `OffscreenCanvas`, encode WebP via `convertToBlob`
3. Pool of Web Workers sized to `navigator.hardwareConcurrency`
4. `PUT` each blob straight to R2 via a presigned URL — never through the Worker

| Derivative | Long edge | Quality | Typical size |
|---|---|---|---|
| `thumb` | 400 px | 0.70 | ~25 KB |
| `preview` | 2400 px | 0.72 | ~300 KB |

**≈325 KB per image.** A 1,000-frame shoot is ~325 MB instead of ~20 GB — roughly 30 shoots inside
R2's free 10 GB, and archived projects can be purged to reclaim space. Originals and RAWs never
leave the Mac, which is where Capture One needs them anyway. Preview long edge is a per-project
setting, so a future shoot can be dialled down without touching code.

2400 px costs nothing in request count or bandwidth billing (R2 egress is free) — only storage.

### Serving images

Bucket stays private. The Worker proxies with a session-cookie check and
`Cache-Control: private, max-age=31536000, immutable` plus the Workers Cache API, so a revisit
costs ~zero requests. Storage keys are 32-char random, so they're unguessable even if a URL leaks.

### Gallery data loading — manifest, not pagination

The gallery needs a *list* of what exists: image id, filename, dimensions, and who selected what.
That's text, not pixels. Two ways to get it:

- **Paginated** — ask the server for 200 rows at a time as you scroll. Standard, but every filter
  change ("show me Alice's selects") is a fresh round trip, and fast scrolling hits empty gaps.
- **Manifest** (chosen) — fetch the whole list once when the album opens. 5,000 rows ≈ 400 KB of
  JSON, ~60 KB gzipped: less than one thumbnail. After that, filtering, counting and jumping to
  the end are all local and instant, with no spinners.

**This is only the list.** The actual JPEGs still load lazily — the grid is virtualized, so only
thumbnails near the viewport are ever requested.

Because images are scoped to an album, each manifest covers one album rather than a whole shoot,
which keeps it small even on a very large job. Above ~10,000 images in a single album we'd fall
back to cursor pagination, but a single album that size is unlikely.

---

## 3. Schema (D1 / SQLite)

```sql
CREATE TABLE projects (
  id            TEXT PRIMARY KEY,        -- ULID
  slug          TEXT NOT NULL UNIQUE,    -- 10-char base62, the /p/<slug> URL
  name          TEXT NOT NULL,
  description   TEXT,
  password_hash TEXT,                    -- NULL = no password; PBKDF2 via WebCrypto
  password_salt TEXT,
  preview_edge  INTEGER NOT NULL DEFAULT 1600,
  status        TEXT NOT NULL DEFAULT 'active',   -- active | archived
  created_at    INTEGER NOT NULL
);

-- A project is a job ("Mackage FW26"). An album is one folder you dropped in —
-- a look, a setup, a shot. Every image belongs to exactly one album.
CREATE TABLE albums (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,           -- taken from the dropped folder's name
  slug          TEXT NOT NULL,           -- /p/<project>/a/<slug>
  seq           INTEGER NOT NULL,        -- display order, admin-reorderable
  password_hash TEXT,                    -- Phase 2: per-album client password
  password_salt TEXT,
  created_at    INTEGER NOT NULL,
  UNIQUE (project_id, slug)
);
CREATE INDEX idx_albums_project ON albums(project_id, seq);

CREATE TABLE images (
  id                TEXT PRIMARY KEY,    -- ULID. NEVER the filename.
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  album_id          TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  original_filename TEXT NOT NULL,       -- preserved byte-exact for export
  base_name         TEXT NOT NULL,       -- filename minus extension, for RAW matching
  seq               INTEGER NOT NULL,    -- order within the album: capture_time, then filename
  thumb_key         TEXT NOT NULL,
  preview_key       TEXT NOT NULL,
  width             INTEGER NOT NULL,    -- of the preview
  height            INTEGER NOT NULL,
  capture_time      INTEGER,             -- from EXIF, nullable
  created_at        INTEGER NOT NULL
);
CREATE INDEX idx_images_album_seq ON images(album_id, seq);
CREATE INDEX idx_images_project    ON images(project_id);

CREATE TABLE reviewers (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  email_norm   TEXT NOT NULL,            -- trim + lowercase + NFC
  display_name TEXT NOT NULL,            -- first name entered wins; later ones ignored
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  UNIQUE (project_id, email_norm)
);

CREATE TABLE selections (
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  image_id    TEXT NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  reviewer_id TEXT NOT NULL REFERENCES reviewers(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (reviewer_id, image_id)
);
CREATE INDEX idx_sel_project_reviewer ON selections(project_id, reviewer_id);
CREATE INDEX idx_sel_project_image    ON selections(project_id, image_id);
```

Notes:
- **No `selected` boolean on `images`.** Selection is purely the join table, as the brief requires.
- `PRIMARY KEY (reviewer_id, image_id)` gives the uniqueness constraint for free and makes
  favourite/unfavourite an idempotent `INSERT OR IGNORE` / `DELETE` — concurrency-safe with no
  transaction, so Alice and Bob clicking the same frame simultaneously both persist.
- Reviewer identity is the normalized email, scoped to the project. Same email returning restores
  their selects. Display name is set once so a later typo can't rename them mid-shoot.
- No admin table — one signed, HttpOnly cookie derived from `ADMIN_PASSWORD`.
- Room for `checksum`, `raw_filename`, `exif` later without migration pain.
- `albums.password_hash` ships **now, unused**, so Phase 2 needs no migration.

### Album access model (columns now, UI in Phase 2)

- `/p/<project>` — the internal link. Shows every album; used by you and the core team.
- `/p/<project>/a/<album>` — the client link. Scoped to one album, with its own optional password.
  A client holding this link cannot see that other albums exist, and cannot walk up to the project.
- Identity is still **one name/email per project**. A reviewer who unlocks a second album isn't
  asked again, and their selects stay under one reviewer row across albums.
- The signed reviewer cookie carries the set of unlocked album ids, so unlocking is per-album but
  identifying is once.

Selections point at images, so reviewer filters and counts work unchanged inside a single album or
across the whole project — and export can be scoped either way. That maps cleanly onto the Capture
One bridge: album + reviewer becomes `Selects — Look 03 — Alice`.

---

## 4. MVP scope (Phase 1)

Built and verified in this order:

1. Worker + D1 + R2 scaffold, deployed to the subdomain, schema migrated
2. Admin password login, signed cookie
3. Create project → get shareable `/p/<slug>` URL
4. Folder-drop upload: each dropped folder becomes an album, browser resize → presigned PUT →
   commit to D1, with live per-folder progress. Loose files land in a default album.
5. Reviewer gate: project password (if set) → name + email → album index
6. Album index: cover thumb, name, image count, that reviewer's select count. Skipped automatically
   when a project has only one album, so the simple case stays one click
7. Virtualized grid, large thumbs, heart button, optimistic toggle with rollback on failure
8. Fullscreen viewer: ←/→ navigate, `F`/`Space` favourite, `Esc` close, next 3 images prefetched
9. Filters: All · My Selects · Everyone's Selects · each reviewer, with live counts
10. Admin gallery: same filters plus a per-image select count for spotting consensus
11. Dashboard: projects list with album/image/reviewer/select counts
12. Export: TXT (filenames) and CSV (`filename, base_name, album, selected_by, select_count,
    capture_time`), scopable to one album or the whole project

**Done = the central product test passes:** 3–5 people open a link to 1,000 photos, enter
name/email, click through quickly, and you export exactly what each person picked — no accounts.

---

## 5. Technical risks

1. **Workers free tier is 100k requests/day** — staying free for now, by decision. Proxying
   thumbnails costs ~1 request per image per cold viewer, so a 1,000-image shoot × 5 reviewers is
   ~5k on the first pass. Comfortable. *Mitigation:* immutable caching makes revisits ~free, and
   splitting shoots into albums means a reviewer only loads the album they open. Upgrade trigger:
   if a project tops ~15k images or a review day ever 429s, Workers Paid is $5/mo for 10M.
2. **Upload is tied to one browser tab staying open.** 1,000 images on the M1 Max is roughly
   1–2 minutes of encoding, but a closed laptop mid-run loses progress. *Mitigation:* persist the
   manifest in IndexedDB and skip already-uploaded files on retry, so a resume is idempotent and
   950 good uploads are never lost to 50 failures.
3. **No originals means no going back.** If 2400 px later proves too small, the only remedy is
   re-uploading from the Mac. 2400 is a deliberately safe choice — it's sharp at fullscreen on a
   5K display — at a cost of ~30 shoots per free 10 GB rather than ~55.

4. **D1 writes are single-region.** Reviewers far from the primary see ~150 ms write latency.
   Harmless because selection updates are optimistic — the heart fills instantly.
5. **Duplicate filenames across camera bodies** (`IMG_0001.JPG` from two cameras). *Mitigation:*
   detect at upload commit, warn the admin, and disambiguate in the export so the bridge can't
   silently tag the wrong RAW.
6. **Link + password is the whole security model.** Anyone with both sees the shoot. Appropriate
   for client review; worth saying out loud since it's private client work.
7. **WebP encoding is browser-dependent.** Chrome/Safari/Firefox all support it; a wrong EXIF
   orientation would rotate frames. Verified explicitly with portrait-orientation test files.

8. **R2 free tier is 10 GB.** At 2400 px that's roughly 30 shoots of 1,000 frames. *Mitigation:*
   archiving or deleting a finished project frees the space immediately; beyond the free tier R2
   is $0.015/GB/mo, so even 100 GB would be $1.50/mo.

---

## 6. Explicitly NOT building yet

Per the brief's "no features just because photo software has them":

- The macOS Capture One bridge — Phase 3, but the CSV carries `base_name` so it's ready
- **Per-album client passwords — Phase 2.** The `albums.password_hash` columns and the scoped
  `/p/<project>/a/<album>` route ship in the MVP; only the unlock UI and the admin control are
  deferred, so no migration or re-architecture is needed later
- Album reordering, moving images between albums, merging albums
- Comments, notes, star ratings, color tags, approve/reject states
- Reviewer accounts, OAuth, email verification, invite links, notification emails
- Real-time/WebSocket sync between reviewers
- RAW or video support, ZIP upload, originals archiving
- Multiple admins, roles, teams, billing
- AI culling, auto-tagging, face detection, any proprietary ranking score
- Mobile app — the web gallery is responsive and that is enough
