-- Serving an image must prove the key belongs to the requester's project, so a
-- reviewer holding a session for one project can never fetch another's frames.
-- That check runs per image request, so it needs to be an index hit.
CREATE INDEX idx_images_thumb_key   ON images(thumb_key);
CREATE INDEX idx_images_preview_key ON images(preview_key);
