-- Selects: multi-reviewer photo review.
-- Project -> Album -> Image. Selections are a join table, never a flag on the image.

CREATE TABLE projects (
  id            TEXT PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  description   TEXT,
  password_hash TEXT,
  password_salt TEXT,
  preview_edge  INTEGER NOT NULL DEFAULT 2400,
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    INTEGER NOT NULL
);

-- One dropped folder = one album (a look, a setup, a shot).
CREATE TABLE albums (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  password_hash TEXT,   -- Phase 2: per-album client password. Column ships now to avoid a migration.
  password_salt TEXT,
  created_at    INTEGER NOT NULL,
  UNIQUE (project_id, slug)
);
CREATE INDEX idx_albums_project ON albums(project_id, seq);

CREATE TABLE images (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  album_id          TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  original_filename TEXT NOT NULL,   -- preserved byte-exact for export
  base_name         TEXT NOT NULL,   -- filename minus extension, for RAW matching in Capture One
  seq               INTEGER NOT NULL,
  thumb_key         TEXT NOT NULL,
  preview_key       TEXT NOT NULL,
  width             INTEGER NOT NULL,
  height            INTEGER NOT NULL,
  capture_time      INTEGER,
  created_at        INTEGER NOT NULL
);
CREATE INDEX idx_images_album_seq ON images(album_id, seq);
CREATE INDEX idx_images_project   ON images(project_id);

CREATE TABLE reviewers (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  email_norm   TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  UNIQUE (project_id, email_norm)
);

-- Composite PK gives the uniqueness constraint for free and makes toggling
-- idempotent (INSERT OR IGNORE / DELETE), so concurrent hearts never conflict.
CREATE TABLE selections (
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  image_id    TEXT NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  reviewer_id TEXT NOT NULL REFERENCES reviewers(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (reviewer_id, image_id)
);
CREATE INDEX idx_sel_project_reviewer ON selections(project_id, reviewer_id);
CREATE INDEX idx_sel_project_image    ON selections(project_id, image_id);
