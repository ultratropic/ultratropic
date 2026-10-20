-- Drawings on a note: a JSON list of pen strokes, ellipses and arrows, in the
-- same 0–1 photo coordinates as pins. A note with marks may have no text.
ALTER TABLE notes ADD COLUMN shapes TEXT;
