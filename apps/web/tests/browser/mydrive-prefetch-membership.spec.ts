import { expect, test } from "@playwright/test";
import { note } from "./fixtures/note.ts";

const headers = { "X-MiyulabMD-Session-User": "user:alice" };

test("a second complete listing replaces MyDrive membership without denying valid bodies", async ({
  page,
}) => {
  const root = {
    ...note.access,
    children: [
      {
        folder: "removed",
        id: "removed",
        name: "Removed folder",
        parentId: "root",
      },
    ],
    crumbs: [{ id: "root", name: "MyDrive" }],
    folder: "",
    id: "root",
    locked: true,
    name: "MyDrive",
    parentId: null,
  };
  const child = {
    ...root,
    children: [],
    folder: "removed",
    id: "removed",
    locked: false,
    name: "Removed folder",
    parentId: "root",
  };
  const retained = {
    ...note,
    folderId: "root",
    id: "retained",
    shortId: "retained-short",
    title: "Retained note",
  };
  const removed = {
    ...note,
    folderId: "root",
    id: "removed-note",
    shortId: "removed-short",
    title: "Removed note",
  };
  const moved = {
    ...note,
    folderId: "removed",
    id: "moved",
    shortId: "moved-short",
    title: "Moved note",
  };
  let cycle = 1;
  let offline = false;
  const requests: string[] = [];
  await page.route("**/api/**", (route) => {
    if (offline) {
      return route.abort("internetdisconnected");
    }
    const path = new URL(route.request().url()).pathname;
    requests.push(path);
    const folders = cycle === 1 ? [root, child] : [{ ...root, children: [] }];
    const bodies =
      cycle === 1
        ? [retained, removed, moved]
        : [
            retained,
            {
              ...moved,
              folderId: "shared-outside",
              ownerId: "bob",
              updatedAt: 3,
            },
          ];
    if (path === "/api/folders/tree") {
      return route.fulfill({ headers, json: { folders } });
    }
    if (path === "/api/notes") {
      return route.fulfill({ headers, json: { notes: bodies } });
    }
    const folder = folders.find((item) => path === `/api/folders/${item.id}`);
    if (folder) {
      return route.fulfill({ headers, json: folder });
    }
    const body = bodies.find((item) => path === `/api/notes/${item.id}`);
    return route.fulfill({
      headers,
      json: body ?? {},
      status: body ? 200 : 404,
    });
  });
  await page.goto("/tests/browser/fixtures/storage.html");
  const acquire = () =>
    page.evaluate(async () => {
      const url = "/src/lib/mydrive-prefetch.ts";
      const { prefetchMyDrive } = await import(url);
      return prefetchMyDrive({
        cacheViewerId: "alice",
        mode: "authenticated",
        user: {
          displayName: "Alice",
          email: "alice@example.test",
          id: "alice",
        },
      });
    });
  expect((await acquire()).status).toBe("success");
  // A foreground read can retain a still-readable shared body even after
  // that note leaves MyDrive. Absence from the next list is not a denial.
  const sharedBody = { ...removed, folderId: "shared-outside", ownerId: "bob" };
  await page.evaluate(async (body) => {
    const url = "/src/lib/offline-cache.ts";
    const { openOfflineCache } = await import(url);
    const cache = await openOfflineCache({ userId: "alice" });
    try {
      await cache.putNote(body);
    } finally {
      cache.close();
    }
  }, sharedBody);
  cycle = 2;
  requests.length = 0;
  expect((await acquire()).status).toBe("success");
  expect(requests).toEqual([
    "/api/folders/tree",
    "/api/folders/root",
    "/api/notes",
  ]);
  const cached = await page.evaluate(async () => {
    const url = "/src/lib/offline-cache.ts";
    const { openOfflineCache, persistCachedViewerId } = await import(url);
    await persistCachedViewerId("alice");
    const cache = await openOfflineCache({ userId: "alice" });
    try {
      return {
        children: (await cache.getFolder(null))?.folder.children,
        ids: (await cache.getNoteList())?.notes.map(
          (item: { id: string }) => item.id,
        ),
        moved: (await cache.getNote("moved"))?.note.id,
        removed: (await cache.getNote("removed-note"))?.note,
      };
    } finally {
      cache.close();
    }
  });
  expect(cached).toEqual({
    children: [],
    ids: ["retained", "moved"],
    moved: "moved",
    removed: sharedBody,
  });
  offline = true;
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Retained note" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Removed note" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Moved note" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Removed folder" })).toHaveCount(
    0,
  );
});
