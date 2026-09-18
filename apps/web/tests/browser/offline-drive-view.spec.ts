import type { FolderAccess, NoteSummary } from "@miyulabmd/shared";
import { expect, test } from "@playwright/test";

const root: FolderAccess = {
  children: [{ id: "docs", name: "資料", parentId: null }],
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

const docs: FolderAccess = {
  ...root,
  children: [
    { id: "empty", name: "空のフォルダ", parentId: "docs" },
    { id: "missing", name: "未取得のフォルダ", parentId: "docs" },
  ],
  crumbs: [{ id: "docs", name: "資料" }],
  folder: "資料",
  id: "docs",
  name: "資料",
};

const empty: FolderAccess = {
  ...docs,
  children: [],
  crumbs: [...docs.crumbs, { id: "empty", name: "空のフォルダ" }],
  folder: "資料/空のフォルダ",
  id: "empty",
  name: "空のフォルダ",
  parentId: "docs",
};

const note: NoteSummary = {
  access: {
    effectiveReadScope: "self",
    effectiveWriteScope: "self",
    flags: { canAdmin: true, canEdit: true, canView: true },
    grants: [],
    inherit: true,
    readScope: null,
    source: "default",
    sourceFolder: null,
    writeScope: null,
  },
  alias: null,
  articleMeta: {},
  createdAt: 1,
  folder: "資料",
  folderId: "docs",
  id: "saved-note",
  ownerId: "alice",
  permission: "private",
  shortId: "saved-short",
  title: "保存済みの資料",
  updatedAt: 2,
};

test("a cached viewer navigates MyDrive without network reads or mutation controls", async ({
  page,
}) => {
  await page.goto("/tests/browser/fixtures/storage.html");
  await page.evaluate(
    async ({ root, docs, empty, note, moduleUrl }) => {
      const { openOfflineCache, persistCachedViewerId } = await import(
        moduleUrl
      );
      await persistCachedViewerId("alice");
      const cache = await openOfflineCache({ userId: "alice" });
      try {
        await cache.putFolder(root);
        await cache.putFolder(docs);
        await cache.putFolder(empty);
        await cache.putNoteList([note]);
      } finally {
        cache.close();
      }
    },
    { docs, empty, moduleUrl: "/src/lib/offline-cache.ts", note, root },
  );

  const dataRequests: string[] = [];
  await page.route("**/api/**", (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (/^\/api\/(?:notes|folders)(?:\/|$)/.test(pathname)) {
      dataRequests.push(pathname);
    }
    return route.abort("internetdisconnected");
  });

  // Keep the Vite shell reachable: this exercises data navigation, not a SW.
  await page.goto("/");
  await expect(page.getByRole("button", { name: "オフライン" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "全体公開" })).toHaveCount(0);
  await expect(
    page.getByRole("link", { exact: true, name: "資料" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: note.title })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "新規ノート" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /の操作$/ })).toHaveCount(0);

  await page.getByRole("link", { exact: true, name: "資料" }).click();
  await expect(page).toHaveURL(/\/f\/docs$/);
  await expect(page.getByRole("link", { name: note.title })).toBeVisible();
  await page.getByRole("link", { name: note.title }).hover();
  await expect(page.getByRole("button", { name: /の操作$/ })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("link", { name: note.title })).toBeVisible();
  await expect(page.getByRole("button", { name: "オフライン" })).toBeVisible();

  await page.getByRole("link", { exact: true, name: "空のフォルダ" }).click();
  await expect(page).toHaveURL(/\/f\/empty$/);
  await expect(
    page.getByText("このフォルダは空です。", { exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "上のフォルダへ" }).click();
  await expect(page).toHaveURL(/\/f\/docs$/);
  await page
    .getByRole("navigation", { exact: true, name: "フォルダ" })
    .getByRole("link", { exact: true, name: "マイドライブ" })
    .click();
  await expect(page).toHaveURL(/\/$/);
  await page.getByRole("link", { exact: true, name: "資料" }).click();
  await page
    .getByRole("link", { exact: true, name: "未取得のフォルダ" })
    .click();
  await expect(page).toHaveURL(/\/f\/missing$/);
  await expect(page.getByText(/キャッシュに保存されていません/)).toBeVisible();
  await expect(
    page.getByText("このフォルダは空です。", { exact: true }),
  ).toHaveCount(0);
  expect(dataRequests).toEqual([]);
});

for (const mode of ["authenticated", "guest"] as const) {
  test(`normal ${mode} Home keeps its online listing and controls`, async ({
    page,
  }) => {
    await page.route("**/api/**", (route) => {
      const pathname = new URL(route.request().url()).pathname;
      const headers = {
        "X-MiyulabMD-Session-User":
          mode === "authenticated" ? "user:alice" : "guest",
      };
      switch (pathname) {
        case "/api/me":
          return route.fulfill({
            headers,
            json: {
              user:
                mode === "authenticated"
                  ? {
                      displayName: "Alice",
                      email: "alice@example.test",
                      id: "alice",
                    }
                  : null,
            },
          });
        case "/api/auth/config":
          return route.fulfill({
            headers,
            json: { access: false, mock: true },
          });
        case "/api/notes":
          return route.fulfill({ headers, json: { notes: [] } });
        case "/api/folders":
          return route.fulfill({ headers, json: root });
        case "/api/folders/public":
          return route.fulfill({ headers, json: { folders: root.children } });
        default:
          return route.fulfill({
            headers,
            json: { error: "No fixture" },
            status: 404,
          });
      }
    });

    await page.goto("/");
    await expect(
      page.getByRole("link", { exact: true, name: "資料" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { exact: true, name: "新規ノート" }),
    ).toBeEnabled();
    await expect(page.getByText(/キャッシュから閲覧中/)).toHaveCount(0);

    if (mode === "authenticated") {
      await page.getByRole("button", { exact: true, name: "フォルダ" }).click();
      await expect(
        page.getByRole("dialog", { name: "フォルダを作成" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "キャンセル" }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
    } else {
      await expect(
        page.getByRole("heading", { name: "全体公開" }),
      ).toBeVisible();
    }
  });
}

test("a pending drive snapshot degrades to an empty view after user suspension", async ({
  page,
}) => {
  await page.goto("/tests/browser/fixtures/storage.html");
  const result = await page.evaluate(async (root) => {
    const storageUrl = "/src/lib/offline-cache.ts";
    const readerUrl = "/src/lib/cached-drive-reader.ts";
    const { openOfflineCache, suspendOfflineCacheUser } = await import(
      storageUrl
    );
    const { readCachedDrive } = await import(readerUrl);
    const cache = await openOfflineCache({ userId: "alice" });
    await cache.putFolder(root);
    await cache.putNoteList([]);
    cache.close();

    let folderCompleted: () => void = () => {
      // Assigned synchronously by the promise constructor below.
    };
    let listWaiting: () => void = () => {
      // Assigned synchronously by the promise constructor below.
    };
    let releaseList: () => void = () => {
      // Assigned synchronously by the promise constructor below.
    };
    const folderReady = new Promise<void>((resolve) => {
      folderCompleted = resolve;
    });
    const listReady = new Promise<void>((resolve) => {
      listWaiting = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    let folderStarted = false;
    const originalTransaction = IDBDatabase.prototype.transaction;
    const originalGet = IDBObjectStore.prototype.get;
    const success = Object.getOwnPropertyDescriptor(
      IDBRequest.prototype,
      "onsuccess",
    );
    if (!success?.set) {
      throw new Error("Native IndexedDB success boundary unavailable");
    }

    IDBDatabase.prototype.transaction = function (
      this: IDBDatabase,
      ...args: Parameters<IDBDatabase["transaction"]>
    ) {
      const transaction = originalTransaction.apply(this, args);
      if (args[0] === "folders" && args[1] === "readonly") {
        folderStarted = true;
        transaction.addEventListener("complete", folderCompleted, {
          once: true,
        });
      }
      return transaction;
    };
    IDBObjectStore.prototype.get = function (
      this: IDBObjectStore,
      ...args: Parameters<IDBObjectStore["get"]>
    ) {
      const request = originalGet.apply(this, args);
      if (this.name === "note-lists") {
        Object.defineProperty(request, "onsuccess", {
          set(handler: (event: Event) => void) {
            success.set?.call(request, (event: Event) => {
              listWaiting();
              void released.then(() => handler.call(request, event));
            });
          },
        });
      }
      return request;
    };

    try {
      const pending = readCachedDrive("alice", null).then(
        (value: unknown) => ({ rejected: false, value }),
        () => ({ rejected: true, value: null }),
      );
      await listReady;
      // A parallel reader already has a folder request; a folder-last reader
      // degrades to an empty view rather than being forced to fail.
      if (folderStarted) {
        await folderReady;
      }
      suspendOfflineCacheUser("alice");
      releaseList();
      return await pending;
    } finally {
      releaseList();
      IDBDatabase.prototype.transaction = originalTransaction;
      IDBObjectStore.prototype.get = originalGet;
    }
  }, root);
  // Suspension turns the read into a cache miss — it never rejects the
  // display path with a cache-internal error.
  expect(result.rejected).toBe(false);
  expect(result.value).toMatchObject({
    folder: null,
    folderMissing: true,
    notes: [],
    notesMissing: true,
  });
});

test("MyDrive root keeps its canonical server ID across cached routes and updates", async ({
  page,
}) => {
  const rootId = "drive-root-alice";
  const serverRoot: FolderAccess = {
    ...root,
    children: [{ id: "docs", name: "資料", parentId: rootId }],
    id: rootId,
    locked: true,
  };
  const rootNote: NoteSummary = {
    ...note,
    folder: "",
    folderId: rootId,
    title: "ルート直下のノート",
  };
  await page.goto("/tests/browser/fixtures/storage.html");
  const snapshots = await page.evaluate(
    async ({ serverRoot, docs, rootNote, moduleUrl }) => {
      const { openOfflineCache, persistCachedViewerId } = await import(
        moduleUrl
      );
      await persistCachedViewerId("alice");
      const cache = await openOfflineCache({ userId: "alice" });
      try {
        await cache.putFolder(serverRoot, { asDriveRoot: true });
        const boundRoot = await cache.getFolder(null);
        // A normal fetch by canonical ID must also update the root route.
        await cache.putFolder({
          ...serverRoot,
          children: [
            ...serverRoot.children,
            { id: "new-docs", name: "追加資料", parentId: serverRoot.id },
          ],
        });
        await cache.putFolder({ ...docs, parentId: serverRoot.id });
        await cache.putNoteList([rootNote]);
        return {
          boundRoot,
          canonical: await cache.getFolder(serverRoot.id),
          rootRoute: await cache.getFolder(null),
        };
      } finally {
        cache.close();
      }
    },
    { docs, moduleUrl: "/src/lib/offline-cache.ts", rootNote, serverRoot },
  );
  expect(snapshots.boundRoot?.folder.id).toBe(rootId);
  expect(snapshots.rootRoute).toEqual(snapshots.canonical);
  expect(snapshots.rootRoute?.folder.children).toHaveLength(2);

  await page.route("**/api/**", (route) => route.abort("internetdisconnected"));
  await page.goto("/");
  await expect(page.getByRole("link", { name: rootNote.title })).toBeVisible();
  await expect(page.getByRole("link", { name: "追加資料" })).toBeVisible();
  await page.getByRole("link", { exact: true, name: "資料" }).click();
  await expect(page).toHaveURL(/\/f\/docs$/);
  await page.getByRole("link", { name: "上のフォルダへ" }).click();
  await expect(page).toHaveURL(`/f/${rootId}`);
  await expect(page.getByRole("link", { name: rootNote.title })).toBeVisible();
  await expect(page.getByRole("link", { name: "上のフォルダへ" })).toHaveCount(
    0,
  );
  await page.reload();
  await expect(page.getByRole("link", { name: rootNote.title })).toBeVisible();
  await page
    .getByRole("navigation", { exact: true, name: "フォルダ" })
    .getByRole("link", { exact: true, name: "マイドライブ" })
    .click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("link", { name: rootNote.title })).toBeVisible();
});

test("online Home visits automatically save directory snapshots for readonly reload", async ({
  page,
}) => {
  const rootId = "online-drive-root";
  const serverRoot: FolderAccess = {
    ...root,
    children: [{ id: "docs", name: "資料", parentId: rootId }],
    id: rootId,
    locked: true,
  };
  const serverDocs: FolderAccess = {
    ...docs,
    children: [],
    parentId: rootId,
  };
  const rootNote: NoteSummary = {
    ...note,
    folder: "",
    folderId: rootId,
    id: "online-root-note",
    shortId: "online-root-short",
    title: "ルートのオンラインノート",
  };
  const docNote: NoteSummary = { ...note, title: "オンラインで開いた資料" };
  let offline = false;
  const requestsByDocument: { path: string; loaderId: string }[] = [];
  const session = await page.context().newCDPSession(page);
  await session.send("Network.enable");
  session.on("Network.requestWillBeSent", (event) => {
    const path = new URL(event.request.url).pathname;
    if (offline && /^\/api\/(?:notes|folders)(?:\/|$)/.test(path)) {
      requestsByDocument.push({ loaderId: event.loaderId, path });
    }
  });
  await page.route("**/api/**", (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (offline) {
      return route.abort("internetdisconnected");
    }
    const headers = { "X-MiyulabMD-Session-User": "user:alice" };
    switch (pathname) {
      case "/api/me":
        return route.fulfill({
          headers,
          json: {
            user: {
              displayName: "Alice",
              email: "alice@example.test",
              id: "alice",
            },
          },
        });
      case "/api/auth/config":
        return route.fulfill({ headers, json: { access: false, mock: true } });
      case "/api/notes":
        return route.fulfill({ headers, json: { notes: [rootNote, docNote] } });
      case "/api/folders":
        return route.fulfill({ headers, json: serverRoot });
      case "/api/folders/docs":
        return route.fulfill({ headers, json: serverDocs });
      default:
        return route.fulfill({
          headers,
          json: { error: "No fixture" },
          status: 404,
        });
    }
  });

  await page.goto("/");
  await expect(page.getByRole("link", { name: rootNote.title })).toBeVisible();
  await page.getByRole("link", { exact: true, name: "資料" }).click();
  await expect(page.getByRole("link", { name: docNote.title })).toBeVisible();

  // Observe the public cache; this test never seeds it or writes snapshots.
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const moduleUrl = "/src/lib/offline-cache.ts";
        const { openOfflineCache } = await import(moduleUrl);
        const cache = await openOfflineCache({ userId: "alice" });
        try {
          return {
            docsId: (await cache.getFolder("docs"))?.folder.id,
            notes: (await cache.getNoteList())?.notes.map(
              (summary: NoteSummary) => summary.id,
            ),
            rootId: (await cache.getFolder(null))?.folder.id,
          };
        } finally {
          cache.close();
        }
      }),
    )
    .toEqual({
      docsId: "docs",
      notes: [rootNote.id, docNote.id],
      rootId,
    });

  // A slow shell response keeps the previous authenticated document alive
  // while reload is in progress. Its background request is not a cached-view
  // request; record Chromium loader IDs to establish the lifetime boundary.
  const { frameTree: previousDocument } =
    await session.send("Page.getFrameTree");
  await page.route("**/f/docs", async (route) => {
    if (offline && route.request().isNavigationRequest()) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    await route.continue();
  });
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  offline = true;
  await page.reload();
  await expect(page.getByRole("link", { name: docNote.title })).toBeVisible();
  await expect(page.getByRole("button", { name: "オフライン" })).toBeVisible();
  await expect(page.getByRole("button", { name: "新規ノート" })).toHaveCount(0);
  await page.getByRole("link", { name: "上のフォルダへ" }).click();
  await expect(page).toHaveURL(`/f/${rootId}`);
  await expect(page.getByRole("link", { name: rootNote.title })).toBeVisible();
  const { frameTree } = await session.send("Page.getFrameTree");
  const cachedDocumentId = frameTree.frame.loaderId;
  expect(cachedDocumentId).not.toBe(previousDocument.frame.loaderId);
  expect(
    requestsByDocument.every(
      ({ loaderId }) =>
        loaderId === previousDocument.frame.loaderId ||
        loaderId === cachedDocumentId,
    ),
  ).toBe(true);
  expect(
    requestsByDocument
      .filter(({ loaderId }) => loaderId === cachedDocumentId)
      .map(({ path }) => path),
  ).toEqual([]);
});
