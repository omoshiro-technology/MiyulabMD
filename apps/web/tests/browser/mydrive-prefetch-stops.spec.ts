import { expect, test } from "@playwright/test";
import { note } from "./fixtures/note.ts";

const headers = { "X-MiyulabMD-Session-User": "user:alice" };

for (const boundary of ["storage", "auth", "close"] as const) {
  test(`prefetch classifies the ${boundary} stop without discarding committed data`, async ({
    page,
  }) => {
    const rootId = "alice-root";
    const owned = { ...note, folderId: rootId };
    const { markdown: _markdown, ...summary } = owned;
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
    let bodyRequests = 0;
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
          return boundary === "auth"
            ? route.fulfill({
                headers,
                json: { error: "Session expired" },
                status: 401,
              })
            : route.fulfill({ headers, json: { notes: [summary] } });
        case `/api/notes/${owned.id}`:
          bodyRequests += 1;
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
    const snapshot = await page.evaluate(
      async ({ boundary, noteId }) => {
        const prefetchUrl = "/src/lib/mydrive-prefetch.ts";
        const storageUrl = "/src/lib/offline-cache.ts";
        const { prefetchMyDrive } = await import(prefetchUrl);
        const { openOfflineCache } = await import(storageUrl);
        const controller = new AbortController();
        const originalPut = IDBObjectStore.prototype.put;
        const originalClose = IDBDatabase.prototype.close;
        IDBObjectStore.prototype.put = function (
          this: IDBObjectStore,
          ...args: Parameters<IDBObjectStore["put"]>
        ) {
          if (boundary === "storage" && this.name === "folders") {
            throw new Error("Injected storage failure, not a network error");
          }
          return originalPut.apply(this, args);
        };
        IDBDatabase.prototype.close = function (this: IDBDatabase) {
          originalClose.call(this);
          if (boundary === "close") {
            controller.abort({ message: "Read lifetime ended at close" });
          }
        };
        let result: unknown;
        try {
          result = await prefetchMyDrive(
            {
              cacheViewerId: "alice",
              mode: "authenticated",
              user: {
                displayName: "Alice",
                email: "alice@example.test",
                id: "alice",
              },
            },
            { signal: controller.signal },
          );
        } finally {
          IDBObjectStore.prototype.put = originalPut;
          IDBDatabase.prototype.close = originalClose;
        }
        const cache = await openOfflineCache({ userId: "alice" });
        try {
          return {
            note: (await cache.getNote(noteId))?.note ?? null,
            result,
            root: (await cache.getFolder(null))?.folder.id ?? null,
          };
        } finally {
          cache.close();
        }
      },
      { boundary, noteId: owned.id },
    );
    expect(snapshot.result).toMatchObject({
      reason: boundary === "close" ? "aborted" : boundary,
      status: "stopped",
    });
    expect(snapshot.root).toBe(boundary === "storage" ? null : rootId);
    expect(snapshot.note).toEqual(boundary === "close" ? owned : null);
    expect(bodyRequests).toBe(boundary === "close" ? 1 : 0);
  });
}
