import assert from "node:assert/strict";
import { test } from "node:test";
import type { FolderAccess, NoteSummary } from "@miyulabmd/shared";
import {
  filterSharedByMeFolders,
  filterSharedByMeNotes,
  isSharedByMeFolder,
  isSharedByMeNote,
} from "./shared-by-me.ts";

function note(
  id: string,
  ownerId: string,
  effectiveReadScope: NoteSummary["access"]["effectiveReadScope"],
): NoteSummary {
  return {
    id,
    shortId: id,
    alias: null,
    ownerId,
    title: id,
    folder: "",
    folderId: null,
    permission: "private",
    access: {
      inherit: true,
      readScope: null,
      writeScope: null,
      effectiveReadScope,
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

function folder(
  id: string,
  name: string,
  effectiveReadScope: FolderAccess["effectiveReadScope"],
  locked = false,
): FolderAccess {
  return {
    id,
    name,
    parentId: null,
    folder: name,
    crumbs: [],
    children: [],
    flags: { canView: true, canEdit: false, canAdmin: true },
    inherit: true,
    readScope: null,
    writeScope: null,
    effectiveReadScope,
    effectiveWriteScope: "self",
    source: "default",
    sourceFolder: null,
    grants: [],
    ...(locked ? { locked: true } : {}),
  };
}

test("isSharedByMeNote filters own notes by scope", () => {
  assert.equal(isSharedByMeNote(note("mine", "me", "public"), "me"), true);
  assert.equal(isSharedByMeNote(note("mine-self", "me", "self"), "me"), false);
  assert.equal(isSharedByMeNote(note("other", "you", "public"), "me"), false);
});

test("filterSharedByMeNotes keeps only own shared notes", () => {
  const list = [
    note("mine-public", "me", "public"),
    note("mine-signed-in", "me", "signed_in"),
    note("mine-users", "me", "users"),
    note("mine-self", "me", "self"),
    note("theirs", "you", "public"),
  ];
  const result = filterSharedByMeNotes(list, "me").map((item) => item.id);
  assert.deepEqual(result, ["mine-public", "mine-signed-in", "mine-users"]);
});

test("isSharedByMeFolder excludes root lock and self scope", () => {
  assert.equal(isSharedByMeFolder(folder("f1", "team", "public")), true);
  assert.equal(isSharedByMeFolder(folder("f2", "team", "self")), false);
  assert.equal(
    isSharedByMeFolder(folder("root", "root", "public", true)),
    false,
  );
});

test("filterSharedByMeFolders keeps only shared folders", () => {
  const list = [
    folder("f1", "A", "public"),
    folder("f-signed-in", "Signed in", "signed_in"),
    folder("f-users", "Users", "users"),
    folder("f2", "B", "self"),
    folder("f3", "C", "users", true),
  ];
  const result = filterSharedByMeFolders(list).map((item) => item.id);
  assert.deepEqual(result, ["f1", "f-signed-in", "f-users"]);
});
