import { expect, test } from "@playwright/test";
import { note } from "./fixtures/note.ts";

test("denial invalidates an older network request even when its database cannot open", async ({
  page,
}) => {
  await page.goto("/tests/browser/fixtures/storage.html");
  const result = await page.evaluate(async (note) => {
    const moduleUrl = "/src/lib/note-read-session.ts";
    const { createNoteReadSession } = await import(moduleUrl);
    const barrierUrl = "/tests/browser/fixtures/deferred-cache-open.ts";
    const { deferNextDatabaseOpen } = await import(barrierUrl);
    const viewer = {
      cacheViewerId: "alice",
      mode: "authenticated",
      user: {
        displayName: "Alice",
        email: "alice@example.test",
        id: "alice",
      },
    };
    const slowReader = createNoteReadSession(viewer);
    const denyingReader = createNoteReadSession(viewer);
    const newReader = createNoteReadSession(viewer);
    const originalFetch = globalThis.fetch;
    const opening = deferNextDatabaseOpen();
    let requests = 0;
    globalThis.fetch = () => {
      requests += 1;
      return Promise.resolve(
        requests === 2
          ? new Response(JSON.stringify({ error: "Forbidden" }), {
              headers: { "X-MiyulabMD-Session-User": "user:alice" },
              status: 403,
            })
          : new Response(JSON.stringify(note), {
              headers: { "X-MiyulabMD-Session-User": "user:alice" },
              status: 200,
            }),
      );
    };
    try {
      const oldRequest = slowReader.read(note.id).then(
        (value: { ok: boolean }) => value.ok,
        () => false,
      );
      // HTTP sharing has finished; the older read is still unpublished while
      // opening storage. A later HTTP denial must invalidate it at this stage.
      await opening.started;
      IDBFactory.prototype.open = () => {
        throw new DOMException("Database unavailable", "UnknownError");
      };
      const denial = await denyingReader.read(note.id);
      opening.restore();
      const oldPublished = await oldRequest;
      // Cache suspension must not prohibit a genuinely new online response.
      const fresh = await newReader.read(note.id);
      return { denial, fresh, oldPublished };
    } finally {
      opening.restore();
      globalThis.fetch = originalFetch;
      slowReader.dispose();
      denyingReader.dispose();
      newReader.dispose();
    }
  }, note);
  expect(result.denial).toMatchObject({ ok: false, status: 403 });
  expect(result.denial.cacheWarning).toContain("キャッシュ");
  expect(result.oldPublished).toBe(false);
  expect(result.fresh).toMatchObject({ ok: true, source: "network" });
});
