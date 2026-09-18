-- Naming-scheme support. A folder may declare a naming rule for its direct
-- children (`scheme`: 'jd', 'zettel', ...) and/or carry an ID minted by a
-- parent's scheme (`scheme_id` + `scheme_title`). scheme_id is unique per
-- owner across schemes so a bare ID ("15.22", "202609171230") opens one folder.

ALTER TABLE folders ADD COLUMN scheme TEXT;
ALTER TABLE folders ADD COLUMN scheme_id TEXT;
ALTER TABLE folders ADD COLUMN scheme_title TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS folders_owner_scheme_id_idx
  ON folders (owner_id, scheme_id)
  WHERE scheme_id IS NOT NULL;

-- Atomic per-scope counters (D1 has no interactive transactions; the UPSERT
-- ... RETURNING single statement is serialized per database).
CREATE TABLE IF NOT EXISTS id_counters (
  owner_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  next_value INTEGER NOT NULL,
  PRIMARY KEY (owner_id, scope)
);
