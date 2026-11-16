-- View-only links: a client-facing page of one person's selects (reviewer_id
-- set) or every visible reviewer's (reviewer_id NULL). Live: the page follows
-- the picks as they change. Nothing on it can be changed — no sidebar, hearts
-- or notes — and it reaches only the photos it shows.
CREATE TABLE view_links (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  token       TEXT NOT NULL UNIQUE,
  reviewer_id TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_view_links_project ON view_links(project_id, reviewer_id);
