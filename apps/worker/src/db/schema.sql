-- 概念スキーマ。適用は src/db/migrations 経由。
-- 本文のソース・オブ・トゥルースは DocumentRoom Durable Object。

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER,
  settings TEXT
);

CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  short_id TEXT NOT NULL UNIQUE,
  alias TEXT UNIQUE,
  owner_id TEXT NOT NULL REFERENCES users (id),
  title TEXT NOT NULL DEFAULT 'Untitled',
  folder TEXT NOT NULL DEFAULT '',
  permission TEXT NOT NULL,
  read_scope TEXT,
  write_scope TEXT,
  markdown_snapshot TEXT NOT NULL DEFAULT '',
  snapshot_updated_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  article_meta TEXT,
  -- §2.6 permanent edit lock (1 = read-only until explicit unlock).
  edit_locked INTEGER NOT NULL DEFAULT 0,
  -- Deprecated KM-C columns kept for history; not read by active code.
  layer TEXT NOT NULL DEFAULT 'bronze',
  gold_unlocked_until INTEGER
);

CREATE TABLE note_collaborators (
  note_id TEXT NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id),
  role TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (note_id, user_id)
);

CREATE TABLE medallion_sets (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  -- JSON array of [{key, label}] ordered top→bottom. Keys immutable.
  layers TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);

CREATE TABLE folders (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  folder TEXT NOT NULL,
  para_bucket TEXT,
  para_space_id TEXT,
  scheme TEXT,
  scheme_id TEXT,
  scheme_title TEXT,
  -- 採番スコープのルート = 規則を宣言したフォルダの id（scheme あり・
  -- scheme_id なしの祖先）。採番カウンタと scheme_id 一意性はこの単位。
  scheme_root TEXT,
  -- §2.6: at most one medallion assignment per folder; descendants inherit
  -- the nearest ancestor's assignment.
  medallion_set_id TEXT REFERENCES medallion_sets (id) ON DELETE SET NULL,
  medallion_layer TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE para_spaces (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  root_folder_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX folders_owner_folder_idx ON folders (owner_id, folder);
-- Bucket uniqueness is per space; NULL para_space_id = default space.
CREATE UNIQUE INDEX folders_owner_para_bucket_idx
  ON folders (owner_id, COALESCE(para_space_id, ''), para_bucket)
  WHERE para_bucket IS NOT NULL;
CREATE UNIQUE INDEX folders_owner_scheme_id_idx
  ON folders (owner_id, scheme_root, scheme_id)
  WHERE scheme_id IS NOT NULL;
CREATE UNIQUE INDEX para_spaces_owner_name_idx ON para_spaces (owner_id, name);
CREATE UNIQUE INDEX para_spaces_root_folder_idx
  ON para_spaces (root_folder_id)
  WHERE root_folder_id IS NOT NULL;
CREATE UNIQUE INDEX para_spaces_owner_rootless_idx
  ON para_spaces (owner_id)
  WHERE root_folder_id IS NULL;

CREATE TABLE id_counters (
  owner_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  next_value INTEGER NOT NULL,
  PRIMARY KEY (owner_id, scope)
);

CREATE TABLE folder_policies (
  owner_id TEXT NOT NULL,
  folder TEXT NOT NULL,
  read_scope TEXT NOT NULL,
  write_scope TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, folder)
);

CREATE TABLE access_grants (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_key TEXT NOT NULL,
  email TEXT NOT NULL,
  user_id TEXT,
  can_write INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE images (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  uploader_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE TABLE article_sources (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  folder TEXT NOT NULL,
  folder_id TEXT,
  name TEXT NOT NULL,
  schema_json TEXT NOT NULL,
  webhook_url TEXT,
  webhook_authorization TEXT,
  last_dispatched_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (owner_id, folder)
);

CREATE TABLE note_edit_events (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
  revision_id TEXT,
  actor_kind TEXT NOT NULL,
  actor_user_id TEXT,
  actor_name TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  op TEXT NOT NULL,
  excerpt TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE note_revisions (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
  event_id TEXT,
  r2_key TEXT NOT NULL UNIQUE,
  byte_size INTEGER NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_user_id TEXT,
  actor_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE note_layer_events (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
  from_layer TEXT,
  to_layer TEXT NOT NULL,
  actor_user_id TEXT,
  actor_name TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE note_links (
  src_note_id TEXT NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
  dest_note_id TEXT REFERENCES notes (id) ON DELETE SET NULL,
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

CREATE INDEX notes_owner_id_idx ON notes (owner_id);
CREATE INDEX note_edit_events_note_created_idx ON note_edit_events (note_id, created_at);
CREATE INDEX note_revisions_note_created_idx ON note_revisions (note_id, created_at);
CREATE INDEX article_sources_owner_id_idx ON article_sources (owner_id);
CREATE INDEX notes_owner_folder_idx ON notes (owner_id, folder);
CREATE UNIQUE INDEX access_grants_target_email_idx ON access_grants (target_kind, target_key, email);
CREATE INDEX access_grants_user_id_idx ON access_grants (user_id);
CREATE INDEX access_grants_owner_id_idx ON access_grants (owner_id);
CREATE INDEX notes_updated_at_idx ON notes (updated_at);
CREATE INDEX images_note_id_idx ON images (note_id);
CREATE INDEX api_tokens_user_id_idx ON api_tokens (user_id);
CREATE INDEX note_links_dest_idx ON note_links (dest_note_id);
CREATE INDEX note_links_src_status_idx ON note_links (src_note_id, dest_status);
CREATE INDEX notes_owner_layer_idx ON notes (owner_id, layer);
CREATE INDEX note_layer_events_note_idx ON note_layer_events (note_id, created_at);
CREATE INDEX medallion_sets_owner_idx ON medallion_sets (owner_user_id);
CREATE INDEX folders_medallion_set_idx ON folders (medallion_set_id);
CREATE INDEX notes_owner_edit_locked_idx ON notes (owner_id) WHERE edit_locked = 1;

CREATE VIRTUAL TABLE notes_fts USING fts5(
  note_id UNINDEXED,
  title,
  body,
  tokenize = 'trigram'
);
