-- Medallion layers. Notes carry a quality layer (bronze|silver|gold);
-- gold notes reject edits unless `gold_unlocked_until` is in the future
-- (policy lock, not a pessimistic lock). Layer transitions are audited
-- in note_layer_events, and promote marks the newest revision pinned so
-- history compaction keeps it.

ALTER TABLE notes ADD COLUMN layer TEXT NOT NULL DEFAULT 'bronze';
ALTER TABLE notes ADD COLUMN gold_unlocked_until INTEGER;
ALTER TABLE note_revisions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS note_layer_events (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
  from_layer TEXT,
  to_layer TEXT NOT NULL,
  actor_user_id TEXT,
  actor_name TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS notes_owner_layer_idx ON notes (owner_id, layer);
CREATE INDEX IF NOT EXISTS note_layer_events_note_idx
  ON note_layer_events (note_id, created_at);
