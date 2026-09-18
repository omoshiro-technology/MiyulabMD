import { expect, test } from "@playwright/test";
import { note } from "./fixtures/note.ts";

const headers = { "X-MiyulabMD-Session-User": "user:alice" };

test("two authenticated tabs share one background prefetch and release ownership", async ({
  context,
  page,
}) => {
  const rootId = "alice-root";
  let currentNote = {
    ...note,
    folderId: rootId,
    title: "複数タブの資料",
  };
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
  const firstStarted = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const treeRequests: string[] = [];
  const bodyRequests: string[] = [];
  await context.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const tab = route.request().frame().page() === page ? "leader" : "follower";
    switch (path) {
      case "/api/me":
        return route.fulfill({
          headers,
          json: {
            user: {
              displayName: "Alice",
              email: "alice@example.test",
              id: "alice",
            },
          },
        });
      case "/api/auth/config":
        return route.fulfill({ headers, json: { access: false, mock: true } });
      case "/api/folders/tree":
        treeRequests.push(tab);
        if (treeRequests.length === 1) {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
        return route.fulfill({
          headers,
          json: {
            folders: [
              { folder: "", id: rootId, name: root.name, parentId: null },
            ],
          },
        });
      case "/api/folders":
      case `/api/folders/${rootId}`:
        return route.fulfill({ headers, json: root });
      case "/api/notes": {
        const { markdown: _markdown, ...summary } = currentNote;
        return route.fulfill({ headers, json: { notes: [summary] } });
      }
      case `/api/notes/${note.id}`:
        bodyRequests.push(tab);
        return route.fulfill({ headers, json: currentNote });
      default:
        return route.fulfill({
          headers,
          json: { error: "No fixture" },
          status: 404,
        });
    }
  });

  await page.goto("/");
  await firstStarted.promise;
  const follower = await context.newPage();
  try {
    await follower.bringToFront();
    await follower.goto("/");
    await expect(
      follower.getByRole("link", { name: currentNote.title }),
    ).toBeVisible();
    await expect(
      follower.getByRole("button", { name: "新規ノート" }),
    ).toBeVisible();
    const observationWindow = await follower.evaluate(async () => {
      const coordinatorUrl = "/src/lib/mydrive-prefetch-coordinator.ts";
      const { PREFETCH_DEBOUNCE_MS, PREFETCH_MIN_INTERVAL_MS } = await import(
        coordinatorUrl
      );
      return PREFETCH_DEBOUNCE_MS + PREFETCH_MIN_INTERVAL_MS + 100;
    });
    // The first cycle is deliberately held. Observe beyond both deadlines so
    // the second real app tab has had a chance to attempt its startup work.
    await follower.waitForTimeout(observationWindow);
    expect(treeRequests).toEqual(["leader"]);
    expect(bodyRequests).toEqual([]);

    releaseFirst.resolve();
    const readBody = () =>
      follower.evaluate(async (noteId) => {
        const storageUrl = "/src/lib/offline-cache.ts";
        const { openOfflineCache } = await import(storageUrl);
        const cache = await openOfflineCache({ userId: "alice" });
        try {
          return (await cache.getNote(noteId))?.note.markdown ?? null;
        } finally {
          cache.close();
        }
      }, note.id);
    await expect.poll(readBody).toBe(currentNote.markdown);
    expect(bodyRequests).toEqual(["leader"]);
    expect(treeRequests).toEqual(["leader"]);

    await page.close();
    currentNote = {
      ...currentNote,
      markdown: "所有タブの終了後に取得した新しい本文。",
      updatedAt: currentNote.updatedAt + 1,
    };
    await follower.evaluate(() => {
      window.dispatchEvent(new Event("online"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect.poll(readBody, { timeout: 10_000 }).toBe(currentNote.markdown);
    expect(treeRequests).toEqual(["leader", "follower"]);
    expect(bodyRequests).toEqual(["leader", "follower"]);

    currentNote = { ...currentNote, updatedAt: currentNote.updatedAt + 1 };
    await follower.evaluate(() => {
      Object.defineProperty(navigator, "locks", {
        configurable: true,
        value: undefined,
      });
      window.dispatchEvent(new Event("online"));
    });
    // Without cross-tab exclusion support, background work is skipped rather
    // than silently falling back to uncoordinated acquisition.
    await follower.waitForTimeout(observationWindow);
    expect(treeRequests).toEqual(["leader", "follower"]);
    expect(bodyRequests).toEqual(["leader", "follower"]);
    await expect(
      follower.getByRole("button", { name: "新規ノート" }),
    ).toBeVisible();
  } finally {
    releaseFirst.resolve();
    await follower.close();
  }
});
