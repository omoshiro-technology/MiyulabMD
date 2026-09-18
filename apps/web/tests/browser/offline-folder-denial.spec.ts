import type { FolderAccess, FolderCrumb } from "@miyulabmd/shared";
import { expect, test } from "@playwright/test";
import { note } from "./fixtures/note.ts";

function sharedFolder(
  id: string,
  name: string,
  parentId: string | null,
  crumbs: FolderCrumb[],
): FolderAccess {
  return {
    children: [],
    crumbs,
    effectiveReadScope: "all",
    effectiveWriteScope: "self",
    flags: { canAdmin: false, canEdit: false, canView: true },
    grants: [],
    id,
    inherit: false,
    name,
    parentId,
    readScope: "all",
    source: "folder",
    sourceFolder: null,
    writeScope: "self",
  };
}

test("folder denial hides stale navigation references without denying independent children or notes", async ({
  page,
}) => {
  const parentCrumb = { id: "shared", name: "Shared parent" };
  const deniedCrumb = { id: "denied", name: "Previously shared folder" };
  const childCrumb = { id: "child", name: "Independent child" };
  const siblingCrumb = { id: "sibling", name: "Sibling" };
  const parent = {
    ...sharedFolder("shared", parentCrumb.name, null, [parentCrumb]),
    children: [
      { ...deniedCrumb, parentId: "shared" },
      { ...siblingCrumb, parentId: "shared" },
    ],
  };
  const denied = {
    ...sharedFolder("denied", deniedCrumb.name, "shared", [
      parentCrumb,
      deniedCrumb,
    ]),
    children: [{ ...childCrumb, parentId: "denied" }],
  };
  const child = sharedFolder("child", childCrumb.name, "denied", [
    parentCrumb,
    deniedCrumb,
    childCrumb,
  ]);
  const sibling = sharedFolder("sibling", siblingCrumb.name, "shared", [
    parentCrumb,
    siblingCrumb,
  ]);
  const publicNote = {
    ...note,
    access: {
      ...note.access,
      effectiveReadScope: "all" as const,
      flags: { canAdmin: false, canEdit: false, canView: true },
      inherit: false,
      readScope: "all" as const,
    },
    folderId: "denied",
    ownerId: "bob",
    permission: "public" as const,
  };
  const moduleUrl = "/src/lib/offline-cache.ts";
  await page.goto("/tests/browser/fixtures/storage.html");
  await page.evaluate(
    async ({ moduleUrl, parent, denied, child, sibling, publicNote }) => {
      const { openOfflineCache } = await import(moduleUrl);
      const alice = await openOfflineCache({ userId: "alice" });
      const bob = await openOfflineCache({ userId: "bob" });
      try {
        for (const folder of [parent, denied, child, sibling]) {
          await alice.putFolder(folder);
          await bob.putFolder(folder);
        }
        await alice.putNote(publicNote);
        const { markdown: _markdown, ...summary } = publicNote;
        await alice.putNoteList([summary]);
        await alice.denyFolder("denied");
        // A storage write alone is not an authoritative access revalidation.
        await alice.putFolder(denied);
      } finally {
        alice.close();
        bob.close();
      }
    },
    { child, denied, moduleUrl, parent, publicNote, sibling },
  );
  await page.reload();
  const snapshots = await page.evaluate(async (moduleUrl) => {
    const { openOfflineCache } = await import(moduleUrl);
    const alice = await openOfflineCache({ userId: "alice" });
    const bob = await openOfflineCache({ userId: "bob" });
    try {
      return {
        child: (await alice.getFolder("child"))?.folder,
        denied: await alice.getFolder("denied"),
        note: (await alice.getNote("note-1"))?.note,
        notes: (await alice.getNoteList())?.notes,
        otherViewer: (await bob.getFolder("denied"))?.folder,
        parent: (await alice.getFolder("shared"))?.folder,
        sibling: (await alice.getFolder("sibling"))?.folder,
      };
    } finally {
      alice.close();
      bob.close();
    }
  }, moduleUrl);
  expect(snapshots.denied).toBeNull();
  expect(snapshots.parent?.children).toEqual([
    { ...siblingCrumb, parentId: "shared" },
  ]);
  expect(snapshots.child).toMatchObject({
    crumbs: [childCrumb],
    id: "child",
    parentId: null,
  });
  expect(snapshots.sibling).toEqual(sibling);
  expect(snapshots.otherViewer).toEqual(denied);
  expect(snapshots.note).toEqual(publicNote);
  expect(snapshots.notes?.map((summary) => summary.id)).toEqual(["note-1"]);
});

test("a deeper allowed descendant retains its nearest visible parent and cache time", async ({
  page,
}) => {
  const hidden = { id: "denied", name: "Hidden ancestor" };
  const visible = { id: "child", name: "Visible parent" };
  const leaf = { id: "grandchild", name: "Visible leaf" };
  const child = sharedFolder("child", visible.name, "denied", [
    hidden,
    visible,
  ]);
  const grandchild = sharedFolder("grandchild", leaf.name, "child", [
    hidden,
    visible,
    leaf,
  ]);
  await page.goto("/tests/browser/fixtures/storage.html");
  const snapshots = await page.evaluate(
    async ({ child, grandchild }) => {
      const moduleUrl = "/src/lib/offline-cache.ts";
      const { openOfflineCache } = await import(moduleUrl);
      const cache = await openOfflineCache({ userId: "alice" });
      try {
        await cache.putFolder(child);
        await cache.putFolder(grandchild);
        const before = await cache.getFolder("grandchild");
        await cache.denyFolder("denied");
        return { after: await cache.getFolder("grandchild"), before };
      } finally {
        cache.close();
      }
    },
    { child, grandchild },
  );
  expect(snapshots.after?.folder.crumbs).toEqual([visible, leaf]);
  expect(snapshots.after?.folder.parentId).toBe("child");
  expect(snapshots.after?.cachedAt).toBe(snapshots.before?.cachedAt);
});

test("a compound drive read applies folder denial while its note list is pending", async ({
  page,
}) => {
  const hidden = { id: "denied", name: "Hidden ancestor" };
  const visible = { id: "child", name: "Visible parent" };
  const leaf = { id: "grandchild", name: "Visible leaf" };
  const folder = sharedFolder("grandchild", leaf.name, "child", [
    hidden,
    visible,
    leaf,
  ]);
  await page.goto("/tests/browser/fixtures/storage.html");
  const snapshot = await page.evaluate(async (folder) => {
    const storageUrl = "/src/lib/offline-cache.ts";
    const readerUrl = "/src/lib/cached-drive-reader.ts";
    const { openOfflineCache } = await import(storageUrl);
    const { readCachedDrive } = await import(readerUrl);
    const cache = await openOfflineCache({ userId: "alice" });
    await cache.putFolder(folder);
    await cache.putNoteList([]);
    const before = await cache.getFolder(folder.id);
    const started = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const folderScanned = Promise.withResolvers<void>();
    let folderReadStarted = false;
    const originalGet = IDBObjectStore.prototype.get;
    const originalCursor = IDBObjectStore.prototype.openCursor;
    const success = Object.getOwnPropertyDescriptor(
      IDBRequest.prototype,
      "onsuccess",
    );
    if (!success?.set) {
      throw new Error("Native IndexedDB success boundary unavailable");
    }
    IDBObjectStore.prototype.get = function (
      this: IDBObjectStore,
      ...args: Parameters<IDBObjectStore["get"]>
    ) {
      const request = originalGet.apply(this, args);
      if (this.name === "folders") {
        folderReadStarted = true;
      }
      if (this.name === "note-lists") {
        Object.defineProperty(request, "onsuccess", {
          set(handler: (event: Event) => void) {
            success.set?.call(request, (event: Event) => {
              started.resolve();
              void released.promise.then(() => handler.call(request, event));
            });
          },
        });
      }
      return request;
    };
    IDBObjectStore.prototype.openCursor = function (
      this: IDBObjectStore,
      ...args: Parameters<IDBObjectStore["openCursor"]>
    ) {
      const request = originalCursor.apply(this, args);
      if (this.name === "metadata") {
        Object.defineProperty(request, "onsuccess", {
          set(handler: (event: Event) => void) {
            success.set?.call(request, (event: Event) => {
              const finished = request.result === null;
              handler.call(request, event);
              if (finished) {
                folderScanned.resolve();
              }
            });
          },
        });
      }
      return request;
    };
    try {
      const pending = readCachedDrive("alice", folder.id);
      await started.promise;
      // Parallel readers may already hold a folder snapshot. A reader that
      // deliberately reads folders last need not start that read yet.
      if (folderReadStarted) {
        await folderScanned.promise;
      }
      await cache.denyFolder("denied");
      released.resolve();
      return { after: await pending, before };
    } finally {
      released.resolve();
      IDBObjectStore.prototype.get = originalGet;
      IDBObjectStore.prototype.openCursor = originalCursor;
      cache.close();
    }
  }, folder);
  expect(snapshot.after.folder?.crumbs).toEqual([visible, leaf]);
  expect(snapshot.after.folder?.parentId).toBe("child");
  expect(snapshot.after.folderCachedAt).toBe(snapshot.before?.cachedAt);
  expect(snapshot.after.notes).toEqual([]);
  expect(snapshot.after.notesMissing).toBe(false);
});

for (const target of ["denied", "grandchild"] as const) {
  test(`a pending ${target} read applies a denial committed before it returns`, async ({
    page,
  }) => {
    const hidden = { id: "denied", name: "Hidden ancestor" };
    const visible = { id: "child", name: "Visible parent" };
    const leaf = { id: "grandchild", name: "Visible leaf" };
    const denied = sharedFolder("denied", hidden.name, null, [hidden]);
    const descendant = sharedFolder("grandchild", leaf.name, "child", [
      hidden,
      visible,
      leaf,
    ]);
    await page.goto("/tests/browser/fixtures/storage.html");
    const snapshot = await page.evaluate(
      async ({ target, denied, descendant }) => {
        const moduleUrl = "/src/lib/offline-cache.ts";
        const { openOfflineCache } = await import(moduleUrl);
        const cache = await openOfflineCache({ userId: "alice" });
        await cache.putFolder(denied);
        await cache.putFolder(descendant);
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
        const originalGet = IDBObjectStore.prototype.get;
        const success = Object.getOwnPropertyDescriptor(
          IDBRequest.prototype,
          "onsuccess",
        );
        if (!success?.set) {
          throw new Error("Native IndexedDB success boundary unavailable");
        }
        IDBObjectStore.prototype.get = function (
          this: IDBObjectStore,
          ...args: Parameters<IDBObjectStore["get"]>
        ) {
          const request = originalGet.apply(this, args);
          if (this.name === "folders") {
            Object.defineProperty(request, "onsuccess", {
              set(handler: (event: Event) => void) {
                success.set?.call(request, (event: Event) => {
                  reading();
                  void released.then(() => handler.call(request, event));
                });
              },
            });
          }
          return request;
        };
        try {
          const pending = cache.getFolder(target);
          await started;
          await cache.denyFolder("denied");
          release();
          return await pending;
        } finally {
          release();
          IDBObjectStore.prototype.get = originalGet;
          cache.close();
        }
      },
      { denied, descendant, target },
    );
    if (target === "denied") {
      expect(snapshot).toBeNull();
    } else {
      expect(snapshot?.folder.crumbs).toEqual([visible, leaf]);
      expect(snapshot?.folder.parentId).toBe("child");
    }
  });
}
