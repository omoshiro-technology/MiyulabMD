import { expect, test } from "@playwright/test";
import { note } from "./fixtures/note.ts";

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/browser/fixtures/storage.html");
});

test("collects replaced note and image files without crossing users or Cache Storage", async ({
  page,
}) => {
  const result = await page.evaluate(async (sourceNote) => {
    const { openOfflineCache, collectOfflineCacheOrphans } = await import(
      "/src/lib/offline-cache.ts"
    );
    const alice = await openOfflineCache({ userId: "alice" });
    const bob = await openOfflineCache({ userId: "bob" });
    try {
      await caches
        .open("shell")
        .then((cache) => cache.put("/shell.js", new Response("shell")));
      await alice.putNote(sourceNote);
      await alice.putImage(
        sourceNote.id,
        "image-1",
        new Blob(["old image"], { type: "image/png" }),
      );
      await alice.putNote({ ...sourceNote, markdown: "new body" });
      await alice.putImage(
        sourceNote.id,
        "image-1",
        new Blob(["new image"], { type: "image/png" }),
      );
      await bob.putNote({ ...sourceNote, id: "bob-note", ownerId: "bob" });
      const root = await navigator.storage.getDirectory();
      const app = await root.getDirectoryHandle("miyulabmd-offline-cache-v1");
      const userDirectory = await app.getDirectoryHandle("YWxpY2U");
      const notesDirectory = await userDirectory.getDirectoryHandle("notes");
      const directory = await notesDirectory.getDirectoryHandle("bm90ZS0x");
      const unknownFile = await directory.getFileHandle("future-state.json", {
        create: true,
      });
      const unknownWriter = await unknownFile.createWritable();
      await unknownWriter.write("future layout");
      await unknownWriter.close();
      const before = await alice.getNote(sourceNote.id);
      const collected = await collectOfflineCacheOrphans("alice");
      const currentNote = await alice.getNote(sourceNote.id);
      const currentImage = await alice.getImage(sourceNote.id, "image-1");
      const aliceFiles: string[] = [];
      for await (const [name] of directory.entries()) {
        aliceFiles.push(name);
      }
      return {
        aliceFiles: aliceFiles.length,
        bobImage: await bob.getImage(sourceNote.id, "image-1"),
        bobNote: (await bob.getNote("bob-note"))?.note.markdown,
        cachedShell:
          (await (await caches.open("shell")).match("/shell.js")) !== null,
        collected,
        currentImage: await currentImage?.text(),
        currentNote: currentNote?.note.markdown,
        timestampPreserved: currentNote?.cachedAt === before?.cachedAt,
        unknownFile: await (await unknownFile.getFile()).text(),
      };
    } finally {
      alice.close();
      bob.close();
    }
  }, note);
  expect(result).toEqual({
    aliceFiles: 3,
    bobImage: null,
    bobNote: note.markdown,
    cachedShell: true,
    collected: { removedFiles: 2 },
    currentImage: "new image",
    currentNote: "new body",
    timestampPreserved: true,
    unknownFile: "future layout",
  });
});

test("does not sweep when the durable reference snapshot fails", async ({
  page,
}) => {
  const result = await page.evaluate(async (sourceNote) => {
    const { openOfflineCache, collectOfflineCacheOrphans } = await import(
      "/src/lib/offline-cache.ts"
    );
    const cache = await openOfflineCache({ userId: "alice" });
    await cache.putNote(sourceNote);
    cache.close();
    const originalCursor = IDBObjectStore.prototype.openCursor;
    IDBObjectStore.prototype.openCursor = function () {
      if (this.name === "notes") {
        throw new Error("snapshot unavailable");
      }
      return originalCursor.call(this);
    };
    const failed = await collectOfflineCacheOrphans("alice").then(
      () => false,
      () => true,
    );
    IDBObjectStore.prototype.openCursor = originalCursor;
    return failed;
  }, note);
  expect(result).toBe(true);
});

test("a mismatched owner in the user's record range prevents all file deletion", async ({
  page,
}) => {
  const result = await page.evaluate(async (sourceNote) => {
    const url = "/src/lib/offline-cache.ts";
    const { openOfflineCache, collectOfflineCacheOrphans } = await import(url);
    const cache = await openOfflineCache({ userId: "alice" });
    await cache.putNote(sourceNote);
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("miyulabmd-offline-cache");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const changeOwner = (owner: string) =>
      new Promise<void>((resolve, reject) => {
        const transaction = database.transaction("notes", "readwrite");
        const store = transaction.objectStore("notes");
        const request = store.openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor) {
            cursor.update({ ...cursor.value, userId: owner });
          }
        };
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error);
      });
    try {
      await changeOwner("not-alice");
      const rejected = await collectOfflineCacheOrphans("alice").then(
        () => false,
        () => true,
      );
      await changeOwner("alice");
      return {
        bodyAfterRepair: (await cache.getNote(sourceNote.id))?.note.markdown,
        rejected,
      };
    } finally {
      database.close();
      cache.close();
    }
  }, note);
  expect(result).toEqual({ bodyAfterRepair: note.markdown, rejected: true });
});

test("references protect a full note path, not another note's equal file name", async ({
  page,
}) => {
  const result = await page.evaluate(async (sourceNote) => {
    const url = "/src/lib/offline-cache.ts";
    const { openOfflineCache, collectOfflineCacheOrphans } = await import(url);
    const cache = await openOfflineCache({ userId: "alice" });
    const original = crypto.randomUUID;
    let fileId: ReturnType<typeof crypto.randomUUID> =
      "11111111-1111-4111-8111-111111111111";
    crypto.randomUUID = () => fileId;
    try {
      await cache.putNote(sourceNote);
      await cache.putNote({
        ...sourceNote,
        id: "sibling-note",
        markdown: "Sibling body",
        shortId: "sibling-short",
      });
      fileId = "22222222-2222-4222-8222-222222222222";
      await cache.putNote({ ...sourceNote, markdown: "Replacement body" });
      crypto.randomUUID = original;
      return {
        collected: await collectOfflineCacheOrphans("alice"),
        replacement: (await cache.getNote(sourceNote.id))?.note.markdown,
        sibling: (await cache.getNote("sibling-note"))?.note.markdown,
      };
    } finally {
      crypto.randomUUID = original;
      cache.close();
    }
  }, note);
  expect(result).toEqual({
    collected: { removedFiles: 1 },
    replacement: "Replacement body",
    sibling: "Sibling body",
  });
});

test("waits for an actual OPFS write in a second page", async ({
  page,
  context,
}) => {
  const secondPage = await context.newPage();
  await secondPage.goto("/tests/browser/fixtures/storage.html");
  await page.evaluate(async (sourceNote) => {
    const { openOfflineCache } = await import("/src/lib/offline-cache.ts");
    const cache = await openOfflineCache({ userId: "alice" });
    await cache.putNote(sourceNote);
    cache.close();
  }, note);
  let collection: Promise<{ removedFiles: number }> | undefined;
  try {
    await secondPage.evaluate(async (sourceNote) => {
      const url = "/src/lib/offline-cache.ts";
      const { openOfflineCache } = await import(url);
      const cache = await openOfflineCache({ userId: "alice" });
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const original = FileSystemFileHandle.prototype.createWritable;
      FileSystemFileHandle.prototype.createWritable = async function (...args) {
        const writable = await original.apply(this, args);
        const close = writable.close.bind(writable);
        writable.close = async () => {
          await close();
          entered.resolve();
          await release.promise;
        };
        return writable;
      };
      const done = cache
        .putNote({ ...sourceNote, markdown: "Concurrent committed body" })
        .finally(() => {
          FileSystemFileHandle.prototype.createWritable = original;
          cache.close();
        });
      Object.assign(window, { gcWriter: { done, release: release.resolve } });
      await entered.promise;
    }, note);
    collection = page.evaluate(async () => {
      const url = "/src/lib/offline-cache.ts";
      const { collectOfflineCacheOrphans } = await import(url);
      return collectOfflineCacheOrphans("alice");
    });
    await expect
      .poll(() =>
        secondPage.evaluate(async () => {
          const state = await navigator.locks.query();
          return state.pending.some(
            (lock) =>
              lock.name === "miyulabmd-offline-cache:user:YWxpY2U" &&
              lock.mode === "exclusive",
          );
        }),
      )
      .toBe(true);
    await secondPage.evaluate(async () => {
      const { gcWriter } = window as unknown as {
        gcWriter: { done: Promise<void>; release: () => void };
      };
      gcWriter.release();
      await gcWriter.done;
    });
    await expect(collection).resolves.toEqual({ removedFiles: 1 });
    const preserved = await page.evaluate(async (id) => {
      const url = "/src/lib/offline-cache.ts";
      const { openOfflineCache } = await import(url);
      const cache = await openOfflineCache({ userId: "alice" });
      try {
        return (await cache.getNote(id))?.note.markdown;
      } finally {
        cache.close();
      }
    }, note.id);
    expect(preserved).toBe("Concurrent committed body");
  } finally {
    await secondPage.evaluate(() => {
      (
        window as unknown as { gcWriter?: { release: () => void } }
      ).gcWriter?.release();
    });
    await collection?.catch(() => undefined);
    await secondPage.close();
  }
});
