-- KM-D §2.6: medallion layer sets assigned to folders + permanent per-note
-- edit lock. Legacy per-note `notes.layer`, `gold_unlocked_until` and
-- `note_layer_events` stay in the schema for history but are no longer read
-- by active code paths.

CREATE TABLE medallion_sets (
  id            TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  -- JSON array of [{key, label}] ordered top→bottom. Keys immutable.
  layers        TEXT NOT NULL DEFAULT '[]',
  created_at    INTEGER NOT NULL
);

CREATE INDEX idx_medallion_sets_owner ON medallion_sets(owner_user_id);

-- A folder carries at most one medallion assignment (set + layer key).
-- Descendants inherit the nearest ancestor's assignment.
ALTER TABLE folders ADD COLUMN medallion_set_id TEXT REFERENCES medallion_sets(id) ON DELETE SET NULL;
ALTER TABLE folders ADD COLUMN medallion_layer TEXT;
CREATE INDEX idx_folders_medallion_set ON folders(medallion_set_id);

-- Permanent edit lock: 1 = read-only for everyone until explicit unlock.
-- Backfill preserves the old behaviour: gold notes whose temporary unlock
-- window is still open stay editable; every other gold note was effectively
-- locked and starts locked here. Timestamps are ms epoch.
ALTER TABLE notes ADD COLUMN edit_locked INTEGER NOT NULL DEFAULT 0;
UPDATE notes SET edit_locked = 1
  WHERE layer = 'gold'
    AND (gold_unlocked_until IS NULL
         OR gold_unlocked_until <= CAST(strftime('%s', 'now') AS INTEGER) * 1000);
CREATE INDEX idx_notes_edit_locked ON notes(owner_id) WHERE edit_locked = 1;
