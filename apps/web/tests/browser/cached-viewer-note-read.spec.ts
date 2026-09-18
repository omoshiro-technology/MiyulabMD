import { expect, test } from "@playwright/test";
import { note } from "./fixtures/note.ts";

test("an unverified cached viewer reads only local notes and does not fetch on a miss", async ({
  page,
}) => {
  let requests = 0;
  await page.route("**/api/notes/**", (route) => {
    requests += 1;
    return route.fulfill({
      headers: { "X-MiyulabMD-Session-User": "user:bob" },
      json: {
        ...note,
        markdown: "Unverified network response",
        ownerId: "bob",
      },
    });
  });
  await page.goto("/tests/browser/fixtures/storage.html");
  const result = await page.evaluate(async (note) => {
    const cacheUrl = "/src/lib/offline-cache.ts";
    const readerUrl = "/src/lib/note-read-session.ts";
    const { openOfflineCache } = await import(cacheUrl);
    const { createNoteReadSession, OfflineNoteUnavailableError } = await import(
      readerUrl
    );
    const cache = await openOfflineCache({ userId: "alice" });
    await cache.putNote(note);
    const before = await cache.getNote(note.id);
    const reader = createNoteReadSession({
      cacheViewerId: "alice",
      mode: "cached",
      user: null,
    });
    try {
      const hit = await reader.read(note.id);
      let miss: { hasHttpStatus?: boolean; name?: string; typed: boolean };
      try {
        await reader.read("not-cached");
        miss = { name: "unexpected success", typed: false };
      } catch (error) {
        miss = {
          hasHttpStatus:
            typeof error === "object" && error !== null && "status" in error,
          name: error instanceof Error ? error.name : undefined,
          typed:
            typeof OfflineNoteUnavailableError === "function" &&
            error instanceof OfflineNoteUnavailableError,
        };
      }
      return {
        after: (await cache.getNote(note.id))?.note.markdown,
        cachedAt: before?.cachedAt,
        hit,
        miss,
      };
    } finally {
      reader.dispose();
      cache.close();
    }
  }, note);
  expect(result.hit).toMatchObject({
    cachedAt: result.cachedAt,
    data: { markdown: note.markdown },
    ok: true,
    source: "cache",
    viewer: { cacheViewerId: "alice", mode: "cached", user: null },
  });
  expect(result.miss).toEqual({
    hasHttpStatus: false,
    name: "OfflineNoteUnavailableError",
    typed: true,
  });
  expect(result.after).toBe(note.markdown);
  expect(requests).toBe(0);
});
