import { expect, test } from "@playwright/test";
import { note } from "./fixtures/note.ts";

const headers = { "X-MiyulabMD-Session-User": "user:alice" };

for (const status of [403, 404]) {
  test(`prefetch ${status} denies only that note and still acquires an independent note`, async ({
    page,
  }) => {
    const rootId = "alice-root";
    const denied = { ...note, folderId: rootId };
    const independent = {
      ...denied,
      id: "independent-note",
      shortId: "independent-short",
      title: "別のノート",
    };
    const summaries = [denied, independent].map(
      ({ markdown: _markdown, ...summary }) => summary,
    );
    const root = {
      ...note.access,
      children: [],
      crumbs: [],
      folder: "",
      id: rootId,
      locked: true,
      name: "マイドライブ",
      parentId: null,
    };
    let accessRestored = false;
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
          return route.fulfill({ headers, json: { notes: summaries } });
        case `/api/notes/${denied.id}`:
          return accessRestored
            ? route.fulfill({ headers, json: denied })
            : route.fulfill({ headers, json: { error: "No access" }, status });
        case `/api/notes/${independent.id}`:
          return route.fulfill({ headers, json: independent });
        default:
          return route.fulfill({
            headers,
            json: { error: "No fixture" },
            status: 404,
          });
      }
    });
    await page.goto("/tests/browser/fixtures/storage.html");
    const outcome = await page.evaluate(async (denied) => {
      const storageUrl = "/src/lib/offline-cache.ts";
      const prefetchUrl = "/src/lib/mydrive-prefetch.ts";
      const { openOfflineCache } = await import(storageUrl);
      const { prefetchMyDrive } = await import(prefetchUrl);
      const cache = await openOfflineCache({ userId: "alice" });
      try {
        await cache.putNote({ ...denied, updatedAt: 0 });
      } finally {
        cache.close();
      }
      return prefetchMyDrive({
        cacheViewerId: "alice",
        mode: "authenticated",
        user: {
          displayName: "Alice",
          email: "alice@example.test",
          id: "alice",
        },
      });
    }, denied);
    await page.reload();
    const snapshots = await page.evaluate(
      async ({ deniedId, otherId }) => {
        const storageUrl = "/src/lib/offline-cache.ts";
        const { openOfflineCache } = await import(storageUrl);
        const cache = await openOfflineCache({ userId: "alice" });
        try {
          return {
            denied: await cache.getNote(deniedId),
            independent: (await cache.getNote(otherId))?.note ?? null,
          };
        } finally {
          cache.close();
        }
      },
      { deniedId: denied.id, otherId: independent.id },
    );
    expect(snapshots.denied).toBeNull();
    expect(snapshots.independent).toEqual(independent);
    expect(outcome.reason).not.toBe("auth");

    accessRestored = true;
    const restored = await page.evaluate(async (noteId) => {
      const prefetchUrl = "/src/lib/mydrive-prefetch.ts";
      const storageUrl = "/src/lib/offline-cache.ts";
      const { prefetchMyDrive } = await import(prefetchUrl);
      const { openOfflineCache } = await import(storageUrl);
      await prefetchMyDrive({
        cacheViewerId: "alice",
        mode: "authenticated",
        user: {
          displayName: "Alice",
          email: "alice@example.test",
          id: "alice",
        },
      });
      const cache = await openOfflineCache({ userId: "alice" });
      try {
        return (await cache.getNote(noteId))?.note ?? null;
      } finally {
        cache.close();
      }
    }, denied.id);
    expect(restored).toEqual(denied);
  });
}
