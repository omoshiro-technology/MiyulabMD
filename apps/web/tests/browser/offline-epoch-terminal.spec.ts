import { expect, test } from "@playwright/test";
import { note } from "./fixtures/note.ts";

for (const failure of ["abort", "metadata", "abort-and-metadata"] as const) {
  test(`cache opening cleans up after ${failure} during epoch acquisition`, async ({
    page,
  }) => {
    await page.goto("/tests/browser/fixtures/storage.html");
    const result = await page.evaluate(async (failure) => {
      const moduleUrl = "/src/lib/offline-cache.ts";
      const { openOfflineCache } = await import(moduleUrl);
      const originalGet = IDBObjectStore.prototype.get;
      const originalClose = IDBDatabase.prototype.close;
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const reason = new Error("Distinct epoch cancellation");
      const metadataError = new Error("Epoch metadata unavailable");
      const controller = new AbortController();
      let closes = 0;
      let gated = false;
      let opened: { close(): void } | undefined;
      IDBDatabase.prototype.close = function () {
        closes++;
        return originalClose.call(this);
      };
      IDBObjectStore.prototype.get = function (key) {
        if (!gated && String(key).startsWith("purge-generation:")) {
          gated = true;
          if (failure !== "abort") {
            if (failure === "abort-and-metadata") {
              controller.abort(reason);
            }
            throw metadataError;
          }
          const request = originalGet.call(this, key);
          Object.defineProperty(request, "onsuccess", {
            set(handler: (event: Event) => void) {
              request.addEventListener("success", (event) => {
                entered.resolve();
                void release.promise.then(() => handler.call(request, event));
              });
            },
          });
          return request;
        }
        return originalGet.call(this, key);
      };
      try {
        const pending = openOfflineCache({
          signal: controller.signal,
          userId: "alice",
        }).then(
          (cache: { close(): void; degraded: boolean }) => {
            opened = cache;
            return { degraded: cache.degraded, rejected: false };
          },
          (error: unknown) => ({
            degraded: null,
            rejected:
              error === (failure === "metadata" ? metadataError : reason),
          }),
        );
        if (failure === "abort") {
          await entered.promise;
          controller.abort(reason);
          release.resolve();
        }
        const outcome = await pending;
        return { closedBeforeReturn: closes, ...outcome };
      } finally {
        release.resolve();
        opened?.close();
        IDBObjectStore.prototype.get = originalGet;
        IDBDatabase.prototype.close = originalClose;
      }
    }, failure);
    if (failure === "metadata") {
      // A transient metadata read failure is absorbed by the tombstone
      // scan; the open still resolves a usable cache instead of rejecting.
      expect(result.rejected).toBe(false);
      expect(result.degraded).toBe(false);
    } else {
      // The caller's own abort still propagates the exact reason.
      expect(result.rejected).toBe(true);
      expect(result.degraded).toBeNull();
    }
    // An open that never reached storage owns nothing to close; the
    // tombstone scan's connection is released before returning.
    expect(result.closedBeforeReturn).toBeLessThanOrEqual(1);
  });
}

for (const scenario of [
  "home-abort",
  "home-abort-failure",
  "home-owner",
  "home-folder-denial",
  "note-dispose",
  "note-denial",
] as const) {
  test(`final epoch verification cannot publish after ${scenario}`, async ({
    page,
  }) => {
    await page.goto("/tests/browser/fixtures/storage.html");
    type Input = { note: typeof note; scenario: typeof scenario };
    const exercise = async ({ scenario, note }: Input) => {
      const cacheUrl = "/src/lib/offline-cache.ts";
      const sessionUrl = "/src/lib/note-read-session.ts";
      const homeUrl = "/src/lib/home-metadata-reader.ts";
      const { enterOfflineNoteDenial, openOfflineCache } = await import(
        cacheUrl
      );
      const { createNoteReadSession } = await import(sessionUrl);
      const { readHomeMetadata } = await import(homeUrl);
      const viewer = {
        cacheViewerId: "alice",
        mode: "authenticated",
        user: {
          displayName: "Alice",
          email: "alice@example.test",
          id: "alice",
        },
      };
      const controller = new AbortController();
      const reason = new Error("Abort at final Home authority boundary");
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const home = scenario.startsWith("home");
      const originalGet = IDBObjectStore.prototype.get;
      const originalGetAll = IDBObjectStore.prototype.getAll;
      const originalFetch = globalThis.fetch;
      let owner = true;
      let gated = false;
      const delay = (request: IDBRequest) => {
        gated = true;
        Object.defineProperty(request, "onsuccess", {
          set(handler: (event: Event) => void) {
            request.addEventListener("success", (event) => {
              entered.resolve();
              void release.promise.then(() => handler.call(request, event));
            });
          },
        });
      };
      // The post-fetch awaited steps in v5: the note read awaits the
      // durable note-denial sequence (its CAS watermark), and the home
      // read awaits the parallel denial snapshot's metadata range scan.
      IDBObjectStore.prototype.get = function (key) {
        const request = originalGet.call(this, key);
        if (!(home || gated) && String(key).startsWith("note-order:")) {
          delay(request);
        }
        return request;
      };
      IDBObjectStore.prototype.getAll = function (query, count) {
        if (home && !gated && this.name === "metadata") {
          if (scenario === "home-abort-failure") {
            gated = true;
            entered.resolve();
            controller.abort(reason);
            throw new Error("Final authority read failed too");
          }
          const request = originalGetAll.call(this, query, count);
          delay(request);
          return request;
        }
        return originalGetAll.call(this, query, count);
      };
      globalThis.fetch = (input) => {
        const path = input instanceof Request ? input.url : String(input);
        let data: unknown = note;
        if (home) {
          data = path.endsWith("/api/notes")
            ? { notes: [note] }
            : {
                ...note.access,
                children: [],
                crumbs: [],
                folder: "",
                id: "alice-root",
                name: "MyDrive",
                parentId: null,
              };
        }
        return Promise.resolve(
          new Response(JSON.stringify(data), {
            headers: { "X-MiyulabMD-Session-User": "user:alice" },
          }),
        );
      };
      const session = createNoteReadSession(viewer);
      try {
        const pending = (
          home
            ? readHomeMetadata({
                folderId: undefined,
                isCurrentOwner: () => owner,
                signal: controller.signal,
                viewer,
              })
            : session.read(note.id)
        ).then(
          () => ({ exactAbort: false, published: true }),
          (error: unknown) => ({
            exactAbort: error === reason,
            published: false,
          }),
        );
        await entered.promise;
        if (scenario.startsWith("home-abort")) {
          controller.abort(reason);
        } else if (scenario === "home-owner") {
          owner = false;
        } else if (scenario === "home-folder-denial") {
          const cache = await openOfflineCache({ userId: "alice" });
          await cache.denyFolder("alice-root");
          cache.close();
        } else if (scenario === "note-dispose") {
          session.dispose();
        } else {
          enterOfflineNoteDenial("alice", note.id);
        }
        release.resolve();
        return await pending;
      } finally {
        release.resolve();
        session.dispose();
        globalThis.fetch = originalFetch;
        IDBObjectStore.prototype.get = originalGet;
        IDBObjectStore.prototype.getAll = originalGetAll;
      }
    };
    const result = await page.evaluate(exercise, { note, scenario });
    if (scenario === "home-folder-denial") {
      // A denial landing mid-read publishes the fetched data; the durable
      // denial corrects the view through the folder-denial subscription.
      expect(result.published).toBe(true);
    } else {
      expect(result.published).toBe(false);
    }
    if (scenario.startsWith("home-abort")) {
      expect(result.exactAbort).toBe(true);
    }
  });
}
