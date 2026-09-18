-- PARA bucket stable keys on folder rows. The key survives folder renames and
-- moves so bucket membership is not tied to the display name or path.

ALTER TABLE folders ADD COLUMN para_bucket TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS folders_owner_para_bucket_idx
  ON folders (owner_id, para_bucket)
  WHERE para_bucket IS NOT NULL;
