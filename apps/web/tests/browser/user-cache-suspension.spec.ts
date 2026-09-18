import type { FolderAccess } from "@miyulabmd/shared";
import { expect, test } from "@playwright/test";
import { note } from "./fixtures/note.ts";

const folder: FolderAccess = {
  children: [],
  crumbs: [],
  effectiveReadScope: "self",
  effectiveWriteScope: "self",
  flags: { canAdmin: true, canEdit: true, canView: true },
  folder: "",
  grants: [],
  id: null,
  inherit: true,
  name: "マイドライブ",
  parentId: null,
  readScope: null,
  source: "default",
  sourceFolder: null,
  writeScope: null,
};

for (const fault of ["open", "commit"] as const) {
  test(`denial persistence failure during ${fault} fault warns and keeps cached reads working`, async ({
    page,
  }) => {
    await page.goto("/tests/browser/fixtures/storage.html");
    const input = { fault, folder, note };
    const result = await page.evaluate(async ({ note, folder, fault }) => {
      const cacheUrl = "/src/lib/offline-cache.ts";
      const readerUrl = "/src/lib/note-read-session.ts";
      const { openOfflineCache } = await import(cacheUrl);
      const { createNoteReadSession } = await import(readerUrl);
      const viewer = {
        cacheViewerId: "alice",
        mode: "authenticated",
        user: {
          displayName: "Alice",
          email: "alice@example.test",
          id: "alice",
        },
      };
      const alice = await openOfflineCache({ userId: "alice" });
      const bob = await openOfflineCache({ userId: "bob" });
      const otherNote = { ...note, id: "other-note", shortId: "other-short" };
      const { markdown: _markdown, ...summary } = otherNote;
      await alice.putNote(otherNote);
      await alice.putFolder(folder);
      await alice.putNoteList([summary]);
      await bob.putNote(otherNote);
      await bob.putFolder(folder);
      const cachedReader = createNoteReadSession(viewer);
      const denyingReader = createNoteReadSession(viewer);
      const onlineReader = createNoteReadSession(viewer);
      const originalFetch = globalThis.fetch;
      const originalText = Blob.prototype.text;
      const originalOpen = IDBFactory.prototype.open;
      const originalTransaction = IDBDatabase.prototype.transaction;
      let reading: () => void = () => {
        // Assigned synchronously by the promise constructor below.
      };
      let release: () => void = () => {
        // Assigned synchronously by the promise constructor below.
      };
      const started = new Promise<void>((resolve) => {
        reading = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let readsStarted = 0;
      Blob.prototype.text = async function (this: Blob) {
        const text = await originalText.call(this);
        if (++readsStarted === 2) {
          reading();
        }
        await released;
        return text;
      };
      globalThis.fetch = () =>
        Promise.reject(new TypeError("Network unavailable"));
      let fresh: Awaited<ReturnType<typeof openOfflineCache>> | undefined;
      try {
        const pendingCache = alice.getNote(otherNote.id).catch(() => null);
        const pendingReader = cachedReader.read(otherNote.id).then(
          (value: { ok: boolean }) => value.ok,
          () => false,
        );
        await started;
        globalThis.fetch = async () =>
          new Response(JSON.stringify({ error: "Forbidden" }), {
            headers: { "X-MiyulabMD-Session-User": "user:alice" },
            status: 403,
          });
        if (fault === "open") {
          IDBFactory.prototype.open = () => {
            throw new DOMException("Database unavailable", "UnknownError");
          };
        } else {
          IDBDatabase.prototype.transaction = function (
            this: IDBDatabase,
            ...args: Parameters<IDBDatabase["transaction"]>
          ) {
            const transaction = originalTransaction.apply(this, args);
            if (args[1] === "readwrite") {
              transaction.abort();
            }
            return transaction;
          };
        }
        const denial = await denyingReader.read(note.id);
        IDBFactory.prototype.open = originalOpen;
        IDBDatabase.prototype.transaction = originalTransaction;
        release();
        const staleCache = await pendingCache;
        const stalePublished = await pendingReader;
        fresh = await openOfflineCache({ userId: "alice" });
        const folderWrite = await fresh.putFolder(folder).then(
          () => true,
          () => false,
        );
        const listWrite = await fresh.putNoteList([summary]).then(
          () => true,
          () => false,
        );
        // Optional cache storage must not prevent a valid online view.
        globalThis.fetch = async () =>
          new Response(JSON.stringify(otherNote), {
            headers: { "X-MiyulabMD-Session-User": "user:alice" },
            status: 200,
          });
        const online = await onlineReader.read(otherNote.id);
        return {
          denial,
          existingFolder: (await alice.getFolder(null))?.folder,
          folderWrite,
          freshFolder: (await fresh.getFolder(null))?.folder,
          freshList: (await fresh.getNoteList())?.notes.map(
            (entry) => entry.id,
          ),
          freshNote: (await fresh.getNote(otherNote.id))?.note.id,
          listWrite,
          online,
          otherViewerFolder: (await bob.getFolder(null))?.folder,
          otherViewerNote: (await bob.getNote(otherNote.id))?.note.id,
          staleCache: staleCache?.note.id,
          stalePublished,
        };
      } finally {
        release();
        Blob.prototype.text = originalText;
        globalThis.fetch = originalFetch;
        IDBFactory.prototype.open = originalOpen;
        IDBDatabase.prototype.transaction = originalTransaction;
        cachedReader.dispose();
        denyingReader.dispose();
        onlineReader.dispose();
        alice.close();
        bob.close();
        fresh?.close();
      }
    }, input);
    // The denial ledger is best effort: its failure warns but does not
    // suspend the realm, so every cache kind keeps serving stored data.
    expect(result.denial).toMatchObject({ ok: false, status: 403 });
    expect(result.denial.cacheWarning).toContain("キャッシュ");
    expect(result.staleCache).toBe("other-note");
    expect(result.stalePublished).toBe(true);
    expect(result.existingFolder).toEqual(folder);
    expect(result.freshFolder).toEqual(folder);
    expect(result.freshList).toEqual(["other-note"]);
    expect(result.freshNote).toBe("other-note");
    expect(result.folderWrite).toBe(true);
    expect(result.listWrite).toBe(true);
    expect(result.online).toMatchObject({ ok: true, source: "network" });
    expect(result.otherViewerFolder).toEqual(folder);
    expect(result.otherViewerNote).toBe("other-note");
  });
}
