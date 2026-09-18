import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import type { FolderAccess, NoteSummary, SessionUser } from "@miyulabmd/shared";
import {
  invalidateFolderCache,
  invalidateNotesCache,
  peekNotes,
  seedFolderCache,
  upsertNoteSummary,
} from "../lib/list-cache.ts";
import {
  homeListFlags,
  loadParaSpaces,
  subscribeHomeFolder,
  subscribeHomeNotes,
} from "./home-page.ts";

function note(id: string, folderId: string | null = "folder-1"): NoteSummary {
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
    folder: "docs",
    folderId,
    id,
    ownerId: "me",
    permission: "private",
    shortId: id,
    title: id,
    updatedAt: 1,
  };
}

function folder(id: string, name = "docs"): FolderAccess {
  return {
    children: [],
    crumbs: [{ id, name }],
    effectiveReadScope: "self",
    effectiveWriteScope: "self",
    flags: { canAdmin: true, canEdit: true, canView: true },
    folder: name,
    grants: [],
    id,
    inherit: true,
    name,
    parentId: null,
    readScope: null,
    source: "default",
    sourceFolder: null,
    writeScope: null,
  };
}

const user: SessionUser = {
  displayName: "Me",
  email: "me@example.com",
  id: "me",
};

afterEach(() => {
  invalidateNotesCache();
  invalidateFolderCache();
  mock.restoreAll();
});

async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (check()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error("timed out");
}

test("homeListFlags keeps the tree visible while a folder is still loading", () => {
  const flags = homeListFlags({
    error: null,
    folderId: "folder-1",
    folderPending: false,
    user,
    userLoading: false,
    visibleFolder: null,
  });
  assert.equal(flags.showPlaceholder, true);
  assert.equal(flags.showTree, true);
});

test("homeListFlags hides the tree when the folder failed to load", () => {
  const flags = homeListFlags({
    error: "フォルダが見つかりません。",
    folderId: "folder-1",
    folderPending: false,
    user,
    userLoading: false,
    visibleFolder: null,
  });
  assert.equal(flags.showPlaceholder, false);
  assert.equal(flags.showTree, false);
});

test("subscribeHomeNotes keeps the list cache while refetching after a remount", async () => {
  upsertNoteSummary(note("keep-me"));
  const fetched = Promise.withResolvers<void>();
  mock.method(globalThis, "fetch", () => {
    fetched.resolve();
    return Promise.resolve(
      new Response(JSON.stringify({ notes: [note("fresh")] }), {
        status: 200,
      }),
    );
  });

  const setNotes = mock.fn<(notes: NoteSummary[]) => void>();
  const unsubscribe = subscribeHomeNotes(false, setNotes);
  assert.deepEqual(
    peekNotes()?.map((item) => item.id),
    ["keep-me"],
  );
  assert.equal(setNotes.mock.callCount(), 0);

  await fetched.promise;
  await waitFor(() => setNotes.mock.callCount() > 0);
  assert.deepEqual(
    setNotes.mock.calls[0]?.arguments[0].map((item) => item.id),
    ["fresh"],
  );
  unsubscribe?.();
});

test("subscribeHomeFolder shows the cached folder immediately and refreshes it", async () => {
  const cached = folder("folder-1");
  const next = { ...folder("folder-1"), name: "updated" };
  seedFolderCache(cached);
  const fetched = Promise.withResolvers<void>();
  mock.method(globalThis, "fetch", () => {
    fetched.resolve();
    return Promise.resolve(new Response(JSON.stringify(next), { status: 200 }));
  });

  const setVisibleFolder = mock.fn<(value: FolderAccess | null) => void>();
  const setPublicFolders = mock.fn();
  const setFolderPending = mock.fn<(pending: boolean) => void>();
  const setError = mock.fn<(error: string | null) => void>();
  const unsubscribe = subscribeHomeFolder("folder-1", user, false, {
    setError,
    setFolderPending,
    setPublicFolders,
    setVisibleFolder,
  });

  assert.equal(setVisibleFolder.mock.calls[0]?.arguments[0], cached);
  assert.equal(setFolderPending.mock.calls[0]?.arguments[0], false);

  await fetched.promise;
  await waitFor(
    () => setVisibleFolder.mock.calls.at(-1)?.arguments[0]?.name === "updated",
  );
  unsubscribe?.();
});

test("loadParaSpaces never calls /api/para while the para flag is off", async () => {
  const spy = mock.method(globalThis, "fetch", () =>
    Promise.resolve(new Response("{}", { status: 200 })),
  );
  assert.deepEqual(await loadParaSpaces(user, false), []);
  assert.equal(spy.mock.callCount(), 0);
  // Guests never fetch either, even with the flag on.
  assert.deepEqual(await loadParaSpaces(null, true), []);
  assert.equal(spy.mock.callCount(), 0);
});

test("loadParaSpaces fetches spaces when para is enabled", async () => {
  const spy = mock.method(globalThis, "fetch", () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          buckets: [
            {
              folderId: "f-projects",
              key: "projects",
              name: "Projects",
              noteCount: 0,
              path: "Projects",
            },
          ],
          spaces: [
            {
              buckets: [
                {
                  folderId: "f-projects",
                  key: "projects",
                  name: "Projects",
                  noteCount: 0,
                  path: "Projects",
                },
              ],
              id: "space-default",
              isDefault: true,
              name: "default",
              rootFolderId: null,
              rootPath: "",
            },
            {
              buckets: [
                {
                  folderId: "f-work-projects",
                  key: "projects",
                  name: "Projects",
                  noteCount: 0,
                  path: "work/Projects",
                },
              ],
              id: "space-work",
              isDefault: false,
              name: "work",
              rootFolderId: "f-work",
              rootPath: "work",
            },
          ],
        }),
        {
          headers: { "X-MiyulabMD-Session-User": "user:me" },
          status: 200,
        },
      ),
    ),
  );
  const spaces = await loadParaSpaces(user, true);
  assert.equal(spy.mock.callCount(), 1);
  assert.equal(spaces.length, 2);
  assert.equal(spaces[0]?.isDefault, true);
  assert.equal(spaces[0]?.buckets[0]?.key, "projects");
  assert.equal(spaces[1]?.name, "work");
  assert.equal(spaces[1]?.buckets[0]?.path, "work/Projects");
});

test("loadParaSpaces swallows API errors into an empty list", async () => {
  mock.method(globalThis, "fetch", () =>
    Promise.resolve(
      new Response(JSON.stringify({ error: "Unauthorized" }), {
        headers: { "X-MiyulabMD-Session-User": "user:me" },
        status: 401,
      }),
    ),
  );
  assert.deepEqual(await loadParaSpaces(user, true), []);
});
