import { expect, test } from "@playwright/test";
import { note } from "./fixtures/note.ts";

const headers = { "X-MiyulabMD-Session-User": "user:alice" };

test("periodic prefetch refreshes visible scopes but skips hidden and disposed scopes", async ({
  page,
}) => {
  const refreshInterval = 5 * 60 * 1000;
  const rootId = "alice-root";
  let currentNote = { ...note, folderId: rootId };
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
  let cycles = 0;
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    switch (path) {
      case "/api/folders/tree":
        cycles += 1;
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
      case "/api/notes": {
        const { markdown: _markdown, ...summary } = currentNote;
        return route.fulfill({ headers, json: { notes: [summary] } });
      }
      case `/api/notes/${note.id}`:
        return route.fulfill({ headers, json: currentNote });
      default:
        return route.fulfill({
          headers,
          json: { error: "No fixture" },
          status: 404,
        });
    }
  });
  await page.goto("/tests/browser/fixtures/storage.html");
  await page.clock.install();
  const observationWindow = await page.evaluate(async () => {
    const coordinatorUrl = "/src/lib/mydrive-prefetch-coordinator.ts";
    const {
      attachMyDrivePrefetchCoordinator,
      PREFETCH_DEBOUNCE_MS,
      PREFETCH_MIN_INTERVAL_MS,
    } = await import(coordinatorUrl);
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
    return PREFETCH_DEBOUNCE_MS + PREFETCH_MIN_INTERVAL_MS + 100;
  });
  const readBody = () =>
    page.evaluate(async (noteId) => {
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
  expect(cycles).toBe(1);

  currentNote = {
    ...currentNote,
    markdown: "定期確認で取得する新しい本文。",
    updatedAt: currentNote.updatedAt + 1,
  };
  await page.clock.fastForward(refreshInterval);
  await expect.poll(readBody, { timeout: 10_000 }).toBe(currentNote.markdown);
  expect(cycles).toBe(2);
  const savedBody = currentNote.markdown;

  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
  });
  currentNote = {
    ...currentNote,
    markdown: "非表示中はまだ取得しない本文。",
    updatedAt: currentNote.updatedAt + 1,
  };
  await page.clock.fastForward(refreshInterval);
  await page.waitForTimeout(observationWindow);
  expect(cycles).toBe(2);
  expect(await readBody()).toBe(savedBody);

  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    (window as Window & { stopPrefetch: () => void }).stopPrefetch();
  });
  await page.clock.fastForward(refreshInterval);
  await page.waitForTimeout(observationWindow);
  expect(cycles).toBe(2);
  expect(await readBody()).toBe(savedBody);
});
