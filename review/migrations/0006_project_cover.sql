-- The image shown for a project on the project list. Null means "automatic":
-- the first frame of the first album. A cover that has since been deleted falls
-- back to automatic too, so this never needs to be valid to be safe.
ALTER TABLE projects ADD COLUMN cover_image_id TEXT;
