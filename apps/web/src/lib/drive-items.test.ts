import assert from "node:assert/strict";
import { test } from "node:test";
import type { NoteSummary } from "@miyulabmd/shared";
import { sharedNotesForUser } from "./drive-items.ts";

function note(
  id: string,
  ownerId: string,
  folderId: string | null,
): NoteSummary {
  return {
    access: {
      effectiveReadScope: "self",
      effectiveWriteScope: "self",
      flags: { canAdmin: false, canEdit: false, canView: true },
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
    folderId,
    id,
    ownerId,
    permission: "private",
    shortId: id,
    title: id,
    updatedAt: 1,
  };
}

test("sharedNotesForUser hides own notes that sit in my drive", () => {
  const own = note("own", "me", "root");
  const shared = note("shared", "them", null);
  const visibleFolder = note("in-folder", "them", "folder-1");
  assert.deepEqual(
    sharedNotesForUser([own, shared, visibleFolder], "me").map(
      (item) => item.id,
    ),
    ["shared", "in-folder"],
  );
});

test("sharedNotesForUser hides own notes even without a folder id", () => {
  const orphan = note("orphan", "me", null);
  assert.deepEqual(
    sharedNotesForUser([orphan], "me").map((item) => item.id),
    [],
  );
});
