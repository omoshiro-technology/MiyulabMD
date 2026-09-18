import { expect, test } from "@playwright/test";
import { note } from "./fixtures/note.ts";

test("a confirmed Home folder denial removes stale navigation without denying independent children", async ({
  page,
}) => {
  await page.goto("/tests/browser/fixtures/storage.html");
  const result = await page.evaluate(async (note) => {
    const cacheUrl = "/src/lib/offline-cache.ts";
    const homeUrl = "/src/lib/home-metadata-reader.ts";
    const { openOfflineCache } = await import(cacheUrl);
    const { readHomeMetadata } = await import(homeUrl);
    const cache = await openOfflineCache({ userId: "alice" });
    const rootCrumb = { id: "root-id", name: "Root" };
    const deniedCrumb = { id: "denied", name: "Denied" };
    const childCrumb = { id: "independent", name: "Independent" };
    const base = { ...note.access, children: [], folder: "", locked: false };
    await cache.putFolder(
      {
        ...base,
        children: [{ ...deniedCrumb, folder: "Denied", parentId: "root-id" }],
        crumbs: [rootCrumb],
        id: rootCrumb.id,
        name: rootCrumb.name,
        parentId: null,
      },
      { asDriveRoot: true },
    );
    await cache.putFolder({
      ...base,
      crumbs: [rootCrumb, deniedCrumb],
      id: deniedCrumb.id,
      name: deniedCrumb.name,
      parentId: rootCrumb.id,
    });
    await cache.putFolder({
      ...base,
      crumbs: [rootCrumb, deniedCrumb, childCrumb],
      folder: "Denied/Independent",
      id: childCrumb.id,
      name: childCrumb.name,
      parentId: deniedCrumb.id,
    });
    const { markdown: _markdown, ...summary } = note;
    await cache.putNoteList([summary]);
    const original = globalThis.fetch;
    globalThis.fetch = (input) => {
      const isList = String(input).endsWith("/api/notes");
      return Promise.resolve(
        new Response(
          JSON.stringify(isList ? { notes: [summary] } : { error: "Denied" }),
          {
            headers: { "X-MiyulabMD-Session-User": "user:alice" },
            status: isList ? 200 : 403,
          },
        ),
      );
    };
    try {
      const status = await readHomeMetadata({
        folderId: "denied",
        isCurrentOwner: () => true,
        signal: new AbortController().signal,
        viewer: {
          cacheViewerId: "alice",
          mode: "authenticated",
          user: {
            displayName: "Alice",
            email: "alice@example.test",
            id: "alice",
          },
        },
      }).then(
        () => 200,
        (error: { status?: number }) => error.status,
      );
      // The denial persists detached from the rejected read: poll until the
      // marker lands before asserting the projected cache contents.
      let denied: unknown = await cache.getFolder("denied");
      for (let attempt = 0; denied !== null && attempt < 100; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        denied = await cache.getFolder("denied");
      }
      return {
        children: (await cache.getFolder(null))?.folder.children,
        denied,
        independent: (await cache.getFolder("independent"))?.folder,
        notes: (await cache.getNoteList())?.notes.map(
          (entry: { id: string }) => entry.id,
        ),
        status,
      };
    } finally {
      globalThis.fetch = original;
      cache.close();
    }
  }, note);
  expect(result.status).toBe(403);
  expect(result.denied).toBeNull();
  expect(result.children).toEqual([]);
  expect(result.independent.crumbs).toEqual([
    { id: "independent", name: "Independent" },
  ]);
  expect(result.independent.parentId).toBeNull();
  expect(result.notes).toEqual([note.id]);
});
