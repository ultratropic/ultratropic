-- Casting projects: the unit is a person, not a frame. A project is either a
-- shoot (the default) or a casting; a casting shows each photo's talent name,
-- portfolio link and status line, and the description becomes the brief.
ALTER TABLE projects ADD COLUMN kind TEXT NOT NULL DEFAULT 'shoot';
ALTER TABLE images ADD COLUMN talent_name TEXT;
ALTER TABLE images ADD COLUMN link TEXT;
ALTER TABLE images ADD COLUMN info TEXT;
