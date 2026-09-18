import { expect, test } from "@playwright/test";
import { note } from "./fixtures/note.ts";

test("direct cache denial prevents an already-reading body from being returned", async ({
  page,
}) => {
  await page.goto("/tests/browser/fixtures/storage.html");
  const result = await page.evaluate(async (note) => {
    const moduleUrl = "/src/lib/offline-cache.ts";
    const { openOfflineCache } = await import(moduleUrl);
    const cache = await openOfflineCache({ userId: "alice" });
    await cache.putNote(note);
    const originalText = Blob.prototype.text;
    let reading: () => void = () => {
      // Assigned synchronously below.
    };
    let release: () => void = () => {
      // Assigned synchronously below.
    };
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
    try {
      const pending = cache.getNote(note.id);
      await started;
      await cache.denyNote(note.id);
      release();
      return await pending;
    } finally {
      release();
      Blob.prototype.text = originalText;
      cache.close();
    }
  }, note);
  expect(result).toBeNull();
});

test("a short-ID HTTP denial also hides its canonical cached body and list entry", async ({
  page,
}) => {
  await page.goto("/tests/browser/fixtures/storage.html");
  const result = await page.evaluate(async (note) => {
    const cacheUrl = "/src/lib/offline-cache.ts";
    const sessionUrl = "/src/lib/note-read-session.ts";
    const { openOfflineCache } = await import(cacheUrl);
    const { createNoteReadSession } = await import(sessionUrl);
    const cache = await openOfflineCache({ userId: "alice" });
    const { markdown: _markdown, ...summary } = note;
    await cache.putNote(note);
    await cache.putNoteList([summary]);
    const session = createNoteReadSession({
      cacheViewerId: "alice",
      mode: "authenticated",
      user: {
        displayName: "Alice",
        email: "alice@example.test",
        id: "alice",
      },
    });
    const original = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: "Forbidden" }), {
        headers: { "X-MiyulabMD-Session-User": "user:alice" },
        status: 403,
      });
    try {
      const denied = await session.read(note.shortId);
      return {
        canonical: await cache.getNote(note.id),
        list: (await cache.getNoteList())?.notes,
        short: await cache.getNote(note.shortId),
        status: denied.status,
      };
    } finally {
      globalThis.fetch = original;
      session.dispose();
      cache.close();
    }
  }, note);
  expect(result).toEqual({
    canonical: null,
    list: [],
    short: null,
    status: 403,
  });
});
