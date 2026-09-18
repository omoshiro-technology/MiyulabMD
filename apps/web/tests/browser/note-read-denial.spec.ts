import { expect, test } from "@playwright/test";
import { note } from "./fixtures/note.ts";

test("confirmed denial removes only the affected viewer's note and survives a new session", async ({
  page,
}) => {
  let response: number | "offline" = 403;
  await page.route(`**/api/notes/${note.id}`, (route) =>
    response === "offline"
      ? route.abort("internetdisconnected")
      : route.fulfill({
          headers: { "X-MiyulabMD-Session-User": "user:alice" },
          json: { error: "Denied or missing" },
          status: response,
        }),
  );
  await page.goto("/tests/browser/fixtures/storage.html");

  const read = () =>
    page.evaluate(async (id) => {
      const moduleUrl = "/src/lib/note-read-session.ts";
      const { createNoteReadSession } = await import(moduleUrl);
      const session = createNoteReadSession({
        cacheViewerId: "alice",
        mode: "authenticated",
        user: {
          displayName: "Alice",
          email: "alice@example.test",
          id: "alice",
        },
      });
      try {
        return { error: null, result: await session.read(id) };
      } catch (error) {
        return {
          error: error instanceof Error ? error.name : "UnknownError",
          result: null,
        };
      } finally {
        session.dispose();
      }
    }, note.id);

  for (const status of [403, 404]) {
    response = status;
    await page.evaluate(async (note) => {
      const moduleUrl = "/src/lib/offline-cache.ts";
      const { openOfflineCache } = await import(moduleUrl);
      const alice = await openOfflineCache({ userId: "alice" });
      const bob = await openOfflineCache({ userId: "bob" });
      try {
        await alice.putNote(note);
        await alice.putNote({
          ...note,
          id: "unrelated-note",
          shortId: "unrelated-short",
        });
        await bob.putNote({ ...note, markdown: "Bob's separate cached copy" });
        const { markdown: _markdown, ...summary } = note;
        await alice.putNoteList([
          summary,
          { ...summary, id: "unrelated-note", shortId: "unrelated-short" },
        ]);
        await bob.putNoteList([summary]);
      } finally {
        alice.close();
        bob.close();
      }
    }, note);

    const denied = await read();
    expect(denied.error, `${status}`).toBeNull();
    expect(denied.result, `${status}`).toMatchObject({ ok: false, status });
    expect(denied.result, `${status}`).not.toHaveProperty("data");

    const cached = await page.evaluate(async (id) => {
      const moduleUrl = "/src/lib/offline-cache.ts";
      const { openOfflineCache } = await import(moduleUrl);
      const alice = await openOfflineCache({ userId: "alice" });
      const bob = await openOfflineCache({ userId: "bob" });
      try {
        return {
          aliceList: (await alice.getNoteList())?.notes.map(
            (item: { id: string }) => item.id,
          ),
          bobList: (await bob.getNoteList())?.notes.map(
            (item: { id: string }) => item.id,
          ),
          denied: await alice.getNote(id),
          otherViewer: (await bob.getNote(id))?.note.markdown ?? null,
          unrelated: (await alice.getNote("unrelated-note"))?.note.id ?? null,
        };
      } finally {
        alice.close();
        bob.close();
      }
    }, note.id);
    expect(cached, `${status}`).toEqual({
      aliceList: ["unrelated-note"],
      bobList: [note.id],
      denied: null,
      otherViewer: "Bob's separate cached copy",
      unrelated: "unrelated-note",
    });

    // A new reader has no in-memory denial set to hide an undeleted snapshot.
    response = "offline";
    const offline = await read();
    expect(offline.result?.ok ?? false, `${status}`).toBe(false);
    expect(offline.result, `${status}`).toBeNull();
    expect(offline.error, `${status}`).toBe("ApiCommunicationError");
  }
});
