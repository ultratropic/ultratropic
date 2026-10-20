-- Retouch notes: a numbered pin on a photo (x, y as fractions of its width and
-- height, so a pin lands on the same spot at any size) or a general note with
-- no position, plus replies. Resolved notes stay, checked off.
CREATE TABLE notes (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  image_id    TEXT NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  reviewer_id TEXT NOT NULL REFERENCES reviewers(id) ON DELETE CASCADE,
  parent_id   TEXT REFERENCES notes(id) ON DELETE CASCADE,
  x           REAL,
  y           REAL,
  body        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  resolved_at INTEGER,
  resolved_by TEXT
);
CREATE INDEX idx_notes_image   ON notes(image_id, created_at);
CREATE INDEX idx_notes_project ON notes(project_id);
