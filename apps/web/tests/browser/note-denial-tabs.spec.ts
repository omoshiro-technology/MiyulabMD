import { expect, test } from "@playwright/test";
import { note } from "./fixtures/note.ts";

test("another tab's note denial fences an old response and allows fresh revalidation", async ({
  page,
  context,
}) => {
  await page.goto("/tests/browser/fixtures/storage.html");
  const peer = await context.newPage();
  await peer.goto("/tests/browser/fixtures/storage.html");
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const headers = { "X-MiyulabMD-Session-User": "user:alice" };
  await page.route(`**/api/notes/${note.id}`, async (route) => {
    started.resolve();
    await release.promise;
    await route.fulfill({ headers, json: note });
  });
  let denied = true;
  await peer.route(`**/api/notes/${note.id}`, (route) =>
    route.fulfill({
      headers,
      json: denied
        ? { error: "Forbidden" }
        : { ...note, markdown: "Fresh authorized body", updatedAt: 99 },
      status: denied ? 403 : 200,
    }),
  );
  const read = async (id: string) => {
    const url = "/src/lib/note-read-session.ts";
    const { createNoteReadSession } = await import(url);
    const session = createNoteReadSession({
      cacheViewerId: "alice",
      mode: "authenticated",
      user: { displayName: "Alice", email: "alice@example.test", id: "alice" },
    });
    try {
      return await session.read(id).then(
        (result: { ok: boolean; status?: number }) => ({
          ok: result.ok,
          status: result.status,
        }),
        () => ({ ok: false }),
      );
    } finally {
      session.dispose();
    }
  };
  const cachedBody = async (id: string) => {
    const url = "/src/lib/offline-cache.ts";
    const { openOfflineCache } = await import(url);
    const cache = await openOfflineCache({ userId: "alice" });
    try {
      return (await cache.getNote(id))?.note.markdown ?? null;
    } finally {
      cache.close();
    }
  };
  try {
    const pending = page.evaluate(read, note.id);
    await started.promise;
    expect(await peer.evaluate(read, note.id)).toEqual({
      ok: false,
      status: 403,
    });
    expect(await peer.evaluate(cachedBody, note.id)).toBeNull();
    release.resolve();
    const stale = await pending;
    const restored = await peer.evaluate(cachedBody, note.id);
    expect({ restored, stale: stale.ok }).toEqual({
      restored: null,
      stale: false,
    });
    denied = false;
    expect((await peer.evaluate(read, note.id)).ok).toBe(true);
    // The display read publishes the network note immediately; persisting
    // it (and lifting the denial marker) is detached, so wait for the
    // best-effort write to land before inspecting the cache.
    await expect
      .poll(() => peer.evaluate(cachedBody, note.id))
      .toBe("Fresh authorized body");
  } finally {
    release.resolve();
    await peer.close();
  }
});

test("a post-purge API read never joins a pre-purge transport when messages are missed", async ({
  page,
  context,
}) => {
  await context.addInitScript(() => {
    Object.defineProperty(globalThis, "BroadcastChannel", { value: undefined });
  });
  await page.goto("/tests/browser/fixtures/storage.html");
  const peer = await context.newPage();
  await peer.goto("/tests/browser/fixtures/storage.html");
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let requests = 0;
  await page.route(`**/api/notes/${note.id}`, async (route) => {
    requests += 1;
    const old = requests === 1;
    if (old) {
      started.resolve();
      await release.promise;
    }
    await route.fulfill({
      headers: { "X-MiyulabMD-Session-User": "user:alice" },
      json: { ...note, markdown: old ? "Before purge" : "Fresh after purge" },
    });
  });
  const read = async (id: string) => {
    const url = "/src/lib/api.ts";
    const { fetchNote } = await import(url);
    return fetchNote(id, { viewerId: "alice" });
  };
  try {
    const pending = page.evaluate(read, note.id);
    await started.promise;
    await peer.evaluate(async () => {
      const url = "/src/lib/offline-cache.ts";
      const { clearOfflineCacheUser } = await import(url);
      await clearOfflineCacheUser("alice");
    });
    const fresh = page.evaluate(read, note.id);
    await expect.poll(() => requests).toBe(2);
    release.resolve();
    await pending;
    expect(await fresh).toMatchObject({
      data: { markdown: "Fresh after purge" },
      ok: true,
    });
  } finally {
    release.resolve();
    await peer.close();
  }
});
