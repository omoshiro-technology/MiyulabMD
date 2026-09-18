import { expect, test } from "@playwright/test";
import { note } from "./fixtures/note.ts";

for (const boundary of ["between-reads", "close"] as const) {
  test(`cached drive cancellation at ${boundary} prevents further work and publication`, async ({
    page,
  }) => {
    await page.goto("/tests/browser/fixtures/storage.html");
    const result = await page.evaluate(
      async ({ boundary, access }) => {
        const storageUrl = "/src/lib/offline-cache.ts";
        const readerUrl = "/src/lib/cached-drive-reader.ts";
        const { openOfflineCache } = await import(storageUrl);
        const { readCachedDrive } = await import(readerUrl);
        const seed = await openOfflineCache({ userId: "alice" });
        await seed.putFolder({
          ...access,
          children: [],
          crumbs: [],
          id: "folder",
          name: "Folder",
          parentId: null,
        });
        await seed.putNoteList([]);
        seed.close();
        const controller = new AbortController();
        const reason = { boundary, message: "Caller ended this read" };
        const waiting = Promise.withResolvers<void>();
        const released = Promise.withResolvers<void>();
        const originalGet = IDBObjectStore.prototype.get;
        const originalClose = IDBDatabase.prototype.close;
        const success = Object.getOwnPropertyDescriptor(
          IDBRequest.prototype,
          "onsuccess",
        );
        if (!success?.set) {
          throw new Error("Native IndexedDB success boundary unavailable");
        }
        let folderReadsAfterAbort = 0;
        IDBObjectStore.prototype.get = function (
          this: IDBObjectStore,
          ...args: Parameters<IDBObjectStore["get"]>
        ) {
          if (this.name === "folders" && controller.signal.aborted) {
            folderReadsAfterAbort += 1;
          }
          const request = originalGet.apply(this, args);
          if (this.name === "note-lists" && boundary === "between-reads") {
            Object.defineProperty(request, "onsuccess", {
              set(handler: (event: Event) => void) {
                success.set?.call(request, (event: Event) => {
                  waiting.resolve();
                  void released.promise.then(() =>
                    handler.call(request, event),
                  );
                });
              },
            });
          }
          return request;
        };
        IDBDatabase.prototype.close = function (this: IDBDatabase) {
          originalClose.call(this);
          if (boundary === "close") {
            controller.abort(reason);
          }
        };
        try {
          const pending = readCachedDrive(
            "alice",
            "folder",
            controller.signal,
          ).then(
            () => ({ rejected: false, sameReason: false }),
            (error: unknown) => ({
              rejected: true,
              sameReason: error === reason,
            }),
          );
          if (boundary === "between-reads") {
            await waiting.promise;
            controller.abort(reason);
            released.resolve();
          }
          return { ...(await pending), folderReadsAfterAbort };
        } finally {
          released.resolve();
          IDBObjectStore.prototype.get = originalGet;
          IDBDatabase.prototype.close = originalClose;
        }
      },
      { access: note.access, boundary },
    );
    expect(result).toEqual({
      folderReadsAfterAbort: 0,
      rejected: true,
      sameReason: true,
    });
  });
}
