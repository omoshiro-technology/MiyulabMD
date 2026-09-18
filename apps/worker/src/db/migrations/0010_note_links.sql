-- Wiki-link / note-link index for outgoing links, backlinks, and broken links.

CREATE TABLE IF NOT EXISTS note_links (
  src_note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  dest_note_id TEXT REFERENCES notes(id) ON DELETE SET NULL,
  dest_raw TEXT NOT NULL,
  dest_display TEXT,
  link_type TEXT NOT NULL,
  heading TEXT,
  offset_start INTEGER NOT NULL,
  offset_end INTEGER NOT NULL,
  dest_status TEXT NOT NULL DEFAULT 'missing',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (src_note_id, offset_start, dest_raw)
);

CREATE INDEX IF NOT EXISTS idx_note_links_dest ON note_links (dest_note_id);
CREATE INDEX IF NOT EXISTS idx_note_links_src_status
  ON note_links (src_note_id, dest_status);
