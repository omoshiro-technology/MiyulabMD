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
    id,
    shortId: id,
    alias: null,
    ownerId,
    title: id,
    folder: "",
    folderId,
    permission: "private",
    access: {
      inherit: true,
      readScope: null,
      writeScope: null,
      effectiveReadScope: "self",
      effectiveWriteScope: "self",
      source: "default",
      sourceFolder: null,
      grants: [],
      flags: { canView: true, canEdit: false, canAdmin: false },
    },
    articleMeta: {},
    createdAt: 1,
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
