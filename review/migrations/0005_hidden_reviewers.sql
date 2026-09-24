-- A hidden reviewer's name and picks are invisible to other reviewers — e.g. the
-- team's own opinions kept private from a client. The owner still sees everything,
-- and the hidden person still sees their own picks. Reversible.
ALTER TABLE reviewers ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
