import { expect, test } from "@playwright/test";
import { note } from "./fixtures/note.ts";

test("keyboard navigation joins an in-flight background note request", async ({
  page,
}) => {
  const rootId = "alice-root";
  const owned = {
    ...note,
    folderId: rootId,
    markdown: "背景取得と画面表示で共有する本文。",
    title: "取得を共有するノート",
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
  const reading = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let noteRequests = 0;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    switch (path) {
      case "/api/me":
        return route.fulfill({
          headers: { "X-MiyulabMD-Session-User": "user:alice" },
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
          headers: { "X-MiyulabMD-Session-User": "user:alice" },
          json: { access: false, mock: true },
        });
      case "/api/folders/tree":
        return route.fulfill({
          headers: { "X-MiyulabMD-Session-User": "user:alice" },
          json: {
            folders: [
              { folder: "", id: rootId, name: root.name, parentId: null },
            ],
          },
        });
      case "/api/folders":
      case `/api/folders/${rootId}`:
        return route.fulfill({
          headers: { "X-MiyulabMD-Session-User": "user:alice" },
          json: root,
        });
      case "/api/notes":
        return route.fulfill({
          headers: { "X-MiyulabMD-Session-User": "user:alice" },
          json: { notes: [summary] },
        });
      case `/api/notes/${note.id}`:
        noteRequests += 1;
        reading.resolve();
        await release.promise;
        return route.fulfill({
          headers: { "X-MiyulabMD-Session-User": "user:alice" },
          json: owned,
        });
      default:
        return route.fulfill({
          headers: { "X-MiyulabMD-Session-User": "user:alice" },
          json: { error: "No fixture" },
          status: 404,
        });
    }
  });
  try {
    await page.goto("/");
    await reading.promise;
    // Keyboard activation isolates the real Editor read from the separate
    // legacy hover-prefetch path, which is not migrated by this first slice.
    await page.getByRole("link", { name: owned.title }).press("Enter");
    await expect(page).toHaveURL(`/n/${note.id}`);
    await expect(page.getByText("読み込み中…", { exact: true })).toBeVisible();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    release.resolve();
    await expect(page.getByText(owned.markdown, { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { exact: true, name: "Edit" }),
    ).toBeEnabled();
    expect(noteRequests).toBe(1);
  } finally {
    release.resolve();
  }
});

test("a read after denial cannot join the older transport and restore its cached body", async ({
  page,
}) => {
  await page.goto("/tests/browser/fixtures/storage.html");
  const result = await page.evaluate(async (note) => {
    const cacheUrl = "/src/lib/offline-cache.ts";
    const sessionUrl = "/src/lib/note-read-session.ts";
    const { openOfflineCache } = await import(cacheUrl);
    const { createNoteReadSession } = await import(sessionUrl);
    const cache = await openOfflineCache({ userId: "alice" });
    await cache.putNote(note);
    const viewer = {
      cacheViewerId: "alice",
      mode: "authenticated",
      user: {
        displayName: "Alice",
        email: "alice@example.test",
        id: "alice",
      },
    };
    const oldReader = createNoteReadSession(viewer);
    const newReader = createNoteReadSession(viewer);
    const firstStarted = Promise.withResolvers<void>();
    const oldResponse = Promise.withResolvers<Response>();
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = () => {
      requests += 1;
      if (requests === 1) {
        firstStarted.resolve();
        return oldResponse.promise;
      }
      return Promise.resolve(
        new Response(JSON.stringify({ error: "Still forbidden" }), {
          headers: { "X-MiyulabMD-Session-User": "user:alice" },
          status: 403,
        }),
      );
    };
    try {
      const old = oldReader.read(note.id).then(
        (value: { ok: boolean }) => value.ok,
        () => false,
      );
      await firstStarted.promise;
      await cache.denyNote(note.id);
      const fresh = newReader.read(note.id);
      oldResponse.resolve(
        new Response(JSON.stringify(note), {
          headers: { "X-MiyulabMD-Session-User": "user:alice" },
        }),
      );
      const [oldPublished, newResult] = await Promise.all([old, fresh]);
      return {
        cached: await cache.getNote(note.id),
        newResult,
        oldPublished,
        requests,
      };
    } finally {
      oldResponse.resolve(
        new Response(JSON.stringify(note), {
          headers: { "X-MiyulabMD-Session-User": "user:alice" },
        }),
      );
      globalThis.fetch = originalFetch;
      oldReader.dispose();
      newReader.dispose();
      cache.close();
    }
  }, note);
  expect(result.newResult).toMatchObject({ ok: false, status: 403 });
  expect(result.oldPublished).toBe(false);
  expect(result.cached).toBeNull();
  expect(result.requests).toBe(2);
});
