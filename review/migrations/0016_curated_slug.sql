-- A readable address a curated link also answers to (/c/eb-sp-27-casting),
-- alongside its random token. Optional; unique when set.
ALTER TABLE curated_links ADD COLUMN slug TEXT;
CREATE UNIQUE INDEX idx_curated_links_slug ON curated_links(slug);
