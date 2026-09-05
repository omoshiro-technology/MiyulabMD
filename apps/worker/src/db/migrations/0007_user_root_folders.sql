INSERT INTO folders (id, owner_id, folder, created_at)
SELECT lower(hex(randomblob(16))), id, '', created_at
FROM users
WHERE NOT EXISTS (
  SELECT 1 FROM folders WHERE folders.owner_id = users.id AND folders.folder = ''
);
