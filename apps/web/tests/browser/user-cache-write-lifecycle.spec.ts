import { expect, test } from "@playwright/test";
import { note } from "./fixtures/note.ts";

for (const phase of ["pending", "complete"] as const) {
  test(`user suspension at ${phase} keeps the actual note transaction outcome`, async ({
    page,
  }) => {
    await page.goto("/tests/browser/fixtures/storage.html");
    const input = { note, phase };
    const outcome = await page.evaluate(async ({ note, phase }) => {
      const moduleUrl = "/src/lib/offline-cache.ts";
      const { openOfflineCache, suspendOfflineCacheUser } = await import(
        moduleUrl
      );
      const cache = await openOfflineCache({ userId: "alice" });
      await cache.putNote(note);
      const originalPut = IDBObjectStore.prototype.put;
      let injected = false;
      IDBObjectStore.prototype.put = function (
        this: IDBObjectStore,
        ...args: Parameters<IDBObjectStore["put"]>
      ) {
        const request = originalPut.apply(this, args);
        if (this.name === "notes" && !injected) {
          injected = true;
          if (phase === "pending") {
            suspendOfflineCacheUser("alice");
          } else {
            this.transaction.addEventListener(
              "complete",
              () => suspendOfflineCacheUser("alice"),
              { once: true },
            );
          }
        }
        return request;
      };
      try {
        const committed = await cache
          .putNote({ ...note, markdown: "Replacement body", updatedAt: 3 })
          .then(
            () => true,
            () => false,
          );
        return { committed, injected };
      } finally {
        IDBObjectStore.prototype.put = originalPut;
        cache.close();
      }
    }, input);
    expect(outcome.injected).toBe(true);
    // Reload discards the process-local suspension, not persistent note data.
    await page.reload();
    const saved = await page.evaluate(async (id) => {
      const moduleUrl = "/src/lib/offline-cache.ts";
      const { openOfflineCache } = await import(moduleUrl);
      const cache = await openOfflineCache({ userId: "alice" });
      try {
        return (await cache.getNote(id))?.note.markdown;
      } finally {
        cache.close();
      }
    }, note.id);
    expect(saved).toBe(
      phase === "complete" ? "Replacement body" : note.markdown,
    );
    expect(outcome.committed).toBe(phase === "complete");
  });
}
