import { expect, test } from "@playwright/test";
import { note } from "./fixtures/note.ts";

test("clearing one user's cache preserves other users and app assets", async ({
  page,
}) => {
  await page.goto("/tests/browser/fixtures/storage.html");
  const result = await page.evaluate(async (note) => {
    const cacheUrl = "/src/lib/offline-cache.ts";
    const {
      clearOfflineCacheUser,
      openOfflineCache,
      persistCachedViewerId,
      readCachedViewerId,
    } = await import(cacheUrl);
    const alice = await openOfflineCache({ userId: "alice" });
    const bob = await openOfflineCache({ userId: "bob" });
    const bobNote = { ...note, markdown: "Bob's body", ownerId: "bob" };
    const { markdown: _markdown, ...summary } = note;
    const folder = {
      ...note.access,
      children: [],
      crumbs: [],
      folder: "",
      id: "alice-root",
      locked: true,
      name: "マイドライブ",
      parentId: null,
    };
    await alice.putNote(note);
    await alice.putNoteList([summary]);
    await alice.putFolder(folder, { asDriveRoot: true });
    await bob.putNote(bobNote);
    await persistCachedViewerId("alice");
    const shell = await caches.open("miyulabmd-precache-clear-test");
    await shell.put("/shell", new Response("app shell"));
    try {
      await clearOfflineCacheUser("alice");
      const root = await navigator.storage.getDirectory();
      const app = await root.getDirectoryHandle("miyulabmd-offline-cache-v1");
      let userDirectoryRemoved = false;
      try {
        await app.getDirectoryHandle("YWxpY2U");
      } catch (error) {
        userDirectoryRemoved =
          error instanceof DOMException && error.name === "NotFoundError";
      }
      const oldHandleRejected = await alice.putNote(note).then(
        () => false,
        () => true,
      );
      const fresh = await openOfflineCache({ userId: "alice" });
      try {
        const after = {
          folder: await fresh.getFolder(null),
          list: await fresh.getNoteList(),
          note: await fresh.getNote(note.id),
        };
        await fresh.putNote({ ...note, markdown: "Explicit later save" });
        return {
          after,
          bob: (await bob.getNote(note.id))?.note,
          fresh: (await fresh.getNote(note.id))?.note.markdown,
          oldHandleRejected,
          rememberedViewer: await readCachedViewerId(),
          shell: await (await shell.match("/shell"))?.text(),
          userDirectoryRemoved,
        };
      } finally {
        fresh.close();
      }
    } finally {
      alice.close();
      bob.close();
    }
  }, note);
  expect(result.after).toEqual({ folder: null, list: null, note: null });
  expect(result.oldHandleRejected).toBe(true);
  expect(result.userDirectoryRemoved).toBe(true);
  expect(result.rememberedViewer).toBeNull();
  expect(result.bob).toEqual({
    ...note,
    markdown: "Bob's body",
    ownerId: "bob",
  });
  expect(result.shell).toBe("app shell");
  expect(result.fresh).toBe("Explicit later save");
});

test("cache clearing invalidates a previously uncached pending note read", async ({
  page,
}) => {
  await page.goto("/tests/browser/fixtures/storage.html");
  const result = await page.evaluate(async (note) => {
    const cacheUrl = "/src/lib/offline-cache.ts";
    const sessionUrl = "/src/lib/note-read-session.ts";
    const { clearOfflineCacheUser, openOfflineCache } = await import(cacheUrl);
    const { createNoteReadSession } = await import(sessionUrl);
    const viewer = {
      cacheViewerId: "alice",
      mode: "authenticated",
      user: { displayName: "Alice", email: "alice@example.test", id: "alice" },
    };
    const late = { ...note, id: "previously-uncached", shortId: "uncached" };
    const started = Promise.withResolvers<void>();
    const response = Promise.withResolvers<Response>();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => {
      started.resolve();
      return response.promise;
    };
    const reader = createNoteReadSession(viewer);
    try {
      const pending = reader.read(late.id).then(
        (value: { ok: boolean }) => value.ok,
        () => false,
      );
      await started.promise;
      await clearOfflineCacheUser("alice");
      response.resolve(
        new Response(JSON.stringify(late), {
          headers: { "X-MiyulabMD-Session-User": "user:alice" },
        }),
      );
      const published = await pending;
      const cache = await openOfflineCache({ userId: "alice" });
      try {
        return { cached: await cache.getNote(late.id), published };
      } finally {
        cache.close();
      }
    } finally {
      response.resolve(
        new Response(JSON.stringify(late), {
          headers: { "X-MiyulabMD-Session-User": "user:alice" },
        }),
      );
      reader.dispose();
      globalThis.fetch = originalFetch;
    }
  }, note);
  expect(result).toEqual({ cached: null, published: false });
});

test("cache clearing prevents an older Home snapshot from being saved or published", async ({
  page,
}) => {
  await page.goto("/tests/browser/fixtures/storage.html");
  const result = await page.evaluate(async (note) => {
    const cacheUrl = "/src/lib/offline-cache.ts";
    const homeUrl = "/src/lib/home-metadata-reader.ts";
    const { clearOfflineCacheUser, openOfflineCache } = await import(cacheUrl);
    const { readHomeMetadata } = await import(homeUrl);
    const { markdown: _markdown, ...summary } = note;
    const folder = {
      ...note.access,
      children: [],
      crumbs: [],
      folder: "",
      id: "alice-root",
      name: "マイドライブ",
      parentId: null,
    };
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let requests = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      if (++requests === 2) {
        started.resolve();
      }
      await release.promise;
      const url = input instanceof Request ? input.url : String(input);
      return new Response(
        JSON.stringify(
          url.endsWith("/api/notes") ? { notes: [summary] } : folder,
        ),
        { headers: { "X-MiyulabMD-Session-User": "user:alice" } },
      );
    };
    try {
      const pending = readHomeMetadata({
        folderId: undefined,
        isCurrentOwner: () => true,
        signal: new AbortController().signal,
        viewer: {
          cacheViewerId: "alice",
          mode: "authenticated",
          user: {
            displayName: "Alice",
            email: "alice@example.test",
            id: "alice",
          },
        },
      }).then(
        () => true,
        () => false,
      );
      await started.promise;
      await clearOfflineCacheUser("alice");
      release.resolve();
      const published = await pending;
      const cache = await openOfflineCache({ userId: "alice" });
      try {
        return {
          folder: await cache.getFolder(null),
          list: await cache.getNoteList(),
          published,
        };
      } finally {
        cache.close();
      }
    } finally {
      release.resolve();
      globalThis.fetch = originalFetch;
    }
  }, note);
  expect(result).toEqual({ folder: null, list: null, published: false });
});

test("failed user purge degrades opens and stays stopped until a successful retry", async ({
  page,
}) => {
  await page.goto("/tests/browser/fixtures/storage.html");
  const result = await page.evaluate(async (note) => {
    const cacheUrl = "/src/lib/offline-cache.ts";
    const { clearOfflineCacheUser, openOfflineCache } = await import(cacheUrl);
    const cache = await openOfflineCache({ userId: "alice" });
    await cache.putNote(note);
    const originalRemove = FileSystemDirectoryHandle.prototype.removeEntry;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const failure = new DOMException("Purge failed", "NotAllowedError");
    let removals = 0;
    FileSystemDirectoryHandle.prototype.removeEntry = async function (
      name,
      options,
    ) {
      if (name === "YWxpY2U") {
        removals++;
        entered.resolve();
        await release.promise;
        throw failure;
      }
      return originalRemove.call(this, name, options);
    };
    try {
      const first = clearOfflineCacheUser("alice");
      const second = clearOfflineCacheUser("alice");
      const settled = Promise.allSettled([first, second]);
      await entered.promise;
      // A live purge owns the realm: the observer gets a degraded empty
      // handle instead of blocking on the purge's lock.
      const blockedDuringPurge = await openOfflineCache({
        userId: "alice",
      }).then(
        async (handle: {
          close(): void;
          degraded: boolean;
          getNote(id: string): Promise<unknown>;
        }) => {
          const observed = {
            degraded: handle.degraded,
            note: await handle.getNote(note.id),
          };
          handle.close();
          return observed;
        },
        () => null,
      );
      release.resolve();
      const outcomes = await settled;
      // The durable tombstone outlives the failed purge: while the fault
      // persists, opens either self-heal-and-fail again or come back
      // degraded instead of serving the half-purged data.
      const stoppedAfterFailure = await openOfflineCache({
        userId: "alice",
      }).then(
        (handle: { close(): void; degraded: boolean }) => {
          const degraded = handle.degraded;
          handle.close();
          return degraded;
        },
        () => true,
      );
      FileSystemDirectoryHandle.prototype.removeEntry = originalRemove;
      await clearOfflineCacheUser("alice");
      const fresh = await openOfflineCache({ userId: "alice" });
      try {
        await fresh.putNote(note);
        return {
          blockedDuringPurge,
          failures: outcomes.map(
            (outcome) =>
              outcome.status === "rejected" && outcome.reason === failure,
          ),
          recovered: (await fresh.getNote(note.id))?.note.markdown,
          removals,
          stoppedAfterFailure,
        };
      } finally {
        fresh.close();
      }
    } finally {
      release.resolve();
      FileSystemDirectoryHandle.prototype.removeEntry = originalRemove;
      cache.close();
    }
  }, note);
  expect(result.blockedDuringPurge).toEqual({ degraded: true, note: null });
  expect(result.failures).toEqual([true, true]);
  expect(result.recovered).toBe(note.markdown);
  // The failed purge plus any observer self-heal retries hit the fault.
  expect(result.removals).toBeGreaterThanOrEqual(1);
  expect(result.stoppedAfterFailure).toBe(true);
});

test("a pending body write cannot recreate the purged user directory", async ({
  page,
}) => {
  await page.goto("/tests/browser/fixtures/storage.html");
  const result = await page.evaluate(async (note) => {
    const cacheUrl = "/src/lib/offline-cache.ts";
    const { clearOfflineCacheUser, openOfflineCache } = await import(cacheUrl);
    const cache = await openOfflineCache({ userId: "alice" });
    const original = navigator.storage.getDirectory.bind(navigator.storage);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let gate = true;
    navigator.storage.getDirectory = async () => {
      const root = await original();
      if (gate) {
        gate = false;
        entered.resolve();
        await release.promise;
      }
      return root;
    };
    try {
      const write = cache.putNote(note).then(
        () => true,
        () => false,
      );
      await entered.promise;
      const clearing = clearOfflineCacheUser("alice");
      // Allow eager purge to finish, but also permit clear to await its writer.
      await Promise.race([
        clearing,
        new Promise((resolve) => setTimeout(resolve, 100)),
      ]);
      release.resolve();
      await clearing;
      const published = await write;
      let directoryExists = false;
      try {
        const app = await (await original()).getDirectoryHandle(
          "miyulabmd-offline-cache-v1",
        );
        await app.getDirectoryHandle("YWxpY2U");
        directoryExists = true;
      } catch (error) {
        if (
          !(error instanceof DOMException && error.name === "NotFoundError")
        ) {
          throw error;
        }
      }
      return { directoryExists, published };
    } finally {
      release.resolve();
      navigator.storage.getDirectory = original;
      cache.close();
    }
  }, note);
  expect(result).toEqual({ directoryExists: false, published: false });
});

test("an old viewer identity write cannot restore a cleared user", async ({
  page,
}) => {
  await page.goto("/tests/browser/fixtures/storage.html");
  const result = await page.evaluate(async () => {
    const cacheUrl = "/src/lib/offline-cache.ts";
    const { clearOfflineCacheUser, persistCachedViewerId, readCachedViewerId } =
      await import(cacheUrl);
    await persistCachedViewerId("alice");
    const original = indexedDB.open.bind(indexedDB);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let gate = true;
    indexedDB.open = (...args) => {
      const request = original(...args);
      if (gate) {
        gate = false;
        Object.defineProperty(request, "onsuccess", {
          set(handler) {
            request.addEventListener("success", (event) => {
              entered.resolve();
              void release.promise.then(() => handler.call(request, event));
            });
          },
        });
      }
      return request;
    };
    try {
      const write = persistCachedViewerId("alice").then(
        () => true,
        () => false,
      );
      await entered.promise;
      await clearOfflineCacheUser("alice");
      release.resolve();
      await write;
      return await readCachedViewerId();
    } finally {
      release.resolve();
      indexedDB.open = original;
    }
  });
  expect(result).toBeNull();
});
