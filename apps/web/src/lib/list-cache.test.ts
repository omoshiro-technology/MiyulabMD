import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import type { NoteSummary } from "@miyulabmd/shared";
import {
  invalidateNotesCache,
  loadNotes,
  peekNotes,
  upsertNoteSummary,
} from "./list-cache.ts";

function note(id: string): NoteSummary {
  return {
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
    id,
    ownerId: "me",
    permission: "private",
    shortId: id,
    title: id,
    updatedAt: 1,
  };
}

afterEach(() => {
  invalidateNotesCache();
  mock.restoreAll();
});

test("upsertNoteSummary prepends a created note so back navigation can show it", () => {
  upsertNoteSummary(note("old"));
  upsertNoteSummary(note("new"));
  assert.deepEqual(
    peekNotes()?.map((item) => item.id),
    ["new", "old"],
  );
});

test("loadNotes keeps the previous list when the refetch fails", async () => {
  upsertNoteSummary(note("cached"));
  mock.method(globalThis, "fetch", () =>
    Promise.resolve(new Response("nope", { status: 500 })),
  );

  const notes = await loadNotes(true);
  assert.deepEqual(
    notes.map((item) => item.id),
    ["cached"],
  );
  assert.deepEqual(
    peekNotes()?.map((item) => item.id),
    ["cached"],
  );
});
