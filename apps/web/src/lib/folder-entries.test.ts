import assert from "node:assert/strict";
import { test } from "node:test";
import type { FolderChildrenResult, FolderEntry } from "@miyulabmd/shared";
import {
  expansionRefreshLimit,
  failFolderExpansion,
  resolveFolderExpansion,
  startFolderExpansion,
} from "./folder-entries.ts";

function folderEntry(id: string): FolderEntry {
  return {
    id,
    name: `folder-${id}`,
    parentId: "parent",
    type: "folder",
    updatedAt: 1,
  };
}

function noteEntry(id: string): FolderEntry {
  return { id, title: `note-${id}`, type: "note", updatedAt: 1 };
}

function page(
  entries: FolderEntry[],
  nextCursor: string | null = null,
): FolderChildrenResult {
  return {
    entries,
    folder: { id: "parent", name: "parent", path: ["parent"] },
    nextCursor,
  };
}

test("startFolderExpansion marks the first request as pending", () => {
  const state = startFolderExpansion("initial");
  assert.equal(state.pending, "initial");
  assert.deepEqual(state.entries, []);
  assert.equal(state.nextCursor, null);
  assert.equal(state.error, null);
});

test("resolveFolderExpansion replaces entries on initial load", () => {
  const pending = startFolderExpansion("initial");
  const state = resolveFolderExpansion(
    page([folderEntry("a"), noteEntry("n1")], "50"),
    "initial",
    pending,
  );
  assert.equal(state.pending, null);
  assert.deepEqual(
    state.entries.map((entry) => entry.id),
    ["a", "n1"],
  );
  assert.equal(state.nextCursor, "50");
});

test("resolveFolderExpansion appends and dedupes on load-more", () => {
  const first = resolveFolderExpansion(
    page([folderEntry("a"), noteEntry("n1")], "2"),
    "initial",
  );
  const pending = startFolderExpansion("more", first);
  const state = resolveFolderExpansion(
    page([noteEntry("n1"), noteEntry("n2")]),
    "more",
    pending,
  );
  assert.deepEqual(
    state.entries.map((entry) => entry.id),
    ["a", "n1", "n2"],
  );
  assert.equal(state.nextCursor, null);
});

test("resolveFolderExpansion refreshes in place without clearing rows", () => {
  const first = resolveFolderExpansion(page([noteEntry("n1")]), "initial");
  const refresh = resolveFolderExpansion(
    page([noteEntry("n2")]),
    "refresh",
    first,
  );
  assert.deepEqual(
    refresh.entries.map((entry) => entry.id),
    ["n2"],
  );
});

test("failFolderExpansion keeps loaded entries and clears pending", () => {
  const first = resolveFolderExpansion(page([noteEntry("n1")], "2"), "initial");
  const pending = startFolderExpansion("more", first);
  const failed = failFolderExpansion("boom", pending);
  assert.equal(failed.error, "boom");
  assert.equal(failed.pending, null);
  assert.deepEqual(
    failed.entries.map((entry) => entry.id),
    ["n1"],
  );
  assert.equal(failed.nextCursor, "2");
});

test("expansionRefreshLimit covers the loaded window within API bounds", () => {
  const empty = resolveFolderExpansion(page([]), "initial");
  assert.equal(expansionRefreshLimit(empty), 50);
  const loaded = resolveFolderExpansion(
    page(Array.from({ length: 120 }, (_, i) => noteEntry(`n${i}`))),
    "initial",
  );
  assert.equal(expansionRefreshLimit(loaded), 120);
  const huge = resolveFolderExpansion(
    page(Array.from({ length: 500 }, (_, i) => noteEntry(`n${i}`))),
    "initial",
  );
  assert.equal(expansionRefreshLimit(huge), 200);
});
