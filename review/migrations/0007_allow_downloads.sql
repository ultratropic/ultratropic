-- Whether reviewers get download buttons. On by default; the owner can turn it
-- off per project. The owner can always download their own work.
ALTER TABLE projects ADD COLUMN allow_downloads INTEGER NOT NULL DEFAULT 1;
