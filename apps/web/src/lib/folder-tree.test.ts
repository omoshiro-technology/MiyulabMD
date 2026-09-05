import assert from "node:assert/strict";
import { test } from "node:test";
import type { FolderRecord } from "@miyulabmd/shared";
import {
  childrenOf,
  folderChain,
  folderHierarchyLevels,
  hasSelectableSourceFolders,
} from "./folder-tree.ts";

function folder(
  id: string,
  name: string,
  parentId: string | null,
  path: string,
): FolderRecord {
  return { id, name, parentId, folder: path };
}

const tree = [
  folder("work", "work", null, "work"),
  folder("play", "play", null, "play"),
  folder("infra", "infra", "work", "work/infra"),
  folder("db", "db", "infra", "work/infra/db"),
  folder("daily", "daily", "play", "play/daily"),
];

test("childrenOf returns siblings under a parent", () => {
  assert.deepEqual(
    childrenOf(tree, null).map((item) => item.id),
    ["play", "work"],
  );
  assert.deepEqual(
    childrenOf(tree, "work").map((item) => item.id),
    ["infra"],
  );
  assert.deepEqual(childrenOf(tree, "db"), []);
});

test("folderChain walks from the root to the selected path", () => {
  assert.deepEqual(
    folderChain(tree, "work/infra/db").map((item) => item.id),
    ["work", "infra", "db"],
  );
  assert.deepEqual(folderChain(tree, ""), []);
  assert.deepEqual(
    folderChain(tree, "missing/path").map((item) => item.id),
    [],
  );
});

test("hasSelectableSourceFolders ignores the drive root", () => {
  assert.equal(hasSelectableSourceFolders([]), false);
  assert.equal(
    hasSelectableSourceFolders([folder("root", "マイドライブ", null, "")]),
    false,
  );
  assert.equal(
    hasSelectableSourceFolders([
      folder("root", "マイドライブ", null, ""),
      folder("work", "work", "root", "work"),
    ]),
    true,
  );
});

test("folderHierarchyLevels skips the drive root and lists its children", () => {
  const withRoot = [
    folder("root", "マイドライブ", null, ""),
    folder("work", "work", "root", "work"),
    folder("play", "play", "root", "play"),
    folder("infra", "infra", "work", "work/infra"),
  ];
  const empty = folderHierarchyLevels(withRoot, "");
  assert.equal(empty[0]?.parentId, "root");
  assert.deepEqual(
    empty[0]?.options.map((item) => item.id),
    ["play", "work"],
  );

  const mid = folderHierarchyLevels(withRoot, "work");
  assert.equal(mid[0]?.selected, "work");
  assert.equal(mid[1]?.parentId, "work");
});

test("folderHierarchyLevels adds a next select while children exist", () => {
  const empty = folderHierarchyLevels(tree, "");
  assert.equal(empty.length, 1);
  assert.equal(empty[0]?.selected, "");
  assert.deepEqual(
    empty[0]?.options.map((item) => item.id),
    ["play", "work"],
  );

  const mid = folderHierarchyLevels(tree, "work");
  assert.equal(mid.length, 2);
  assert.equal(mid[0]?.selected, "work");
  assert.equal(mid[1]?.parentPath, "work");
  assert.equal(mid[1]?.selected, "");

  const leaf = folderHierarchyLevels(tree, "work/infra/db");
  assert.equal(leaf.length, 3);
  assert.deepEqual(
    leaf.map((level) => level.selected),
    ["work", "work/infra", "work/infra/db"],
  );
});
