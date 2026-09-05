ALTER TABLE notes ADD COLUMN read_scope TEXT;
ALTER TABLE notes ADD COLUMN write_scope TEXT;

UPDATE notes SET read_scope = 'link', write_scope = 'link' WHERE permission = 'freely';
UPDATE notes SET read_scope = 'link', write_scope = 'signed_in' WHERE permission = 'editable';
UPDATE notes SET read_scope = 'signed_in', write_scope = 'signed_in' WHERE permission = 'limited';
UPDATE notes SET read_scope = 'link', write_scope = 'self' WHERE permission = 'locked';
UPDATE notes SET read_scope = 'signed_in', write_scope = 'self' WHERE permission = 'protected';
UPDATE notes SET read_scope = 'self', write_scope = 'self' WHERE permission = 'private';
UPDATE notes SET read_scope = 'link', write_scope = 'signed_in' WHERE read_scope IS NULL OR write_scope IS NULL;

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

CREATE UNIQUE INDEX access_grants_target_email_idx
  ON access_grants (target_kind, target_key, email);
CREATE INDEX access_grants_user_id_idx ON access_grants (user_id);
CREATE INDEX access_grants_owner_id_idx ON access_grants (owner_id);

INSERT INTO access_grants (id, owner_id, target_kind, target_key, email, user_id, can_write, created_at)
SELECT
  lower(hex(randomblob(16))),
  n.owner_id,
  'note',
  nc.note_id,
  u.email,
  nc.user_id,
  CASE WHEN nc.role = 'editor' THEN 1 ELSE 0 END,
  nc.created_at
FROM note_collaborators nc
JOIN notes n ON n.id = nc.note_id
JOIN users u ON u.id = nc.user_id;
