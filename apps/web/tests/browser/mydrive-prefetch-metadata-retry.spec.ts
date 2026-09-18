import { expect, test } from "@playwright/test";
import { note } from "./fixtures/note.ts";

for (const boundary of [
  "tree",
  "folder",
  "list",
  "folder-exhausted",
] as const) {
  test(`metadata acquisition retries ${boundary} without discarding independent data`, async ({
    page,
  }) => {
    const rootId = "alice-root";
    const owned = { ...note, folderId: rootId };
    const pathFor = {
      folder: `/api/folders/${rootId}`,
      "folder-exhausted": `/api/folders/${rootId}`,
      list: "/api/notes",
      tree: "/api/folders/tree",
    }[boundary];
    const attempts: number[] = [];
    await page.route("**/api/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === pathFor) {
        attempts.push(Date.now());
        if (attempts.length === 1 || boundary === "folder-exhausted") {
          return route.fulfill({
            headers: { "X-MiyulabMD-Session-User": "user:alice" },
            json: { error: "Down" },
            status: 503,
          });
        }
      }
      switch (path) {
        case "/api/folders/tree":
          return route.fulfill({
            headers: { "X-MiyulabMD-Session-User": "user:alice" },
            json: {
              folders: [{ id: rootId, name: "MyDrive", parentId: null }],
            },
          });
        case `/api/folders/${rootId}`:
          return route.fulfill({
            headers: { "X-MiyulabMD-Session-User": "user:alice" },
            json: {
              ...note.access,
              children: [],
              crumbs: [],
              id: rootId,
              name: "MyDrive",
              parentId: null,
            },
          });
        case "/api/notes":
          return route.fulfill({
            headers: { "X-MiyulabMD-Session-User": "user:alice" },
            json: { notes: [owned] },
          });
        default:
          return route.fulfill({
            headers: { "X-MiyulabMD-Session-User": "user:alice" },
            json: owned,
          });
      }
    });
    await page.goto("/tests/browser/fixtures/storage.html");
    const result = await page.evaluate(async () => {
      const url = "/src/lib/mydrive-prefetch.ts";
      const { prefetchMyDrive } = await import(url);
      return prefetchMyDrive({
        cacheViewerId: "alice",
        mode: "authenticated",
        user: { displayName: "Alice", email: "a@example.test", id: "alice" },
      });
    });
    expect(attempts).toHaveLength(2);
    expect(attempts[1] - attempts[0]).toBeGreaterThanOrEqual(450);
    expect(result).toEqual(
      boundary === "folder-exhausted"
        ? { folders: 0, notes: 1, reason: "network", status: "stopped" }
        : { folders: 1, notes: 1, status: "success" },
    );
  });
}
