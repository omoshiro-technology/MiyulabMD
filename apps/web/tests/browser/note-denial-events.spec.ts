import { expect, test } from "@playwright/test";
import { note } from "./fixtures/note.ts";

test("a delayed denial receipt cannot remove a newer verified read", async ({
  page,
}) => {
  await page.goto("/tests/browser/fixtures/storage.html");
  let reads = 0;
  await page.route(`**/api/notes/${note.id}`, (route) => {
    reads += 1;
    return route.fulfill({
      headers: { "X-MiyulabMD-Session-User": "user:alice" },
      json: { ...note, markdown: `Verified body ${reads}`, updatedAt: reads },
    });
  });
  const result = await page.evaluate(async (id) => {
    const cacheUrl = "/src/lib/offline-cache.ts";
    const sessionUrl = "/src/lib/note-read-session.ts";
    const { openOfflineCache, reportOfflineNoteDenial } = await import(
      cacheUrl
    );
    const { createNoteReadSession } = await import(sessionUrl);
    type Receipt = {
      resource: { epoch: string | null; generation: number | null };
    };
    const delivered = Promise.withResolvers<Receipt>();
    let notifications = 0;
    const reader = createNoteReadSession(
      {
        cacheViewerId: "alice",
        mode: "authenticated",
        user: {
          displayName: "Alice",
          email: "alice@example.test",
          id: "alice",
        },
      },
      {
        onDenied: (event: Receipt) => {
          notifications += 1;
          delivered.resolve(event);
        },
      },
    );
    const cache = await openOfflineCache({ userId: "alice" });
    try {
      await reader.read(id);
      await cache.denyNote(id);
      const receipt = await delivered.promise;
      const fresh = await reader.read(id);
      reportOfflineNoteDenial(
        "alice",
        id,
        receipt.resource.epoch,
        receipt.resource.generation,
      );
      // Drain earlier authority reads through an overlapping native transaction,
      // not an animation-frame timing budget.
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("miyulabmd-offline-cache");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const transaction = database.transaction("metadata", "readwrite");
          transaction.objectStore("metadata").get("viewer-id");
          transaction.oncomplete = () => resolve();
          transaction.onabort = () => reject(transaction.error);
        });
      } finally {
        database.close();
      }
      reader.dispose();
      await cache.denyNote(id);
      return { fresh, notifications };
    } finally {
      reader.dispose();
      cache.close();
    }
  }, note.id);
  expect(result.fresh).toMatchObject({
    data: { markdown: "Verified body 2" },
    ok: true,
    source: "network",
  });
  expect(result.notifications).toBe(1);
});
