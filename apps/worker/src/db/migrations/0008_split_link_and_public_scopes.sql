-- `public` は従来「リンクを知っている全員」を意味していた。
-- 列挙可能な新しい `public` と区別し、既存の共有範囲を広げずに移行する。
UPDATE notes SET read_scope = 'link' WHERE read_scope = 'public';
UPDATE notes SET write_scope = 'link' WHERE write_scope = 'public';
UPDATE folder_policies SET read_scope = 'link' WHERE read_scope = 'public';
UPDATE folder_policies SET write_scope = 'link' WHERE write_scope = 'public';
