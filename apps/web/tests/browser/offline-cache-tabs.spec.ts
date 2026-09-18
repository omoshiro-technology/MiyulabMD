import { expect, test } from "@playwright/test";
import { note } from "./fixtures/note.ts";

test("clearing a user in another tab prevents a late note response from restoring data", async ({
  page,
  context,
}) => {
  await page.goto("/tests/browser/fixtures/storage.html");
  const other = await context.newPage();
  await other.goto("/tests/browser/fixtures/storage.html");
  try {
    await other.evaluate(async (note) => {
      const moduleUrl = "/src/lib/note-read-session.ts";
      const { createNoteReadSession } = await import(moduleUrl);
      const entered = Promise.withResolvers<void>();
      const response = Promise.withResolvers<Response>();
      const original = globalThis.fetch;
      globalThis.fetch = () => {
        entered.resolve();
        return response.promise;
      };
      const session = createNoteReadSession({
        cacheViewerId: "alice",
        mode: "authenticated",
        user: {
          displayName: "Alice",
          email: "alice@example.test",
          id: "alice",
        },
      });
      const pendingNote = session
        .read(note.id)
        .then(
          (result: { ok: boolean }) => result.ok,
          () => false,
        )
        .finally(() => {
          session.dispose();
          globalThis.fetch = original;
        });
      Object.assign(window, {
        pendingNote,
        releasePendingNote: () =>
          response.resolve(
            new Response(JSON.stringify(note), {
              headers: { "X-MiyulabMD-Session-User": "user:alice" },
            }),
          ),
      });
      await entered.promise;
    }, note);
    await page.evaluate(async () => {
      const moduleUrl = "/src/lib/offline-cache.ts";
      const { clearOfflineCacheUser } = await import(moduleUrl);
      await clearOfflineCacheUser("alice");
    });
    const published = await other.evaluate(async () => {
      const fixture = window as typeof window & {
        pendingNote: Promise<boolean>;
        releasePendingNote(): void;
      };
      fixture.releasePendingNote();
      return await fixture.pendingNote;
    });
    const restored = await page.evaluate(async (id) => {
      const moduleUrl = "/src/lib/offline-cache.ts";
      const { openOfflineCache } = await import(moduleUrl);
      const cache = await openOfflineCache({ userId: "alice" });
      try {
        return await cache.getNote(id);
      } finally {
        cache.close();
      }
    }, note.id);
    expect(published).toBe(false);
    expect(restored).toBeNull();
  } finally {
    await other.close();
  }
});

test("missed invalidation messages still fence old Alice handles and preserve Bob", async ({
  page,
  context,
}) => {
  await page.goto("/tests/browser/fixtures/storage.html");
  const other = await context.newPage();
  await other.addInitScript(() => {
    Object.defineProperty(globalThis, "BroadcastChannel", { value: undefined });
  });
  await other.goto("/tests/browser/fixtures/storage.html");
  try {
    await other.evaluate(async (note) => {
      const url = "/src/lib/offline-cache.ts";
      const { openOfflineCache } = await import(url);
      const alice = await openOfflineCache({ userId: "alice" });
      const bob = await openOfflineCache({ userId: "bob" });
      await alice.putNote(note);
      await bob.putNote({ ...note, markdown: "Bob's private copy" });
      Object.assign(window, { alice, bob });
    }, note);
    await page.evaluate(async () => {
      const url = "/src/lib/offline-cache.ts";
      const { clearOfflineCacheUser } = await import(url);
      await clearOfflineCacheUser("alice");
    });
    const result = await other.evaluate(async (note) => {
      const fixture = window as typeof window & {
        alice: { putNote(note: unknown): Promise<void>; close(): void };
        bob: {
          putNote(note: unknown): Promise<void>;
          getNote(id: string): Promise<{ note: { markdown: string } } | null>;
          close(): void;
        };
      };
      try {
        const oldWrite = await fixture.alice.putNote(note).then(
          () => true,
          () => false,
        );
        await fixture.bob.putNote({
          ...note,
          markdown: "Bob remains writable",
        });
        const bob = await fixture.bob.getNote(note.id);
        const root = await navigator.storage.getDirectory();
        const app = await root.getDirectoryHandle("miyulabmd-offline-cache-v1");
        const aliceDirectory = await app.getDirectoryHandle("YWxpY2U").then(
          () => true,
          () => false,
        );
        return { aliceDirectory, bob: bob?.note.markdown, oldWrite };
      } finally {
        fixture.alice.close();
        fixture.bob.close();
      }
    }, note);
    expect(result).toEqual({
      aliceDirectory: false,
      bob: "Bob remains writable",
      oldWrite: false,
    });
    const explicitSave = await other.evaluate(async (note) => {
      const url = "/src/lib/offline-cache.ts";
      const { openOfflineCache } = await import(url);
      const fresh = await openOfflineCache({ userId: "alice" });
      try {
        await fresh.putNote(note);
        return (await fresh.getNote(note.id))?.note.markdown;
      } finally {
        fresh.close();
      }
    }, note);
    expect(explicitSave).toBe(note.markdown);
  } finally {
    await other.close();
  }
});

test("purge waits for another tab's actual OPFS operation, then removes its subtree", async ({
  page,
  context,
}) => {
  await page.goto("/tests/browser/fixtures/storage.html");
  const other = await context.newPage();
  await other.addInitScript(() => {
    Object.defineProperty(globalThis, "BroadcastChannel", { value: undefined });
  });
  await other.goto("/tests/browser/fixtures/storage.html");
  try {
    await other.evaluate(async (note) => {
      const url = "/src/lib/offline-cache.ts";
      const { openOfflineCache } = await import(url);
      const cache = await openOfflineCache({ userId: "alice" });
      const original = navigator.storage.getDirectory.bind(navigator.storage);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      navigator.storage.getDirectory = async () => {
        const root = await original();
        entered.resolve();
        await release.promise;
        return root;
      };
      const pendingWrite = cache
        .putNote(note)
        .then(
          () => true,
          () => false,
        )
        .finally(() => {
          cache.close();
          navigator.storage.getDirectory = original;
        });
      Object.assign(window, {
        pendingWrite,
        releaseWrite: () => release.resolve(),
      });
      await entered.promise;
    }, note);
    await page.evaluate(async () => {
      const url = "/src/lib/offline-cache.ts";
      const { clearOfflineCacheUser } = await import(url);
      Object.assign(window, { clearing: clearOfflineCacheUser("alice") });
    });
    // Observe the real lock queue, not elapsed time or a delayed HTTP response.
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const state = await navigator.locks.query();
          return (
            state.pending?.some(
              (lock) =>
                lock.name === "miyulabmd-offline-cache:user:YWxpY2U" &&
                lock.mode === "exclusive",
            ) ?? false
          );
        }),
      )
      .toBe(true);
    await other.evaluate(async () => {
      const fixture = window as typeof window & {
        pendingWrite: Promise<boolean>;
        releaseWrite(): void;
      };
      fixture.releaseWrite();
      await fixture.pendingWrite;
    });
    const result = await page.evaluate(async (id) => {
      await (window as typeof window & { clearing: Promise<void> }).clearing;
      const url = "/src/lib/offline-cache.ts";
      const { openOfflineCache } = await import(url);
      const cache = await openOfflineCache({ userId: "alice" });
      try {
        const cached = await cache.getNote(id);
        const root = await navigator.storage.getDirectory();
        const app = await root.getDirectoryHandle("miyulabmd-offline-cache-v1");
        const directory = await app.getDirectoryHandle("YWxpY2U").then(
          () => true,
          () => false,
        );
        return { cached, directory };
      } finally {
        cache.close();
      }
    }, note.id);
    expect(result).toEqual({ cached: null, directory: false });
  } finally {
    await other.close();
  }
});

test("a late HTTP response is invalidated durably even with no BroadcastChannel", async ({
  page,
  context,
}) => {
  await page.goto("/tests/browser/fixtures/storage.html");
  const other = await context.newPage();
  await other.addInitScript(() => {
    Object.defineProperty(globalThis, "BroadcastChannel", { value: undefined });
  });
  await other.goto("/tests/browser/fixtures/storage.html");
  try {
    await other.evaluate(async (id) => {
      const url = "/src/lib/note-read-session.ts";
      const { createNoteReadSession } = await import(url);
      const entered = Promise.withResolvers<void>();
      const response = Promise.withResolvers<Response>();
      const original = globalThis.fetch;
      globalThis.fetch = () => {
        entered.resolve();
        return response.promise;
      };
      const session = createNoteReadSession({
        cacheViewerId: "alice",
        mode: "authenticated",
        user: {
          displayName: "Alice",
          email: "alice@example.test",
          id: "alice",
        },
      });
      const pending = session
        .read(id)
        .then(
          (result: { ok: boolean }) => result.ok,
          () => false,
        )
        .finally(() => {
          globalThis.fetch = original;
          session.dispose();
        });
      Object.assign(window, {
        pending,
        release: (body: unknown) =>
          response.resolve(
            new Response(JSON.stringify(body), {
              headers: { "X-MiyulabMD-Session-User": "user:alice" },
            }),
          ),
      });
      await entered.promise;
    }, note.id);
    await page.evaluate(async () => {
      const url = "/src/lib/offline-cache.ts";
      const { clearOfflineCacheUser } = await import(url);
      await clearOfflineCacheUser("alice");
    });
    const published = await other.evaluate(async (note) => {
      const fixture = window as typeof window & {
        pending: Promise<boolean>;
        release(body: unknown): void;
      };
      fixture.release(note);
      return await fixture.pending;
    }, note);
    expect(published).toBe(false);
    const cached = await page.evaluate(async (id) => {
      const url = "/src/lib/offline-cache.ts";
      const { openOfflineCache } = await import(url);
      const cache = await openOfflineCache({ userId: "alice" });
      try {
        return await cache.getNote(id);
      } finally {
        cache.close();
      }
    }, note.id);
    expect(cached).toBeNull();
  } finally {
    await other.close();
  }
});
