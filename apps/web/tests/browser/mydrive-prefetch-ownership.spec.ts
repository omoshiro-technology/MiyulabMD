import { expect, test } from "@playwright/test";
import { note } from "./fixtures/note.ts";

const headers = { "X-MiyulabMD-Session-User": "user:alice" };

test("prefetch owns its viewer snapshot even when the caller mutates the input", async ({
  page,
}) => {
  const rootId = "alice-root";
  const owned = { ...note, folderId: rootId };
  const { markdown: _markdown, ...summary } = owned;
  const root = {
    ...note.access,
    children: [],
    crumbs: [{ id: rootId, name: "マイドライブ" }],
    folder: "",
    id: rootId,
    locked: true,
    name: "マイドライブ",
    parentId: null,
  };
  const requestedBodies: string[] = [];
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    switch (path) {
      case "/api/folders/tree":
        return route.fulfill({
          headers,
          json: {
            folders: [
              { folder: "", id: rootId, name: root.name, parentId: null },
            ],
          },
        });
      case `/api/folders/${rootId}`:
        return route.fulfill({ headers, json: root });
      case "/api/notes":
        return route.fulfill({ headers, json: { notes: [summary] } });
      case `/api/notes/${owned.id}`:
        requestedBodies.push(owned.id);
        return route.fulfill({ headers, json: owned });
      default:
        return route.fulfill({
          headers,
          json: { error: "No fixture" },
          status: 404,
        });
    }
  });
  await page.goto("/tests/browser/fixtures/storage.html");
  const snapshots = await page.evaluate(async (noteId) => {
    const prefetchUrl = "/src/lib/mydrive-prefetch.ts";
    const storageUrl = "/src/lib/offline-cache.ts";
    const { prefetchMyDrive } = await import(prefetchUrl);
    const { openOfflineCache } = await import(storageUrl);
    const viewer = {
      cacheViewerId: "alice",
      mode: "authenticated",
      user: {
        displayName: "Alice",
        email: "alice@example.test",
        id: "alice",
      },
    };
    const pending = prefetchMyDrive(viewer);
    // The storage open is asynchronous. Mutate both the association and
    // nested user after entry, without freezing or replacing the input object.
    viewer.cacheViewerId = "bob";
    viewer.user.id = "bob";
    viewer.user.displayName = "Bob";
    const result = await pending;
    const alice = await openOfflineCache({ userId: "alice" });
    const bob = await openOfflineCache({ userId: "bob" });
    try {
      return {
        alice: (await alice.getNote(noteId))?.note ?? null,
        bob: await bob.getNote(noteId),
        inputUser: viewer.user.id,
        result,
      };
    } finally {
      alice.close();
      bob.close();
    }
  }, owned.id);
  expect(snapshots.alice).toEqual(owned);
  expect(snapshots.bob).toBeNull();
  expect(snapshots.inputUser).toBe("bob");
  expect(snapshots.result.status).toBe("success");
  expect(requestedBodies).toEqual([owned.id]);
});
