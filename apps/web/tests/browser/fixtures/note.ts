import type { Note } from "@miyulabmd/shared";

export const note: Note = {
  access: {
    effectiveReadScope: "self",
    effectiveWriteScope: "self",
    flags: { canAdmin: true, canEdit: true, canView: true },
    grants: [],
    inherit: true,
    readScope: null,
    source: "default",
    sourceFolder: null,
    writeScope: null,
  },
  alias: null,
  articleMeta: {},
  createdAt: 1,
  editLocked: false,
  folder: "",
  folderId: null,
  id: "note-1",
  markdown: "# マイドライブ\n\n通信なしでも読みたい本文。",
  ownerId: "alice",
  permission: "private",
  shortId: "short-1",
  title: "マイドライブ",
  updatedAt: 2,
};
