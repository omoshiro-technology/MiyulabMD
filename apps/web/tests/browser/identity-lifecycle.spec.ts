import { expect, test } from "@playwright/test";
import { note } from "./fixtures/note.ts";

test("verified startup Alice to Bob removes Alice before publishing Bob", async ({
  page,
}) => {
  await page.goto("/tests/browser/fixtures/storage.html");
  await page.evaluate(async (note) => {
    const url = "/src/lib/offline-cache.ts";
    const { openOfflineCache, persistCachedViewerId } = await import(url);
    await persistCachedViewerId("alice");
    const cache = await openOfflineCache({ userId: "alice" });
    await cache.putNote(note);
    cache.close();
  }, note);
  await page.route("**/api/me", (route) =>
    route.fulfill({
      headers: { "X-MiyulabMD-Session-User": "user:bob" },
      json: {
        user: { displayName: "Bob", email: "bob@example.test", id: "bob" },
      },
    }),
  );
  const result = await page.evaluate(async (id) => {
    const viewerUrl = "/src/lib/viewer-context.ts";
    const cacheUrl = "/src/lib/offline-cache.ts";
    const { resolveViewerContext } = await import(viewerUrl);
    const { openOfflineCache, readCachedViewerId } = await import(cacheUrl);
    const viewer = await resolveViewerContext();
    const cache = await openOfflineCache({ userId: "alice" });
    try {
      return {
        oldNote: await cache.getNote(id),
        remembered: await readCachedViewerId(),
        viewer,
      };
    } finally {
      cache.close();
    }
  }, note.id);
  expect(result.oldNote).toBeNull();
  expect(result.remembered).toBe("bob");
  expect(result.viewer).toMatchObject({
    mode: "authenticated",
    user: { id: "bob" },
  });
});

test("unavailable local identity storage does not block a verified online viewer", async ({
  page,
}) => {
  await page.addInitScript(() => {
    IDBFactory.prototype.open = () => {
      throw new DOMException("Local storage unavailable", "UnknownError");
    };
  });
  await page.route("**/api/**", (route) => {
    const headers = { "X-MiyulabMD-Session-User": "user:bob" };
    if (new URL(route.request().url()).pathname === "/api/me") {
      return route.fulfill({
        headers,
        json: {
          user: {
            displayName: "Bob",
            email: "bob@example.test",
            id: "bob",
          },
        },
      });
    }
    return route.fulfill({ headers, json: [] });
  });
  await page.goto("/tests/browser/fixtures/app-shell.html");
  const viewer = page.getByLabel("Viewer context");
  await expect(viewer).toContainText('"mode":"authenticated"');
  await expect(viewer).toContainText('"id":"bob"');
  await expect(viewer).toContainText('"cacheViewerId":null');
  await expect(page.getByRole("alert")).toBeVisible();
});

test("verified checks preserve the same viewer buffer and switch away from Alice in both tabs", async ({
  page,
  context,
}) => {
  let actor = "alice";
  let checks = 0;
  await context.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/me") {
      checks += 1;
      return route.fulfill({
        headers: { "X-MiyulabMD-Session-User": `user:${actor}` },
        json: {
          user: {
            displayName: actor,
            email: `${actor}@example.test`,
            id: actor,
          },
        },
      });
    }
    return route.fulfill({
      headers: { "X-MiyulabMD-Session-User": `user:${actor}` },
      json: [],
    });
  });
  await page.goto("/tests/browser/fixtures/app-shell.html");
  const peer = await context.newPage();
  await peer.goto("/tests/browser/fixtures/app-shell.html");
  const viewer = (target: typeof page) => target.getByLabel("Viewer context");
  await expect(viewer(page)).toContainText('"id":"alice"');
  await expect(viewer(peer)).toContainText('"id":"alice"');
  await page.getByLabel("Unsent viewer buffer").fill("do not discard");
  const before = checks;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(() => checks).toBeGreaterThan(before);
  await expect(page.getByLabel("Unsent viewer buffer")).toHaveValue(
    "do not discard",
  );
  await page.evaluate(async () => {
    const url = "/src/lib/offline-cache.ts";
    const { clearOfflineCacheUser } = await import(url);
    await clearOfflineCacheUser("alice");
  });
  // Manual cache deletion is not an identity transition.
  await expect(page.getByLabel("Unsent viewer buffer")).toHaveValue(
    "do not discard",
  );
  actor = "bob";
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(viewer(page)).toContainText('"id":"bob"');
  await expect(viewer(peer)).toContainText('"id":"bob"');
  await expect(page.getByLabel("Unsent viewer buffer")).toHaveValue("");
});

test("explicit logout blocks old UI in both tabs, clears captured and confirmed actors, and uses native GET", async ({
  page,
  context,
}) => {
  let loggedOut = false;
  const prepare = Promise.withResolvers<void>();
  let preparations = 0;
  let navigations = 0;
  const late = Promise.withResolvers<void>();
  let noteRequests = 0;
  await context.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const headers = {
      "X-MiyulabMD-Session-User": loggedOut ? "guest" : "user:alice",
    };
    if (path === "/api/me") {
      return route.fulfill({
        headers,
        json: {
          user: loggedOut
            ? null
            : {
                displayName: "Alice",
                email: "alice@example.test",
                id: "alice",
              },
        },
      });
    }
    if (path === `/api/notes/${note.id}`) {
      noteRequests += 1;
      await late.promise;
      return route.fulfill({
        headers: { "X-MiyulabMD-Session-User": "user:alice" },
        json: note,
      });
    }
    return route.fulfill({ headers, json: [] });
  });
  await context.route("**/auth/logout", async (route) => {
    if (route.request().method() === "GET") {
      navigations += 1;
      return route.fulfill({ status: 204 });
    }
    preparations += 1;
    expect(route.request().headers()["x-miyulabmd-logout"]).toBe("prepare");
    await prepare.promise;
    loggedOut = true;
    // Cookie changed after the initiating UI captured Alice.
    return route.fulfill({
      headers: { "X-MiyulabMD-Session-User": "user:bob" },
      json: { ok: true },
    });
  });
  try {
    await page.goto("/tests/browser/fixtures/app-shell.html");
    const peer = await context.newPage();
    await peer.goto("/tests/browser/fixtures/app-shell.html");
    await expect(peer.getByLabel("Viewer context")).toContainText(
      '"id":"alice"',
    );
    await page.evaluate(async (note) => {
      const cacheUrl = "/src/lib/offline-cache.ts";
      const memoryUrl = "/src/lib/note-cache.ts";
      const { openOfflineCache } = await import(cacheUrl);
      const { seedNoteCache, loadNote } = await import(memoryUrl);
      for (const userId of ["alice", "bob"]) {
        const cache = await openOfflineCache({ userId });
        await cache.putNote(note);
        cache.close();
      }
      seedNoteCache(note);
      Object.assign(window, {
        lateMemoryRead: loadNote(note.id, true).catch(() => null),
      });
    }, note);
    await expect.poll(() => noteRequests).toBe(1);
    await page.getByRole("button", { exact: true, name: "Alice" }).click();
    await page
      .getByRole("menuitem", { exact: true, name: "ログアウト" })
      .click();
    await expect(page.getByLabel("Viewer context")).not.toContainText(
      '"id":"alice"',
    );
    await expect(peer.getByLabel("Viewer context")).not.toContainText(
      '"id":"alice"',
    );
    await expect.poll(() => preparations).toBe(1);
    expect(navigations).toBe(0);
    prepare.resolve();
    await expect.poll(() => navigations).toBe(1);
    await expect(peer.getByLabel("Viewer context")).toContainText(
      '"mode":"guest"',
    );
    await expect(peer.getByLabel("Viewer context")).toContainText(
      '"cacheViewerId":null',
    );
    expect(
      await peer.evaluate(async () => {
        const url = "/src/lib/offline-cache.ts";
        const { readCachedViewerId } = await import(url);
        return readCachedViewerId();
      }),
    ).toBeNull();
    late.resolve();
    const caches = await page.evaluate(async (id) => {
      await (window as Window & { lateMemoryRead: Promise<unknown> })
        .lateMemoryRead;
      const cacheUrl = "/src/lib/offline-cache.ts";
      const memoryUrl = "/src/lib/note-cache.ts";
      const { openOfflineCache } = await import(cacheUrl);
      const { peekNote } = await import(memoryUrl);
      const persisted: unknown[] = [];
      for (const userId of ["alice", "bob"]) {
        const cache = await openOfflineCache({ userId });
        persisted.push(await cache.getNote(id));
        cache.close();
      }
      return { memory: peekNote(id) ?? null, persisted };
    }, note.id);
    expect(caches).toEqual({ memory: null, persisted: [null, null] });
  } finally {
    prepare.resolve();
    late.resolve();
  }
});

test("identity clear prevents pending list and folder reads restoring memory", async ({
  page,
}) => {
  const release = Promise.withResolvers<void>();
  let reads = 0;
  await page.route("**/api/**", async (route) => {
    reads += 1;
    await release.promise;
    return route.fulfill({
      headers: { "X-MiyulabMD-Session-User": "user:alice" },
      json:
        new URL(route.request().url()).pathname === "/api/notes"
          ? { notes: [note] }
          : { id: "folder-1", name: "private" },
    });
  });
  try {
    await page.goto("/tests/browser/fixtures/storage.html");
    await page.evaluate(async (note) => {
      const url = "/src/lib/list-cache.ts";
      const { loadNotes, loadFolder, upsertNoteSummary } = await import(url);
      upsertNoteSummary(note);
      Object.assign(window, {
        lateListReads: Promise.allSettled([
          loadNotes(true),
          loadFolder("folder-1"),
        ]),
      });
    }, note);
    await expect.poll(() => reads).toBe(2);
    await page.evaluate(async () => {
      const url = "/src/lib/identity-lifecycle.ts";
      const { clearIdentityCache } = await import(url);
      await clearIdentityCache("alice");
    });
    release.resolve();
    const result = await page.evaluate(async () => {
      await (window as Window & { lateListReads: Promise<unknown> })
        .lateListReads;
      const url = "/src/lib/list-cache.ts";
      const { peekNotes, peekFolder } = await import(url);
      return { folder: peekFolder("folder-1") ?? null, notes: peekNotes() };
    });
    expect(result).toEqual({ folder: null, notes: null });
  } finally {
    release.resolve();
  }
});

for (const failure of [
  "server unreachable",
  "storage deletion fails",
] as const) {
  test(`logout ${failure} releases the identity gate and recovers the still-valid session`, async ({
    page,
    context,
  }) => {
    let preparations = 0;
    let navigations = 0;
    let meRequests = 0;
    await context.route("**/api/**", (route) => {
      if (new URL(route.request().url()).pathname === "/api/me") {
        meRequests += 1;
      }
      return route.fulfill({
        headers: { "X-MiyulabMD-Session-User": "user:alice" },
        json:
          new URL(route.request().url()).pathname === "/api/me"
            ? {
                user: {
                  displayName: "Alice",
                  email: "alice@example.test",
                  id: "alice",
                },
              }
            : [],
      });
    });
    await context.route("**/auth/logout", (route) => {
      if (route.request().method() === "GET") {
        navigations += 1;
      } else {
        preparations += 1;
      }
      return route.abort("internetdisconnected");
    });
    await page.goto("/tests/browser/fixtures/app-shell.html");
    const peer = await context.newPage();
    await peer.goto("/tests/browser/fixtures/app-shell.html");
    await expect(peer.getByLabel("Viewer context")).toContainText(
      '"id":"alice"',
    );
    if (failure === "storage deletion fails") {
      await page.evaluate(() => {
        navigator.storage.getDirectory = () =>
          Promise.reject(new DOMException("Denied", "NotAllowedError"));
      });
    }
    const checksBefore = meRequests;
    await page.getByRole("button", { exact: true, name: "Alice" }).click();
    await page
      .getByRole("menuitem", { exact: true, name: "ログアウト" })
      .click();
    // A failed logout leaves the session valid: the identity gate must be
    // released so /api/me flies again and both tabs return to Alice instead
    // of staying blocked until a reload.
    for (const target of [page, peer]) {
      await expect(target.getByLabel("Viewer context")).toContainText(
        '"id":"alice"',
      );
    }
    await expect.poll(() => meRequests).toBeGreaterThan(checksBefore);
    expect(preparations).toBe(failure === "server unreachable" ? 1 : 0);
    expect(navigations).toBe(0);
  });
}
