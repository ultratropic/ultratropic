-- Curated links (/c/<token>): a client page laid out in titled sections of
-- chosen people ("Four returning talent", "Wider suggestions", "Kids"), with no
-- sidebar. Anyone with the link can heart and note within it, as on an album
-- link; it reaches only the photos of the people it lists. The token is the key.
-- layout: {"sections":[{"title":"…","people":["Name", …]}, …]}
CREATE TABLE curated_links (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  token       TEXT NOT NULL UNIQUE,
  title       TEXT,
  layout      TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_curated_links_project ON curated_links(project_id);
