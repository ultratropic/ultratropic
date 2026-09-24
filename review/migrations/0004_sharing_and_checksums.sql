-- Client album links: an unguessable token per album, so a client link reveals
-- nothing about the project URL and cannot be walked up to other albums.
-- Created lazily when an album is first shared, hence nullable.
ALTER TABLE albums ADD COLUMN share_token TEXT;
CREATE UNIQUE INDEX idx_albums_share_token ON albums(share_token);

-- SHA-256 of the original upload, for spotting the same file uploaded twice
-- (e.g. a folder re-dropped with a different album split). Null for images
-- uploaded before this migration.
ALTER TABLE images ADD COLUMN checksum TEXT;
CREATE INDEX idx_images_project_checksum ON images(project_id, checksum);
