import assert from "node:assert/strict";
import { test } from "node:test";
import type { FolderAccess, NoteSummary } from "@miyulabmd/shared";
import {
  filterSharedByMeFolders,
  filterSharedByMeNotes,
  isSharedByMeFolder,
  isSharedByMeNote,
  sharedByMeItems,
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

test("root shows sharing boundaries; opening a folder shows all shared children", () => {
  const hoge = folder("hoge", "hoge", "signed_in");
  const md1 = { ...note("md1", "me", "signed_in"), folderId: hoge.id };
  const md2 = { ...note("md2", "me", "public"), folderId: hoge.id };
  md2.access.inherit = false;
  const md3 = { ...note("md3", "me", "self"), folderId: hoge.id };
  const other = { ...note("other", "you", "public"), folderId: hoge.id };
  const notes = [md1, md2, md3, other];

  const root = sharedByMeItems([hoge], notes, "me", null);
  assert.deepEqual(
    root.folders.map((item) => item.id),
    ["hoge"],
  );
  assert.deepEqual(
    root.notes.map((item) => item.id),
    ["md2"],
  );
  const children = sharedByMeItems([hoge], notes, "me", hoge.id);
  assert.deepEqual(children.folders, []);
  assert.deepEqual(
    children.notes.map((item) => item.id),
    ["md1", "md2"],
  );
});

test("nested folders retain hierarchy and private parents do not hide shared descendants", () => {
  const parent = folder("parent", "parent", "public");
  const same = { ...folder("same", "same", "public"), parentId: parent.id };
  same.inherit = false; // Explicit but equivalent settings are not a boundary.
  const different = {
    ...folder("different", "different", "link"),
    parentId: same.id,
  };
  const privateFolder = {
    ...folder("private", "private", "self"),
    parentId: parent.id,
  };
  const belowPrivate = {
    ...folder("below-private", "below-private", "public"),
    parentId: privateFolder.id,
  };
  const inherited = {
    ...note("inherited", "me", "link"),
    folderId: different.id,
  };
  const orphan = { ...note("orphan", "me", "public"), folderId: "unavailable" };
  const folders = [parent, same, different, privateFolder, belowPrivate];
  const root = sharedByMeItems(folders, [inherited, orphan], "me", null);
  assert.deepEqual(
    root.folders.map((item) => item.id),
    ["parent", "different", "below-private"],
  );
  assert.deepEqual(
    root.notes.map((item) => item.id),
    ["orphan"],
  );
  assert.deepEqual(
    sharedByMeItems(folders, [], "me", parent.id).folders.map(
      (item) => item.id,
    ),
    ["same"],
  );
  assert.deepEqual(
    sharedByMeItems(folders, [inherited], "me", different.id).notes.map(
      (item) => item.id,
    ),
    ["inherited"],
  );
});

test("sharing boundaries compare write scope and effective grants, independent of order", () => {
  const parent = folder("parent", "parent", "users");
  parent.effectiveWriteScope = "users";
  parent.grants = [
    { email: "a@example.com", userId: "a", canWrite: true },
    { email: "b@example.com", userId: null, canWrite: false },
  ];
  const same = { ...note("same", "me", "users"), folderId: parent.id };
  same.access.effectiveWriteScope = "users";
  same.access.grants = [...parent.grants].reverse();
  const differentWriter = {
    ...same,
    id: "writer",
    access: {
      ...same.access,
      grants: parent.grants.map((grant) => ({ ...grant, canWrite: false })),
    },
  };
  const differentReader = {
    ...same,
    id: "reader",
    access: { ...same.access, grants: [parent.grants[0]!] },
  };
  const differentScope = {
    ...same,
    id: "scope",
    access: { ...same.access, effectiveWriteScope: "self" as const },
  };
  assert.deepEqual(
    sharedByMeItems(
      [parent],
      [same, differentWriter, differentReader, differentScope],
      "me",
      null,
    ).notes.map((item) => item.id),
    ["writer", "reader", "scope"],
  );
});

test("changing sharing settings recalculates boundaries and hides newly private items", () => {
  const parent = folder("parent", "parent", "public");
  const child = { ...note("child", "me", "signed_in"), folderId: parent.id };
  assert.equal(sharedByMeItems([parent], [child], "me", null).notes.length, 1);
  child.access.effectiveReadScope = "public";
  assert.equal(sharedByMeItems([parent], [child], "me", null).notes.length, 0);
  assert.equal(
    sharedByMeItems([parent], [child], "me", parent.id).notes.length,
    1,
  );
  child.access.effectiveReadScope = "self";
  assert.equal(
    sharedByMeItems([parent], [child], "me", parent.id).notes.length,
    0,
  );
});
