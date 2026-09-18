-- Full-text search index over note snapshots.
-- `trigram` tokenizer: substring matching for >=3-char terms, which also
-- gives Japanese/CJK search without word segmentation. Shorter terms are
-- verified app-side. Kept in sync by services/fts.ts (app-side sync —
-- migrations keep to plain statements so `wrangler d1 migrations` stays
-- safe).

CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  note_id UNINDEXED,
  title,
  body,
  tokenize = 'trigram'
);

INSERT INTO notes_fts (note_id, title, body)
  SELECT id, title, COALESCE(markdown_snapshot, '') FROM notes;
