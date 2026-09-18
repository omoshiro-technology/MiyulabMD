import { expect, test } from "@playwright/test";
import { note } from "./fixtures/note.ts";

const headers = { "X-MiyulabMD-Session-User": "user:alice" };

for (const trigger of ["online", "visibilitychange"] as const) {
  test(`a ${trigger} burst schedules one cycle after startup's transient retry`, async ({
    page,
  }) => {
    const rootId = "alice-root";
    const owned = {
      ...note,
      folderId: rootId,
      title: "復帰後に取得するノート",
    };
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
    let cycles = 0;
    let bodies = 0;
    await page.route("**/api/**", (route) => {
      const path = new URL(route.request().url()).pathname;
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
          return route.fulfill({
            headers,
            json: { access: false, mock: true },
          });
        case "/api/folders/tree":
          cycles += 1;
          return cycles === 1
            ? route.abort("internetdisconnected")
            : route.fulfill({
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
        case "/api/notes":
          return route.fulfill({ headers, json: { notes: [summary] } });
        case `/api/notes/${owned.id}`:
          bodies += 1;
          return route.fulfill({ headers, json: owned });
        default:
          return route.fulfill({
            headers,
            json: { error: "No fixture" },
            status: 404,
          });
      }
    });
    const firstFailure = page.waitForEvent("requestfailed", {
      predicate: (request) =>
        new URL(request.url()).pathname === "/api/folders/tree",
    });
    await page.goto("/");
    await firstFailure;
    await expect(page.getByRole("link", { name: owned.title })).toBeVisible();
    // The first transient failure is retried inside the startup cycle. Wait
    // for its actual cached body, rather than racing that retry with UI paint.
    await expect
      .poll(
        () =>
          page.evaluate(async (noteId) => {
            const moduleUrl = "/src/lib/offline-cache.ts";
            const { openOfflineCache } = await import(moduleUrl);
            const cache = await openOfflineCache({ userId: "alice" });
            try {
              return (await cache.getNote(noteId))?.note.markdown ?? null;
            } finally {
              cache.close();
            }
          }, owned.id),
        { timeout: 10_000 },
      )
      .toBe(owned.markdown);
    expect(cycles).toBe(2);
    expect(bodies).toBe(1);
    await page.evaluate((trigger) => {
      const target = trigger === "online" ? window : document;
      for (let index = 0; index < 3; index += 1) {
        target.dispatchEvent(new Event(trigger));
      }
    }, trigger);
    await expect.poll(() => cycles).toBe(3);
    const observationWindow = await page.evaluate(async () => {
      const moduleUrl = "/src/lib/mydrive-prefetch-coordinator.ts";
      const { PREFETCH_DEBOUNCE_MS, PREFETCH_MIN_INTERVAL_MS } = await import(
        moduleUrl
      );
      return PREFETCH_DEBOUNCE_MS + PREFETCH_MIN_INTERVAL_MS + 100;
    });
    await page.waitForTimeout(observationWindow);
    expect(cycles).toBe(3);
    expect(bodies).toBe(1);
    await expect(
      page.getByRole("button", { name: "新規ノート" }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
  });
}

test("events during acquisition queue one later cycle and disposal prevents another", async ({
  page,
}) => {
  const rootId = "alice-root";
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
  let cycles = 0;
  let previousCycleCommitted: boolean | null = null;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/folders/tree") {
      cycles += 1;
      if (cycles === 1) {
        firstStarted.resolve();
        await releaseFirst.promise;
      } else if (cycles === 2) {
        previousCycleCommitted = await page.evaluate(async () => {
          const storageUrl = "/src/lib/offline-cache.ts";
          const { openOfflineCache } = await import(storageUrl);
          const cache = await openOfflineCache({ userId: "alice" });
          try {
            return Boolean(
              (await cache.getFolder(null)) && (await cache.getNoteList()),
            );
          } finally {
            cache.close();
          }
        });
      }
      return route.fulfill({
        headers,
        json: {
          folders: [
            { folder: "", id: rootId, name: root.name, parentId: null },
          ],
        },
      });
    }
    if (path === `/api/folders/${rootId}`) {
      return route.fulfill({ headers, json: root });
    }
    if (path === "/api/notes") {
      return route.fulfill({ headers, json: { notes: [] } });
    }
    return route.fulfill({
      headers,
      json: { error: "No fixture" },
      status: 404,
    });
  });
  await page.goto("/tests/browser/fixtures/storage.html");
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
  try {
    await firstStarted.promise;
    await page.evaluate(() => {
      for (let index = 0; index < 3; index += 1) {
        window.dispatchEvent(new Event("online"));
        document.dispatchEvent(new Event("visibilitychange"));
      }
    });
    releaseFirst.resolve();
    await expect.poll(() => previousCycleCommitted).toBe(true);
    expect(cycles).toBe(2);
    await page.evaluate(() => {
      (window as Window & { stopPrefetch: () => void }).stopPrefetch();
      window.dispatchEvent(new Event("online"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    // Observe beyond both scheduling deadlines: disposal must prevent even a
    // queued or newly signalled third cycle, not merely return synchronously.
    await page.waitForTimeout(observationWindow);
    expect(cycles).toBe(2);
  } finally {
    releaseFirst.resolve();
  }
});
