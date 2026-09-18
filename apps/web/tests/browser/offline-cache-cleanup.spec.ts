import { expect, test } from "@playwright/test";
import { note } from "./fixtures/note.ts";

test("cancellation immediately after acquiring an OPFS writer releases it", async ({
  page,
}) => {
  await page.goto("/tests/browser/fixtures/storage.html");
  const result = await page.evaluate(async (note) => {
    const moduleUrl = "/src/lib/offline-cache.ts";
    const { openOfflineCache } = await import(moduleUrl);
    const cache = await openOfflineCache({ userId: "alice" });
    await cache.putNote(note);
    const before = await cache.getNote(note.id);
    const controller = new AbortController();
    const original = FileSystemFileHandle.prototype.createWritable;
    let writer: FileSystemWritableFileStream | undefined;
    let abortCalls = 0;
    FileSystemFileHandle.prototype.createWritable = async function (...args) {
      const acquired = await original.apply(this, args);
      writer = acquired;
      const abort = acquired.abort.bind(acquired);
      acquired.abort = (...args) => {
        abortCalls += 1;
        return abort(...args);
      };
      controller.abort();
      return acquired;
    };
    let outcome = "committed";
    try {
      await cache.putNote(
        { ...note, markdown: "# Cancelled update", updatedAt: 3 },
        { signal: controller.signal },
      );
    } catch (error) {
      outcome = error instanceof Error ? error.name : "UnknownError";
    } finally {
      FileSystemFileHandle.prototype.createWritable = original;
    }

    const abortCallsBeforeCleanup = abortCalls;
    let stillWritable = false;
    if (writer) {
      try {
        await writer.write(
          "The cancelled cache must no longer own a live writer",
        );
        stillWritable = true;
      } catch {
        // A writer aborted by the cache rejects subsequent writes.
      } finally {
        // Also clean up when running this test against the broken candidate.
        await writer.abort().catch(() => {
          // The implementation may already have aborted the writer.
        });
      }
    }
    try {
      return {
        abortCallsBeforeCleanup,
        after: await cache.getNote(note.id),
        before,
        outcome,
        stillWritable,
      };
    } finally {
      cache.close();
    }
  }, note);
  expect(result.outcome).toBe("AbortError");
  expect(result.abortCallsBeforeCleanup).toBeGreaterThan(0);
  expect(result.stillWritable).toBe(false);
  expect(result.before?.note).toEqual(note);
  expect(result.after).toEqual(result.before);
});

test("cancelled note and viewer transactions release abort listeners and preserve prior records", async ({
  page,
}) => {
  await page.goto("/tests/browser/fixtures/storage.html");
  for (const kind of ["note", "viewer"] as const) {
    const result = await page.evaluate(
      async ({ kind, note }) => {
        const moduleUrl = "/src/lib/offline-cache.ts";
        const { openOfflineCache, persistCachedViewerId, readCachedViewerId } =
          await import(moduleUrl);
        const cache = await openOfflineCache({ userId: "alice" });
        await cache.putNote(note);
        await persistCachedViewerId("bob");
        const before = await cache.getNote(note.id);
        const controller = new AbortController();
        const { signal } = controller;
        const nativeAdd = signal.addEventListener.bind(signal);
        const nativeRemove = signal.removeEventListener.bind(signal);
        // Track the public EventTarget boundary, including automatic once cleanup.
        const registrations = new Map<
          EventListenerOrEventListenerObject,
          EventListener
        >();
        signal.addEventListener = (type, listener, options) => {
          if (type !== "abort" || !listener) {
            nativeAdd(type, listener, options);
            return;
          }
          const once = typeof options === "object" && options.once;
          const wrapped: EventListener = (event) => {
            if (once) {
              registrations.delete(listener);
            }
            if (typeof listener === "function") {
              listener.call(signal, event);
            } else {
              listener.handleEvent(event);
            }
          };
          registrations.set(listener, wrapped);
          nativeAdd(type, wrapped, options);
        };
        signal.removeEventListener = (type, listener, options) => {
          const wrapped = listener ? registrations.get(listener) : undefined;
          nativeRemove(type, wrapped ?? listener, options);
          if (listener) {
            registrations.delete(listener);
          }
        };

        const original = IDBDatabase.prototype.transaction;
        let interrupted = false;
        IDBDatabase.prototype.transaction = function (
          this: IDBDatabase,
          ...args: Parameters<IDBDatabase["transaction"]>
        ) {
          const transaction = original.apply(this, args);
          if (!interrupted && args[1] === "readwrite") {
            interrupted = true;
            controller.abort();
          }
          return transaction;
        };
        let outcome = "committed";
        try {
          if (kind === "note") {
            await cache.putNote(
              { ...note, markdown: "# Cancelled update", updatedAt: 3 },
              { signal },
            );
          } else {
            await persistCachedViewerId("alice", { signal });
          }
        } catch (error) {
          outcome = error instanceof Error ? error.name : "UnknownError";
        } finally {
          IDBDatabase.prototype.transaction = original;
        }
        const remainingListeners = registrations.size;
        for (const wrapped of registrations.values()) {
          nativeRemove("abort", wrapped);
        }
        try {
          return {
            after: await cache.getNote(note.id),
            before,
            interrupted,
            outcome,
            remainingListeners,
            viewerId: await readCachedViewerId(),
          };
        } finally {
          cache.close();
        }
      },
      { kind, note },
    );
    expect(result.interrupted, kind).toBe(true);
    expect(result.outcome, kind).toBe("AbortError");
    expect(result.remainingListeners, kind).toBe(0);
    expect(result.after, kind).toEqual(result.before);
    expect(result.viewerId, kind).toBe("bob");
  }
});

test("committed data survives late cancellation while disposed readers do not publish it", async ({
  page,
}) => {
  const updated = { ...note, markdown: "# Committed update", updatedAt: 3 };
  await page.route(`**/api/notes/${note.id}`, (route) =>
    route.fulfill({
      headers: { "X-MiyulabMD-Session-User": "user:alice" },
      json: updated,
    }),
  );
  await page.goto("/tests/browser/fixtures/storage.html");

  for (const kind of ["note", "viewer", "session"] as const) {
    const result = await page.evaluate(
      async ({ kind, previous, updated }) => {
        const cacheUrl = "/src/lib/offline-cache.ts";
        const readerUrl = "/src/lib/note-read-session.ts";
        const { openOfflineCache, persistCachedViewerId, readCachedViewerId } =
          await import(cacheUrl);
        const { createNoteReadSession } = await import(readerUrl);
        const cache = await openOfflineCache({ userId: "alice" });
        await cache.putNote(previous);
        await persistCachedViewerId("alice");
        const reader = createNoteReadSession({
          cacheViewerId: "alice",
          mode: "authenticated",
          user: {
            displayName: "Alice",
            email: "alice@example.test",
            id: "alice",
          },
        });
        const controller = new AbortController();
        const original = IDBDatabase.prototype.transaction;
        let completed = false;
        IDBDatabase.prototype.transaction = function (
          this: IDBDatabase,
          ...args: Parameters<IDBDatabase["transaction"]>
        ) {
          const transaction = original.apply(this, args);
          if (args[1] === "readwrite") {
            // Real completion has happened; run before the implementation's
            // completion handler to exercise the notification-order race.
            transaction.addEventListener(
              "complete",
              () => {
                completed = true;
                if (kind === "session") {
                  reader.dispose();
                } else {
                  controller.abort();
                }
              },
              { once: true },
            );
          }
          return transaction;
        };

        let sessionCommitted: Awaited<ReturnType<typeof cache.getNote>> = null;
        const waitForSessionCommit = async () => {
          const deadline = Date.now() + 5000;
          while (Date.now() < deadline) {
            sessionCommitted = await cache.getNote(previous.id);
            if (sessionCommitted?.note.markdown === updated.markdown) {
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
        };
        const runKind = async () => {
          if (kind === "note") {
            await cache.putNote(updated, { signal: controller.signal });
            return;
          }
          if (kind === "viewer") {
            await persistCachedViewerId("bob", { signal: controller.signal });
            return;
          }
          await reader.read(updated.id);
          // The cache save is detached and outlives the reader: disposing
          // the session here must not undo the write, and the published
          // result stays published.
          reader.dispose();
          await waitForSessionCommit();
        };
        let outcome = "committed";
        try {
          await runKind();
        } catch (error) {
          outcome = error instanceof Error ? error.name : "UnknownError";
        } finally {
          IDBDatabase.prototype.transaction = original;
          reader.dispose();
        }
        const collect = async () => ({
          cached:
            kind === "session"
              ? (sessionCommitted?.note ?? null)
              : ((await cache.getNote(previous.id))?.note ?? null),
          completed: kind === "session" ? sessionCommitted !== null : completed,
          outcome,
          viewerId: await readCachedViewerId(),
        });
        try {
          return await collect();
        } finally {
          cache.close();
        }
      },
      { kind, previous: note, updated },
    );
    expect(result.completed, kind).toBe(true);
    // For a disposed reader the detached commit still lands; the read
    // itself already published before disposal could interpose.
    expect(result.outcome, kind).toBe("committed");
    expect(result.cached, kind).toEqual(kind === "viewer" ? note : updated);
    expect(result.viewerId, kind).toBe(kind === "viewer" ? "bob" : "alice");
  }
});
