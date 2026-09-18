import type { Note } from "@miyulabmd/shared";
import { expect, type Route, test } from "@playwright/test";
import type { ViewerContext } from "../../src/lib/viewer-context.ts";
import { note } from "./fixtures/note.ts";

type ReadResult = {
  ok: boolean;
  data?: Note;
  viewer: ViewerContext;
  source: "network" | "cache" | "pending";
  cachedAt: number | null;
};
type ReadSession = {
  read(id: string): Promise<ReadResult>;
  dispose(): void;
};
type SessionFixture = Window & {
  sessions: {
    alice: ReadSession;
    bob: ReadSession;
    pendingAlice: Promise<{ result: ReadResult | null; error: string | null }>;
  };
};

type CancellationFixture = Window & {
  reader: ReadSession;
  pendingRead: Promise<{ result: ReadResult | null; error: string | null }>;
};

test("overlapping read sessions keep late responses in their original viewer scope", async ({
  page,
}) => {
  const moduleUrl = "/src/lib/note-read-session.ts";
  const alice: ViewerContext = {
    cacheViewerId: "alice",
    mode: "authenticated",
    user: {
      displayName: "Alice",
      email: "alice@example.test",
      id: "alice",
    },
  };
  const bob: ViewerContext = {
    cacheViewerId: "bob",
    mode: "authenticated",
    user: {
      displayName: "Bob",
      email: "bob@example.test",
      id: "bob",
    },
  };
  const bobNote: Note = {
    ...note,
    id: "bob-note",
    markdown: "# Bobのノート",
    ownerId: "bob",
    shortId: "bob-short",
    title: "Bobのノート",
  };
  const heldAlice = Promise.withResolvers<Route>();
  await page.route(`**/api/notes/${note.id}`, (route) => {
    heldAlice.resolve(route);
  });
  await page.route(`**/api/notes/${bobNote.id}`, (route) =>
    route.fulfill({
      headers: { "X-MiyulabMD-Session-User": "user:bob" },
      json: bobNote,
    }),
  );
  await page.goto("/tests/browser/fixtures/storage.html");
  await page.evaluate(
    async ({ moduleUrl, alice, bob, noteId }) => {
      const { createNoteReadSession } = await import(moduleUrl);
      const aliceSession = createNoteReadSession(alice);
      const pendingAlice = aliceSession.read(noteId).then(
        (result: ReadResult) => ({ error: null, result }),
        (error: unknown) => ({
          error: error instanceof Error ? error.name : "UnknownError",
          result: null,
        }),
      );
      const bobSession = createNoteReadSession(bob);
      // Even an in-place change by the caller must not rewrite the session.
      alice.cacheViewerId = bob.cacheViewerId;
      Object.assign(window, {
        sessions: { alice: aliceSession, bob: bobSession, pendingAlice },
      });
    },
    { alice, bob, moduleUrl, noteId: note.id },
  );
  const oldResponse = await heldAlice.promise;
  const bobResult = await page.evaluate(
    (id) => (window as SessionFixture).sessions.bob.read(id),
    bobNote.id,
  );
  expect(bobResult).toMatchObject({
    cachedAt: null,
    data: bobNote,
    ok: true,
    source: "network",
    viewer: bob,
  });

  await oldResponse.fulfill({
    headers: { "X-MiyulabMD-Session-User": "user:alice" },
    json: note,
  });
  const aliceResult = await page.evaluate(
    () => (window as SessionFixture).sessions.pendingAlice,
  );
  expect(aliceResult).toMatchObject({
    error: null,
    result: {
      cachedAt: null,
      data: note,
      ok: true,
      source: "network",
      viewer: alice,
    },
  });

  await expect
    .poll(() =>
      page.evaluate(
        async ({ aliceId, bobId }) => {
          const moduleUrl = "/src/lib/offline-cache.ts";
          const { openOfflineCache } = await import(moduleUrl);
          const alice = await openOfflineCache({ userId: "alice" });
          const bob = await openOfflineCache({ userId: "bob" });
          try {
            return {
              aliceOther: await alice.getNote(bobId),
              aliceOwn: (await alice.getNote(aliceId))?.note ?? null,
              bobOther: await bob.getNote(aliceId),
              bobOwn: (await bob.getNote(bobId))?.note ?? null,
            };
          } finally {
            alice.close();
            bob.close();
          }
        },
        { aliceId: note.id, bobId: bobNote.id },
      ),
    )
    .toEqual({
      aliceOther: null,
      aliceOwn: note,
      bobOther: null,
      bobOwn: bobNote,
    });
  await page.evaluate(() => {
    const { alice, bob } = (window as SessionFixture).sessions;
    alice.dispose();
    bob.dispose();
  });
});

test("disposing a read session cancels its pending result and prevents later requests", async ({
  page,
}) => {
  const moduleUrl = "/src/lib/note-read-session.ts";
  const held = Promise.withResolvers<Route>();
  const requests: string[] = [];
  await page.route("**/api/notes/*", (route) => {
    requests.push(new URL(route.request().url()).pathname);
    if (requests.length === 1) {
      held.resolve(route);
      return;
    }
    return route.fulfill({
      headers: { "X-MiyulabMD-Session-User": "user:alice" },
      json: note,
    });
  });
  await page.goto("/tests/browser/fixtures/storage.html");
  await page.evaluate(
    async ({ moduleUrl, id }) => {
      const { createNoteReadSession } = await import(moduleUrl);
      const reader = createNoteReadSession({
        cacheViewerId: "alice",
        mode: "authenticated",
        user: {
          displayName: "Alice",
          email: "alice@example.test",
          id: "alice",
        },
      });
      const pendingRead = reader.read(id).then(
        (result: ReadResult) => ({ error: null, result }),
        (error: unknown) => ({
          error: error instanceof Error ? error.name : "UnknownError",
          result: null,
        }),
      );
      Object.assign(window, { pendingRead, reader });
    },
    { id: note.id, moduleUrl },
  );
  const oldResponse = await held.promise;
  await page.evaluate(() => (window as CancellationFixture).reader.dispose());
  await oldResponse.fulfill({
    headers: { "X-MiyulabMD-Session-User": "user:alice" },
    json: note,
  });
  const first = await page.evaluate(
    () => (window as CancellationFixture).pendingRead,
  );
  const later = await page.evaluate(async () => {
    try {
      await (window as CancellationFixture).reader.read("after-dispose");
      return "published";
    } catch (error) {
      return error instanceof Error ? error.name : "UnknownError";
    }
  });
  expect(first).toEqual({ error: "AbortError", result: null });
  expect(later).toBe("AbortError");
  expect(requests).toEqual([`/api/notes/${note.id}`]);
});

test("disposing at the storage transaction boundary does not undo a detached save", async ({
  page,
}) => {
  const updated = {
    ...note,
    markdown: "# 保存してはいけない更新",
    updatedAt: 3,
  };
  await page.route(`**/api/notes/${note.id}`, (route) =>
    route.fulfill({
      headers: { "X-MiyulabMD-Session-User": "user:alice" },
      json: updated,
    }),
  );
  await page.goto("/tests/browser/fixtures/storage.html");
  const result = await page.evaluate(async (previous) => {
    const cacheUrl = "/src/lib/offline-cache.ts";
    const readerUrl = "/src/lib/note-read-session.ts";
    const { openOfflineCache } = await import(cacheUrl);
    const { createNoteReadSession } = await import(readerUrl);
    const initial = await openOfflineCache({ userId: "alice" });
    await initial.putNote(previous);
    const before = await initial.getNote(previous.id);
    initial.close();
    const reader = createNoteReadSession({
      cacheViewerId: "alice",
      mode: "authenticated",
      user: {
        displayName: "Alice",
        email: "alice@example.test",
        id: "alice",
      },
    });

    // Interrupt at the real browser storage boundary without naming stores
    // or mocking our cache implementation. The detached save runs on its own
    // handle, so the read's transaction boundary is its commit — disposing
    // there can no longer retract the already published read.
    const original = IDBDatabase.prototype.transaction;
    let interrupted = false;
    let interruptedAt: Promise<void> = Promise.resolve();
    IDBDatabase.prototype.transaction = function (
      this: IDBDatabase,
      ...args: Parameters<IDBDatabase["transaction"]>
    ) {
      const transaction = original.apply(this, args);
      if (!interrupted && args[1] === "readwrite") {
        interrupted = true;
        reader.dispose();
        interruptedAt = new Promise<void>((resolve) => {
          transaction.addEventListener("complete", () => resolve(), {
            once: true,
          });
          transaction.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
      }
      return transaction;
    };
    let outcome = "published";
    try {
      await reader.read(previous.id);
      // The detached save commits after the read resolves; wait for the
      // interrupted transaction to reach its terminal state before reading.
      for (let attempt = 0; !interrupted && attempt < 100; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await interruptedAt;
    } catch (error) {
      outcome = error instanceof Error ? error.name : "UnknownError";
    } finally {
      IDBDatabase.prototype.transaction = original;
      reader.dispose();
    }
    const reopened = await openOfflineCache({ userId: "alice" });
    try {
      return {
        after: await reopened.getNote(previous.id),
        before,
        interrupted,
        outcome,
      };
    } finally {
      reopened.close();
    }
  }, note);
  expect(result.interrupted).toBe(true);
  expect(result.outcome).toBe("published");
  expect(result.before?.note).toEqual(note);
  expect(result.after?.note).toEqual(updated);
});

test("cached fallback carries the original timestamp and disables mutations for an authenticated viewer", async ({
  page,
}) => {
  let failure: "server" | "connection" = "server";
  await page.route(`**/api/notes/${note.id}`, (route) =>
    failure === "connection"
      ? route.abort("internetdisconnected")
      : route.fulfill({
          headers: { "X-MiyulabMD-Session-User": "user:alice" },
          json: { error: "Unavailable" },
          status: 503,
        }),
  );
  await page.goto("/tests/browser/fixtures/storage.html");
  const stored = await page.evaluate(async (note) => {
    const moduleUrl = "/src/lib/offline-cache.ts";
    const { openOfflineCache } = await import(moduleUrl);
    const cache = await openOfflineCache({ userId: "alice" });
    try {
      await cache.putNote(note);
      return await cache.getNote(note.id);
    } finally {
      cache.close();
    }
  }, note);
  expect(stored?.note).toEqual(note);

  for (const kind of ["server", "connection"] as const) {
    failure = kind;
    const observed = await page.evaluate(async (id) => {
      const readerUrl = "/src/lib/note-read-session.ts";
      const gateUrl = "/src/lib/mutation-gate.ts";
      const { createNoteReadSession } = await import(readerUrl);
      const { createMutationGate } = await import(gateUrl);
      const reader = createNoteReadSession({
        cacheViewerId: "alice",
        mode: "authenticated",
        user: {
          displayName: "Alice",
          email: "alice@example.test",
          id: "alice",
        },
      });
      try {
        const result = await reader.read(id);
        const gate = createMutationGate(() => result);
        let invoked = false;
        let blockedBy: string | null = null;
        try {
          gate.run(() => {
            invoked = true;
          });
        } catch (error) {
          blockedBy = error instanceof Error ? error.name : "UnknownError";
        }
        return { blockedBy, canMutate: gate.canMutate(), invoked, result };
      } finally {
        reader.dispose();
      }
    }, note.id);
    expect(observed.result, kind).toMatchObject({
      cachedAt: stored?.cachedAt,
      data: note,
      ok: true,
      source: "cache",
      viewer: { cacheViewerId: "alice", mode: "authenticated" },
    });
    expect(observed.canMutate, kind).toBe(false);
    expect(observed.invoked, kind).toBe(false);
    expect(observed.blockedBy, kind).toBe("ReadOnlyViewingError");
  }
});
