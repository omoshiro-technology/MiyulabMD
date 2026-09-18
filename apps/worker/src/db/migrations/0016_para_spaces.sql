-- §2.5 multi-PARA spaces. A space = a user-named root folder plus the four
-- PARA buckets beneath it. Bucket rows carry `para_space_id`; NULL means the
-- implicit rootless "default" space whose buckets sit at drive root.

CREATE TABLE IF NOT EXISTS para_spaces (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  root_folder_id TEXT,
  created_at INTEGER NOT NULL
);

-- Space names are unique per owner (DSL `para:<name>.<bucket>` and
-- `plan?space=` resolve by name).
CREATE UNIQUE INDEX IF NOT EXISTS para_spaces_owner_name_idx
  ON para_spaces (owner_id, name);
-- A folder can be the root of at most one space (flat-overlap rule, ADR 0005).
CREATE UNIQUE INDEX IF NOT EXISTS para_spaces_root_folder_idx
  ON para_spaces (root_folder_id)
  WHERE root_folder_id IS NOT NULL;
-- At most one rootless (default) space per owner.
CREATE UNIQUE INDEX IF NOT EXISTS para_spaces_owner_rootless_idx
  ON para_spaces (owner_id)
  WHERE root_folder_id IS NULL;

ALTER TABLE folders ADD COLUMN para_space_id TEXT;

-- Bucket uniqueness becomes per-space: (owner_id, para_space_id, para_bucket).
-- SQLite treats NULLs as distinct in unique indexes, so the default space's
-- NULL para_space_id is coalesced to '' to keep its buckets unique too.
DROP INDEX IF EXISTS folders_owner_para_bucket_idx;
CREATE UNIQUE INDEX folders_owner_para_bucket_idx
  ON folders (owner_id, COALESCE(para_space_id, ''), para_bucket)
  WHERE para_bucket IS NOT NULL;

-- Backfill: owners with existing bucket rows get their implicit default space
-- materialized as a rootless row named 'default'. Their bucket rows keep
-- para_space_id = NULL, which is the default space marker.
INSERT INTO para_spaces (id, owner_id, name, root_folder_id, created_at)
SELECT lower(hex(randomblob(16))), owner_id, 'default', NULL,
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM folders
WHERE para_bucket IS NOT NULL
GROUP BY owner_id;
