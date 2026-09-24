-- A filesystem folder cannot contain two files with the same name, so a filename is
-- unique within an album. This gives resumable uploads for free: re-committing an
-- already-uploaded file is a no-op via INSERT OR IGNORE, so a retry after a partial
-- failure can safely replay the whole batch.
-- Duplicate filenames ACROSS albums remain legal and are resolved at export.
CREATE UNIQUE INDEX idx_images_album_filename ON images(album_id, original_filename);
