-- Casting: who a person is cast as — 'men', 'women' or 'kids' — for the
-- Men / Women / Kids filter. Set on every photo of the person. Null: the page
-- falls back to the board's name ("Wilhelmina — Men", "Signature Kids").
ALTER TABLE images ADD COLUMN talent_group TEXT;
