-- Casting videos: a clip of one person (by talent name), shown below their photos.
-- Served through /i/<key> like photos, with the same access rules as that person's photos.
CREATE TABLE videos (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  talent_name       TEXT NOT NULL,
  key               TEXT NOT NULL UNIQUE,
  poster_key        TEXT,
  width             INTEGER NOT NULL,
  height            INTEGER NOT NULL,
  duration          REAL,
  original_filename TEXT NOT NULL,
  created_at        INTEGER NOT NULL
);
CREATE INDEX idx_videos_project ON videos(project_id);
CREATE INDEX idx_videos_poster ON videos(poster_key);
