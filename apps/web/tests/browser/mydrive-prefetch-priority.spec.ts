import { expect, test } from "@playwright/test";
import { note } from "./fixtures/note.ts";

const headers = { "X-MiyulabMD-Session-User": "user:alice" };

for (const destination of [
  "/f/child",
  "/n/preferred",
  "/n/preferred-short",
  "/s/preferred-short",
]) {
  test(`same-tab navigation to ${destination} reprioritizes pending acquisition`, async ({
    page,
  }) => {
    const folders = ["root", "ordinary", "child"].map((id) => ({
      ...note.access,
      children: [],
      crumbs: [{ id: "root", name: "MyDrive" }],
      folder: id === "root" ? "" : id,
      id,
      locked: id === "root",
      name: id,
      parentId: id === "root" ? null : "root",
    }));
    const bodies = [
      {
        ...note,
        folderId: "ordinary",
        id: "ordinary",
        shortId: "ordinary-short",
      },
      {
        ...note,
        folderId: "child",
        id: "preferred",
        shortId: "preferred-short",
      },
      { ...note, folderId: "ordinary", id: "later", shortId: "later-short" },
      { ...note, folderId: "child", id: "shared", ownerId: "bob" },
      { ...note, folderId: "outside", id: "outside" },
      { ...note, folderId: null, id: "unfiled" },
    ];
    const requests: string[] = [];
    let releaseTree!: () => void;
    const treeGate = new Promise<void>((resolve) => {
      releaseTree = resolve;
    });
    let releaseBody!: () => void;
    const bodyGate = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      requests.push(path);
      if (path === "/api/folders/tree") {
        await treeGate;
        return route.fulfill({ headers, json: { folders } });
      }
      if (path === "/api/notes") {
        return route.fulfill({ headers, json: { notes: bodies } });
      }
      const folder = folders.find(
        (entry) => path === `/api/folders/${entry.id}`,
      );
      if (folder) {
        return route.fulfill({ headers, json: folder });
      }
      const body = bodies.find((entry) => path === `/api/notes/${entry.id}`);
      if (body?.id === "preferred") {
        await bodyGate;
      }
      return route.fulfill({
        headers,
        json: body ?? {},
        status: body ? 200 : 404,
      });
    });
    await page.goto("/tests/browser/fixtures/storage.html");
    await page.evaluate(async () => {
      const url = "/src/lib/mydrive-prefetch-coordinator.ts";
      const { attachMyDrivePrefetchCoordinator } = await import(url);
      const coordinator = attachMyDrivePrefetchCoordinator({
        cacheViewerId: "alice",
        mode: "authenticated",
        user: {
          displayName: "Alice",
          email: "alice@example.test",
          id: "alice",
        },
      });
      (window as Window & { stopPrefetch: () => void }).stopPrefetch =
        coordinator.dispose;
    });
    await expect.poll(() => requests).toEqual(["/api/folders/tree"]);
    await page.evaluate((path) => history.pushState({}, "", path), destination);
    releaseTree();
    await expect
      .poll(() => requests.filter((path) => path.startsWith("/api/notes/")))
      .toHaveLength(1);
    // No other background request can pass the held body, even when the
    // selected route changes. The next pending body must follow that change.
    await page.evaluate(() => history.pushState({}, "", "/n/later-short"));
    await page.waitForTimeout(100);
    expect(requests.filter((path) => path.startsWith("/api/notes/"))).toEqual([
      "/api/notes/preferred",
    ]);
    releaseBody();
    await expect
      .poll(() => requests.filter((path) => path.startsWith("/api/notes/")))
      .toHaveLength(3);
    expect(requests.filter((path) => path.startsWith("/api/notes/"))).toEqual([
      "/api/notes/preferred",
      "/api/notes/later",
      "/api/notes/ordinary",
    ]);
    if (destination.startsWith("/f/")) {
      expect(requests[1]).toBe("/api/folders/child");
    }
    expect(requests.indexOf("/api/notes/preferred")).toBeGreaterThan(
      requests.indexOf("/api/notes"),
    );
    const root = await page.evaluate(async () => {
      const url = "/src/lib/offline-cache.ts";
      const { openOfflineCache } = await import(url);
      const cache = await openOfflineCache({ userId: "alice" });
      try {
        return (await cache.getFolder(null))?.folder.id;
      } finally {
        cache.close();
        (window as Window & { stopPrefetch: () => void }).stopPrefetch();
      }
    });
    expect(root).toBe("root");
  });
}
