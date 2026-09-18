import type { Note } from "@miyulabmd/shared";
import { expect, test } from "@playwright/test";
import { note } from "./fixtures/note.ts";

type CachedNote = { note: Note; cachedAt: number };
type CacheFixture = Window & {
  noteCache: {
    getNote(id: string): Promise<CachedNote | null>;
  };
};

test("a cached note can be read offline after recreating the page and cache", async ({
  page,
  context,
}) => {
  const moduleUrl = "/src/lib/offline-cache.ts";
  const startedAt = Date.now();
  await page.goto("/tests/browser/fixtures/storage.html");

  await page.evaluate(
    async ({ moduleUrl, note }) => {
      const { openOfflineCache } = await import(moduleUrl);
      const cache = await openOfflineCache({ userId: "alice" });
      try {
        await cache.putNote(note);
      } finally {
        cache.close();
      }
    },
    { moduleUrl, note },
  );

  // Reload while online to load the test harness, not a future service worker.
  // The cache itself must survive losing all module and page memory.
  await page.reload();
  await page.evaluate(async (moduleUrl) => {
    const { openOfflineCache } = await import(moduleUrl);
    Object.assign(window, {
      noteCache: await openOfflineCache({ userId: "alice" }),
    });
  }, moduleUrl);
  await context.setOffline(true);

  const cached = await page.evaluate(
    (id) => (window as CacheFixture).noteCache.getNote(id),
    note.id,
  );
  expect(cached?.note).toEqual(note);
  expect(cached?.cachedAt).toBeGreaterThanOrEqual(startedAt);
  expect(cached?.cachedAt).toBeLessThanOrEqual(Date.now());
});

test("a quota failure while replacing a note preserves its previous cached snapshot", async ({
  page,
}) => {
  const moduleUrl = "/src/lib/offline-cache.ts";
  await page.goto("/tests/browser/fixtures/storage.html");
  const result = await page.evaluate(
    async ({ moduleUrl, note }) => {
      const { openOfflineCache } = await import(moduleUrl);
      const cache = await openOfflineCache({ userId: "alice" });
      await cache.putNote(note);
      const before = await cache.getNote(note.id);

      // Inject failure at the browser storage boundary, not inside our cache.
      const original = FileSystemFileHandle.prototype.createWritable;
      FileSystemFileHandle.prototype.createWritable = () =>
        Promise.reject(
          new DOMException("Test storage is full", "QuotaExceededError"),
        );
      let failure: string | null = null;
      try {
        await cache.putNote({
          ...note,
          markdown: "# 更新版\n\nまだ保存できていない本文。",
          updatedAt: note.updatedAt + 1,
        });
      } catch (error) {
        if (!(error instanceof DOMException)) {
          throw error;
        }
        failure = error.name;
      } finally {
        FileSystemFileHandle.prototype.createWritable = original;
        cache.close();
      }

      const reopened = await openOfflineCache({ userId: "alice" });
      try {
        return {
          after: await reopened.getNote(note.id),
          before,
          failure,
        };
      } finally {
        reopened.close();
      }
    },
    { moduleUrl, note },
  );
  expect(result.failure).toBe("QuotaExceededError");
  expect(result.before?.note).toEqual(note);
  expect(result.after).toEqual(result.before);
});

test("users retain independent cached snapshots of the same note", async ({
  page,
}) => {
  const moduleUrl = "/src/lib/offline-cache.ts";
  await page.goto("/tests/browser/fixtures/storage.html");
  const result = await page.evaluate(
    async ({ moduleUrl, note }) => {
      const { openOfflineCache } = await import(moduleUrl);
      const alice = await openOfflineCache({ userId: "alice" });
      const bob = await openOfflineCache({ userId: "bob" });
      try {
        await alice.putNote(note);
        const bobBefore = await bob.getNote(note.id);
        await bob.putNote({ ...note, markdown: "Bobが取得した版" });
        return {
          alice: await alice.getNote(note.id),
          bob: await bob.getNote(note.id),
          bobBefore,
        };
      } finally {
        alice.close();
        bob.close();
      }
    },
    { moduleUrl, note },
  );
  expect(result.bobBefore).toBeNull();
  expect(result.alice?.note).toEqual(note);
  expect(result.bob?.note).toEqual({
    ...note,
    markdown: "Bobが取得した版",
  });
});

test("cached short IDs resolve the current user snapshot and respect canonical denial", async ({
  page,
}) => {
  await page.goto("/tests/browser/fixtures/storage.html");
  const result = await page.evaluate(async (note) => {
    const moduleUrl = "/src/lib/offline-cache.ts";
    const { openOfflineCache } = await import(moduleUrl);
    const alice = await openOfflineCache({ userId: "alice" });
    const bob = await openOfflineCache({ userId: "bob" });
    try {
      await alice.putNote(note);
      await bob.putNote({
        ...note,
        id: "bobs-canonical",
        markdown: "Bob's independent snapshot",
      });
      const original = await alice.getNote(note.id);
      const short = await alice.getNote(note.shortId);
      const bobShort = await bob.getNote(note.shortId);
      await alice.putNote({ ...note, shortId: "replacement-short" });
      const obsolete = await alice.getNote(note.shortId);
      const replacement = await alice.getNote("replacement-short");
      await alice.denyNote(note.id);
      return {
        bob: bobShort?.note.markdown,
        denied: await alice.getNote("replacement-short"),
        obsolete,
        original,
        replacement: replacement?.note.id,
        short,
      };
    } finally {
      alice.close();
      bob.close();
    }
  }, note);
  expect(result.short).toEqual(result.original);
  expect(result.bob).toBe("Bob's independent snapshot");
  expect(result.obsolete).toBeNull();
  expect(result.replacement).toBe(note.id);
  expect(result.denied).toBeNull();
});
