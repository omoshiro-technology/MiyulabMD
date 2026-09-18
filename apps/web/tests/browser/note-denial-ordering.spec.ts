import { expect, test } from "@playwright/test";
import { note } from "./fixtures/note.ts";

test("a request started before denial cannot revive a note, but a new successful request can", async ({
  page,
}) => {
  await page.goto("/tests/browser/fixtures/storage.html");
  const result = await page.evaluate(async (note) => {
    const cacheUrl = "/src/lib/offline-cache.ts";
    const readerUrl = "/src/lib/note-read-session.ts";
    const { openOfflineCache, subscribeOfflineCacheNoteDenial } = await import(
      cacheUrl
    );
    const { createNoteReadSession } = await import(readerUrl);
    const barrierUrl = "/tests/browser/fixtures/deferred-cache-open.ts";
    const { deferNextDatabaseOpen } = await import(barrierUrl);
    const viewer = {
      cacheViewerId: "alice",
      mode: "authenticated",
      user: { displayName: "Alice", email: "alice@example.test", id: "alice" },
    };
    const alice = await openOfflineCache({ userId: "alice" });
    const bob = await openOfflineCache({ userId: "bob" });
    await alice.putNote(note);
    await bob.putNote(note);
    const slowReader = createNoteReadSession(viewer);
    const denyingReader = createNoteReadSession(viewer);
    const freshReader = createNoteReadSession(viewer);
    const recoveredNote = {
      ...note,
      markdown: "Access restored",
      updatedAt: 3,
    };
    const originalFetch = globalThis.fetch;
    const opening = deferNextDatabaseOpen();
    let requests = 0;
    globalThis.fetch = () => {
      requests += 1;
      if (requests === 1) {
        return Promise.resolve(
          new Response(JSON.stringify(note), {
            headers: { "X-MiyulabMD-Session-User": "user:alice" },
            status: 200,
          }),
        );
      }
      if (requests === 2) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: "Forbidden" }), {
            headers: { "X-MiyulabMD-Session-User": "user:alice" },
            status: 403,
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify(recoveredNote), {
          headers: { "X-MiyulabMD-Session-User": "user:alice" },
          status: 200,
        }),
      );
    };
    try {
      // Observe the old request even if denial proactively cancels it.
      const slow = slowReader.read(note.id).then(
        (value: { ok: boolean }) => value.ok,
        () => false,
      );
      // Pause after the HTTP result, before storage/publication. This allows
      // the next independent validation to observe a real server denial.
      await opening.started;
      // The durable denial write is detached: wait for the committed-denial
      // notification (emitted after the marker lands) instead of racing it.
      const denied = new Promise<unknown>((resolve) => {
        const unsubscribe = subscribeOfflineCacheNoteDenial(
          (event: { resource: { aliases: string[] } }) => {
            if (event.resource.aliases.includes(note.id)) {
              unsubscribe();
              resolve(event);
            }
          },
        );
      });
      const denial = await denyingReader.read(note.id);
      await denied;
      const afterDenial = await alice.getNote(note.id);
      opening.release();
      const stalePublished = await slow;
      const afterStale = await alice.getNote(note.id);
      // This session already existed, but this request begins after denial.
      const recovered = await freshReader.read(note.id);
      // The display-cache save is detached: poll until the write and the
      // denial clear have landed.
      let afterRecovery: string | null = null;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        afterRecovery = (await alice.getNote(note.id))?.note.markdown ?? null;
        if (afterRecovery === "Access restored") {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return {
        afterDenial,
        afterRecovery,
        afterStale,
        denial,
        otherViewer: (await bob.getNote(note.id))?.note.markdown,
        recovered,
        requests,
        stalePublished,
      };
    } finally {
      opening.restore();
      globalThis.fetch = originalFetch;
      slowReader.dispose();
      denyingReader.dispose();
      freshReader.dispose();
      alice.close();
      bob.close();
    }
  }, note);
  expect(result.denial).toMatchObject({ ok: false, status: 403 });
  expect(result.afterDenial).toBeNull();
  expect(result.stalePublished).toBe(false);
  expect(result.afterStale).toBeNull();
  expect(result.recovered).toMatchObject({
    data: { markdown: "Access restored" },
    ok: true,
    source: "network",
  });
  expect(result.afterRecovery).toBe("Access restored");
  expect(result.otherViewer).toBe(note.markdown);
  expect(result.requests).toBe(3);
});

test("a cached read started before denial cannot publish after denial completes", async ({
  page,
}) => {
  await page.goto("/tests/browser/fixtures/storage.html");
  const result = await page.evaluate(async (note) => {
    const cacheUrl = "/src/lib/offline-cache.ts";
    const readerUrl = "/src/lib/note-read-session.ts";
    const { openOfflineCache } = await import(cacheUrl);
    const { createNoteReadSession } = await import(readerUrl);
    const viewer = {
      cacheViewerId: "alice",
      mode: "authenticated",
      user: { displayName: "Alice", email: "alice@example.test", id: "alice" },
    };
    const cache = await openOfflineCache({ userId: "alice" });
    await cache.putNote(note);
    const cachedReader = createNoteReadSession(viewer);
    const denyingReader = createNoteReadSession(viewer);
    const originalFetch = globalThis.fetch;
    const originalText = Blob.prototype.text;
    let reading: () => void = () => undefined;
    let release: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      reading = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    Blob.prototype.text = async function (this: Blob) {
      const text = await originalText.call(this);
      reading();
      await released;
      return text;
    };
    globalThis.fetch = () =>
      Promise.reject(new TypeError("Network unavailable"));
    try {
      const pending = cachedReader.read(note.id).then(
        (value: { ok: boolean }) => value.ok,
        () => false,
      );
      await started;
      globalThis.fetch = () =>
        Promise.resolve(
          new Response(JSON.stringify({ error: "Forbidden" }), {
            headers: { "X-MiyulabMD-Session-User": "user:alice" },
            status: 403,
          }),
        );
      const denial = await denyingReader.read(note.id);
      release();
      return { denial, stalePublished: await pending };
    } finally {
      release();
      Blob.prototype.text = originalText;
      globalThis.fetch = originalFetch;
      cachedReader.dispose();
      denyingReader.dispose();
      cache.close();
    }
  }, note);
  expect(result.denial).toMatchObject({ ok: false, status: 403 });
  expect(result.stalePublished).toBe(false);
});
