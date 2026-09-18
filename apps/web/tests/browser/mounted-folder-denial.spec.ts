import { expect, type Page, test } from "@playwright/test";

import { note } from "./fixtures/note.ts";

const folder = {
  children: [],
  crumbs: [],
  effectiveReadScope: "all" as const,
  effectiveWriteScope: "self" as const,
  flags: { canAdmin: false, canEdit: false, canView: true },
  grants: [],
  id: "mounted-folder",
  inherit: false,
  name: "Mounted folder",
  parentId: null,
  readScope: "all" as const,
  source: "folder" as const,
  sourceFolder: null,
  writeScope: "self" as const,
};

function inCache(page: Page, body: string) {
  return page.evaluate(
    async ({ body, folder }) => {
      const module = await import("/src/lib/offline-cache.ts");
      const cache = await module.openOfflineCache({
        userId: "mounted-race",
      });
      try {
        return await new Function(
          "cache",
          "folder",
          `return (${body})(cache, folder);`,
        )(cache, folder);
      } finally {
        cache.close();
      }
    },
    { body, folder },
  );
}

async function open(page: Page) {
  await page.goto("/tests/browser/fixtures/storage.html");
}

test("delayed old deny cannot erase a newer verified folder", async ({
  page,
}) => {
  await open(page);
  const result = await inCache(
    page,
    `async (cache, folder) => {
      const events = [];
      const module = await import("/src/lib/offline-cache.ts");
      const stop = module.subscribeOfflineCacheFolderDenial(() => events.push(true));
      const old = await cache.beginFolderRead(folder.id);
      const fresh = await cache.beginFolderRead(folder.id);
      await cache.putFolder(folder, { orderingToken: fresh });
      const pending = cache.denyFolder(folder.id, old);
      const committed = await pending;
      stop();
      return { committed, events, retained: Boolean(await cache.getFolder(folder.id)) };
    }`,
  );
  expect(result).toEqual({ committed: false, events: [], retained: true });
});

test("current deny commits receipt authority and generation", async ({
  page,
}) => {
  await open(page);
  const result = await inCache(
    page,
    `async (cache, folder) => {
      await cache.putFolder(folder);
      const token = await cache.beginFolderRead(folder.id);
      const receipts = [];
      const module = await import("/src/lib/offline-cache.ts");
      const stop = module.subscribeOfflineCacheFolderDenial((event) => receipts.push(event));
      const committed = await cache.denyFolder(folder.id, token);
      stop();
      return { committed, receipt: receipts[0], token };
    }`,
  );
  expect(result.committed).toBe(true);
  expect(result.receipt.resource).toMatchObject({
    aliases: ["mounted-folder"],
    generation: result.token + 1,
  });
});

test("null and canonical root aliases are denied together", async ({
  page,
}) => {
  await open(page);
  const result = await inCache(
    page,
    `async (cache, folder) => {
      await cache.putFolder({ ...folder, id: "canonical-root" }, { asDriveRoot: true });
      const token = await cache.beginFolderRead(null);
      await cache.denyFolder(null, token);
      return [await cache.getFolder(null), await cache.getFolder("canonical-root")];
    }`,
  );
  expect(result).toEqual([null, null]);
});

test("literal root and sentinel ids are not aliases", async ({ page }) => {
  await open(page);
  const result = await inCache(
    page,
    `async (cache, folder) => {
      await cache.putFolder({ ...folder, id: "root" });
      await cache.putFolder({ ...folder, id: "__root__" });
      return [Boolean(await cache.getFolder("root")), Boolean(await cache.getFolder("__root__"))];
    }`,
  );
  expect(result).toEqual([true, true]);
});

test("authority reads every alias when only alias one is missing", async ({
  page,
}) => {
  await open(page);
  const result = await inCache(
    page,
    `async (cache, folder) => {
      const module = await import("/src/lib/offline-cache.ts");
      const receipts = [];
      const stop = module.subscribeOfflineCacheFolderDenial((event) => receipts.push(event));
      const token = await cache.beginFolderRead(folder.id);
      await cache.denyFolder(folder.id, token);
      stop();
      const committed = receipts[0];
      return module.readOfflineFolderDenial({
        ...committed,
        resource: { ...committed.resource, aliases: ["missing", folder.id] },
      });
    }`,
  );
  expect(result).toBe(true);
});

test("old receipt after fresh clear reports false and keeps mounted state", async ({
  page,
}) => {
  await open(page);
  const result = await inCache(
    page,
    `async (cache, folder) => {
      await cache.putFolder(folder);
      const token = await cache.beginFolderRead(folder.id);
      await cache.clearFolderDenial(folder.id, token);
      const module = await import("/src/lib/offline-cache.ts");
      const authority = await module.readOfflineFolderDenial({
        type: "invalidate", userId: "mounted-race",
        resource: { type: "folder", aliases: [folder.id], epoch: "0", generation: token },
      });
      return { authority, retained: Boolean(await cache.getFolder(folder.id)) };
    }`,
  );
  expect(result).toEqual({ authority: false, retained: true });
});

test("unrelated folder denial leaves current mounted target unchanged", async ({
  page,
}) => {
  await open(page);
  const result = await inCache(
    page,
    `async (cache, folder) => {
      await cache.putFolder(folder);
      const token = await cache.beginFolderRead("other");
      await cache.denyFolder("other", token);
      return (await cache.getFolder(folder.id))?.folder.id;
    }`,
  );
  expect(result).toBe("mounted-folder");
});

test("direct denied note is removed while descendant note remains", async ({
  page,
}) => {
  await open(page);
  const result = await inCache(
    page,
    `async (cache, folder) => {
      await cache.putNoteList([{ id: "direct", folderId: folder.id }, { id: "child", folderId: "descendant" }]);
      await cache.denyFolder(folder.id, await cache.beginFolderRead(folder.id));
      return (await cache.getNoteList())?.notes.map((note) => note.id);
    }`,
  );
  expect(result).toEqual(["child"]);
});

const sessionHeaders = { "X-MiyulabMD-Session-User": "user:alice" };
const authenticatedUser = {
  displayName: "Alice",
  email: "alice@example.test",
  id: "alice",
};

function folderFixture(
  id: string,
  name: string,
  parentId: string | null,
  children: { id: string; name: string; parentId: string | null }[],
  crumbs: { id: string; name: string }[] = [],
) {
  return {
    children,
    crumbs,
    effectiveReadScope: "all" as const,
    effectiveWriteScope: "self" as const,
    flags: { canAdmin: true, canEdit: true, canView: true },
    folder: crumbs
      .map((crumb) => crumb.name)
      .concat(parentId ? [name] : [])
      .join("/"),
    grants: [],
    id,
    inherit: false,
    name,
    parentId,
    readScope: "all" as const,
    source: "folder" as const,
    sourceFolder: null,
    writeScope: "self" as const,
  };
}

async function routeAuthenticatedHome(
  page: Page,
  folders: Record<string, ReturnType<typeof folderFixture>>,
  notes: unknown[],
  deniedFolders = new Set<string>(),
) {
  await page.route("**/api/**", (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/me") {
      return route.fulfill({
        headers: sessionHeaders,
        json: { user: authenticatedUser },
      });
    }
    if (pathname === "/api/auth/config") {
      return route.fulfill({
        headers: sessionHeaders,
        json: { access: false, mock: true },
      });
    }
    if (pathname === "/api/notes") {
      return route.fulfill({ headers: sessionHeaders, json: { notes } });
    }
    if (pathname === "/api/folders") {
      return route.fulfill({
        headers: sessionHeaders,
        json: folders.root,
      });
    }
    const folderId = pathname.match(/^\/api\/folders\/([^/]+)$/)?.[1];
    if (folderId && folders[folderId]) {
      if (deniedFolders.has(folderId)) {
        return route.fulfill({
          headers: sessionHeaders,
          json: { error: "Denied" },
          status: 403,
        });
      }
      return route.fulfill({
        headers: sessionHeaders,
        json: folders[folderId],
      });
    }
    return route.fulfill({
      headers: sessionHeaders,
      json: { error: "No fixture" },
      status: 404,
    });
  });
}

type DenyFolderPeerOptions = {
  token?: number;
  userId?: string;
};

async function denyFolderFromPeer(
  peer: Page,
  id: string,
  tokenOrOptions?: number | DenyFolderPeerOptions,
  userId = "alice",
) {
  const token =
    typeof tokenOrOptions === "number" ? tokenOrOptions : tokenOrOptions?.token;
  const cacheUserId =
    typeof tokenOrOptions === "object"
      ? (tokenOrOptions.userId ?? userId)
      : userId;
  await peer.goto("/tests/browser/fixtures/storage.html");
  await peer.evaluate(
    async ({ id, token, userId }) => {
      const { openOfflineCache } = await import("/src/lib/offline-cache.ts");
      const cache = await openOfflineCache({ userId });
      try {
        await cache.denyFolder(id, token);
      } finally {
        cache.close();
      }
    },
    { id, token, userId: cacheUserId },
  );
}

async function denyNoteFromPeer(peer: Page, id: string) {
  await peer.goto("/tests/browser/fixtures/storage.html");
  await peer.evaluate(async (noteId) => {
    const { openOfflineCache } = await import("/src/lib/offline-cache.ts");
    const cache = await openOfflineCache({ userId: "alice" });
    try {
      await cache.denyNote(noteId);
    } finally {
      cache.close();
    }
  }, id);
}

function trackApiRequests(page: Page) {
  const paths: string[] = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith("/api/")) {
      paths.push(pathname);
    }
  });
  return paths;
}

test("mounted network folder removes only the denied current view", async ({
  page,
  context,
}) => {
  const current = folderFixture(
    "mounted-current",
    "Mounted Current",
    null,
    [],
    [{ id: "mounted-current", name: "Mounted Current" }],
  );
  const other = folderFixture("mounted-other", "Mounted Other", null, []);
  const targetNote = {
    ...note,
    createdAt: 3,
    folderId: current.id,
    id: "mounted-target-note",
    shortId: "mounted-target-short",
    title: "Mounted Target Note",
    updatedAt: 4,
  };
  const unrelatedNote = {
    ...targetNote,
    createdAt: 5,
    id: "mounted-unrelated-note",
    shortId: "mounted-unrelated-short",
    title: "Mounted Unrelated Note",
    updatedAt: 6,
  };
  const apiRequests = trackApiRequests(page);
  const deniedFolders = new Set<string>();
  await routeAuthenticatedHome(
    page,
    { root: current, [current.id]: current, [other.id]: other },
    [targetNote, unrelatedNote],
    deniedFolders,
  );
  await page.goto(`/f/${current.id}`);
  await expect(
    page.getByRole("navigation", { name: "フォルダ" }).getByText(current.name),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: targetNote.title }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "フォルダ" })
      .getByText("マイドライブ"),
  ).toBeVisible();
  const folderRequestCount = apiRequests.filter((path) =>
    path.startsWith("/api/folders"),
  ).length;

  const peer = await context.newPage();
  try {
    await peer.goto("/tests/browser/fixtures/storage.html");
    const unrelatedToken = await peer.evaluate(async (id) => {
      const { openOfflineCache } = await import("/src/lib/offline-cache.ts");
      const cache = await openOfflineCache({ userId: "alice" });
      try {
        return await cache.beginFolderRead(id);
      } finally {
        cache.close();
      }
    }, other.id);
    await denyFolderFromPeer(peer, other.id, unrelatedToken);
    await expect(
      page
        .getByRole("navigation", { name: "フォルダ" })
        .getByText(current.name),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: targetNote.title }),
    ).toBeVisible();
    deniedFolders.add(current.id);
    const currentToken = await peer.evaluate(async (id) => {
      const { openOfflineCache } = await import("/src/lib/offline-cache.ts");
      const cache = await openOfflineCache({ userId: "alice" });
      try {
        return await cache.beginFolderRead(id);
      } finally {
        cache.close();
      }
    }, current.id);
    await denyFolderFromPeer(peer, current.id, currentToken);
    await expect
      .poll(
        () =>
          apiRequests.filter((path) => path.startsWith("/api/folders")).length,
      )
      .toBeGreaterThan(folderRequestCount);
    await expect(
      page
        .getByRole("navigation", { name: "フォルダ" })
        .getByText(current.name),
    ).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: targetNote.title }),
    ).toHaveCount(0);
    await expect(
      page.getByText(/キャッシュを削除できませんでした/),
    ).toHaveCount(0);
    const afterCurrentDenial = apiRequests.filter((path) =>
      path.startsWith("/api/folders"),
    ).length;
    await denyFolderFromPeer(peer, other.id, unrelatedToken);
    await expect
      .poll(
        () =>
          apiRequests.filter((path) => path.startsWith("/api/folders")).length,
      )
      .toBe(afterCurrentDenial);
  } finally {
    await peer.close();
  }
});

test("mounted root reprojects a denied child without hiding an allowed descendant", async ({
  page,
  context,
}) => {
  const deniedChild = folderFixture(
    "mounted-denied-child",
    "Denied Child",
    "mounted-root",
    [],
  );
  const allowedChild = folderFixture(
    "mounted-allowed-child",
    "Allowed Child",
    "mounted-root",
    [],
  );
  const root = folderFixture("mounted-root", "Mounted Network Root", null, [
    { id: deniedChild.id, name: deniedChild.name, parentId: "mounted-root" },
    { id: allowedChild.id, name: allowedChild.name, parentId: "mounted-root" },
  ]);
  const descendantNote = {
    ...note,
    createdAt: 9,
    folderId: allowedChild.id,
    id: "mounted-descendant-note",
    shortId: "mounted-descendant",
    title: "Allowed Descendant Note",
    updatedAt: 10,
  };
  const apiRequests = trackApiRequests(page);
  await routeAuthenticatedHome(
    page,
    { root, [deniedChild.id]: deniedChild, [allowedChild.id]: allowedChild },
    [descendantNote],
  );
  await page.goto("/");
  await expect(
    page.getByRole("link", { name: deniedChild.name }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: allowedChild.name }),
  ).toBeVisible();
  const folderRequestCount = apiRequests.filter((path) =>
    path.startsWith("/api/folders"),
  ).length;
  const peer = await context.newPage();
  try {
    await denyFolderFromPeer(peer, deniedChild.id);
    await expect
      .poll(
        () =>
          apiRequests.filter((path) => path.startsWith("/api/folders")).length,
      )
      .toBeGreaterThan(folderRequestCount);
    await expect(
      page.getByRole("link", { name: deniedChild.name }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: allowedChild.name }),
    ).toBeVisible();
    await expect(
      page
        .getByRole("navigation", { name: "フォルダ" })
        .getByText("マイドライブ"),
    ).toBeVisible();
    await page.getByRole("link", { name: allowedChild.name }).click();
    await expect(page).toHaveURL(`/f/${allowedChild.id}`);
    await expect(
      page.getByRole("link", { name: descendantNote.title }),
    ).toBeVisible();
  } finally {
    await peer.close();
  }
});

test("mounted note list removes only a peer-denied note", async ({
  page,
  context,
}) => {
  const root = folderFixture(
    "mounted-note-root",
    "Mounted Note Home",
    null,
    [],
  );
  const target = {
    ...note,
    createdAt: 11,
    folderId: root.id,
    id: "peer-denied-note",
    shortId: "peer-denied-short",
    title: "Peer Denied Note",
    updatedAt: 12,
  };
  const sibling = {
    ...note,
    createdAt: 13,
    folderId: root.id,
    id: "peer-kept-note",
    shortId: "peer-kept-short",
    title: "Peer Kept Note",
    updatedAt: 14,
  };
  const apiRequests = trackApiRequests(page);
  await routeAuthenticatedHome(page, { root, [root.id]: root }, [
    target,
    sibling,
  ]);
  await page.goto("/");
  await expect(page.getByRole("link", { name: target.title })).toBeVisible();
  await expect(page.getByRole("link", { name: sibling.title })).toBeVisible();
  const noteRequestCount = apiRequests.filter(
    (path) => path === "/api/notes",
  ).length;
  const peer = await context.newPage();
  try {
    await denyNoteFromPeer(peer, target.id);
    await expect
      .poll(() => apiRequests.filter((path) => path === "/api/notes").length)
      .toBeGreaterThan(noteRequestCount);
    await expect(page.getByRole("link", { name: target.title })).toHaveCount(0);
    await expect(page.getByRole("link", { name: sibling.title })).toBeVisible();
  } finally {
    await peer.close();
  }
});

test("folder reload then peer note denial fences Home owner and preserves sibling", async ({
  page,
  context,
}) => {
  const child = folderFixture(
    "home-owner-child",
    "Owner Child",
    "home-owner-root",
    [],
  );
  const root = folderFixture("home-owner-root", "Owner Root", null, [
    { id: child.id, name: child.name, parentId: "home-owner-root" },
  ]);
  const target = {
    ...note,
    folderId: root.id,
    id: "home-owner-target",
    shortId: "home-owner-target",
    title: "Home Owner Target",
  };
  const sibling = {
    ...note,
    folderId: root.id,
    id: "home-owner-sibling",
    shortId: "home-owner-sibling",
    title: "Home Owner Sibling",
  };
  const requests = trackApiRequests(page);
  const denied = new Set<string>();
  await routeAuthenticatedHome(
    page,
    { root, [root.id]: root, [child.id]: child },
    [target, sibling],
    denied,
  );
  await page.goto("/");
  await expect(page.getByRole("link", { name: target.title })).toBeVisible();
  const peer = await context.newPage();
  try {
    await denyFolderFromPeer(peer, child.id);
    await expect
      .poll(() => requests.filter((path) => path === "/api/folders").length)
      .toBeGreaterThan(1);
    await denyNoteFromPeer(peer, target.id);
    await expect
      .poll(() => requests.filter((path) => path === "/api/notes").length)
      .toBeGreaterThan(1);
    await expect(page.getByRole("link", { name: target.title })).toHaveCount(0);
    await expect(page.getByRole("link", { name: sibling.title })).toBeVisible();
  } finally {
    await peer.close();
  }
});

test("note list read is invalidated when folder denial sequence changes", async ({
  page,
  context,
}) => {
  await open(page);
  const resultPromise = page.evaluate(async (template) => {
    const module = await import("/src/lib/offline-cache.ts");
    const cache = await module.openOfflineCache({
      userId: "list-sequence-race",
    });
    const allowed = {
      ...template,
      folderId: "list-race-allowed-folder",
      id: "list-race-allowed",
      shortId: "list-race-allowed",
    };
    const denied = {
      ...template,
      folderId: "list-race-denied-folder",
      id: "list-race-denied",
      shortId: "list-race-denied",
    };
    const folder = { ...template, id: denied.folderId, name: "Race folder" };
    await cache.putFolder(folder);
    await cache.putNoteList([allowed, denied]);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const descriptor = Object.getOwnPropertyDescriptor(
      IDBRequest.prototype,
      "onsuccess",
    );
    if (!(descriptor?.set && descriptor.get)) {
      throw new Error("IDB request success hook is unavailable");
    }
    let gateNext = false;
    const originalGetAll = IDBObjectStore.prototype.getAll;
    IDBObjectStore.prototype.getAll = function (query, count) {
      // Gate the folder-denial snapshot inside getNoteList so a peer denial
      // can commit while the read is still in flight.
      if (this.name === "metadata") {
        gateNext = true;
      }
      return originalGetAll.call(this, query, count);
    };
    Object.defineProperty(IDBRequest.prototype, "onsuccess", {
      ...descriptor,
      set(callback: ((this: IDBRequest, event: Event) => unknown) | null) {
        let installedCallback = callback;
        if (gateNext && callback) {
          gateNext = false;
          const originalCallback = callback;
          installedCallback = function (this: IDBRequest, event: Event) {
            (
              globalThis as typeof globalThis & {
                __listRaceEntered?: boolean;
              }
            ).__listRaceEntered = true;
            entered.resolve();
            void release.promise.then(() => originalCallback.call(this, event));
          };
        }
        descriptor.set.call(this, installedCallback);
      },
    });
    (
      globalThis as typeof globalThis & { __releaseListRace?: () => void }
    ).__releaseListRace = release.resolve;
    return cache.getNoteList().finally(() => {
      IDBObjectStore.prototype.getAll = originalGetAll;
      Object.defineProperty(IDBRequest.prototype, "onsuccess", descriptor);
      cache.close();
    });
  }, note);
  const peer = await context.newPage();
  try {
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (globalThis as typeof globalThis & { __listRaceEntered?: boolean })
              .__listRaceEntered ?? false,
        ),
      )
      .toBe(true);
    await denyFolderFromPeer(peer, "list-race-denied-folder", {
      userId: "list-sequence-race",
    });
    await page.evaluate(() =>
      (
        globalThis as typeof globalThis & { __releaseListRace?: () => void }
      ).__releaseListRace?.(),
    );
    expect(await resultPromise).toBeNull();
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const { openOfflineCache } = await import(
            "/src/lib/offline-cache.ts"
          );
          const cache = await openOfflineCache({
            userId: "list-sequence-race",
          });
          try {
            return (
              (await cache.getNoteList())?.notes.map((item) => item.id) ?? null
            );
          } finally {
            cache.close();
          }
        }),
      )
      .toEqual(["list-race-allowed"]);
  } finally {
    await peer.close();
  }
});

test("stale note denial receipt is false after a newer clear generation", async ({
  page,
}) => {
  await open(page);
  const result = await page.evaluate(async () => {
    const module = await import("/src/lib/offline-cache.ts");
    const cache = await module.openOfflineCache({
      userId: "stale-note-receipt",
    });
    const id = "stale-note-receipt-note";
    try {
      await cache.denyNote(id);
      const generation =
        await module.captureOfflineNoteDenialSequence("stale-note-receipt");
      if (generation === null) {
        throw new Error("note denial sequence is unavailable");
      }
      const oldEvent = {
        resource: {
          aliases: [id],
          generation,
          type: "note",
        },
        type: "invalidate",
        userId: "stale-note-receipt",
      } as const;
      await cache.clearNoteDenial(id, cache.beginNoteRead(id), generation);
      return module.readOfflineNoteDenial(oldEvent, [id]);
    } finally {
      cache.close();
    }
  });
  expect(result).toBe(false);
});

test("route switch fences a delayed folder denial", async ({ page }) => {
  const folderA = folderFixture(
    "mounted-route-a",
    "Route A",
    "route-root",
    [],
    [
      { id: "route-root", name: "Route Root" },
      { id: "mounted-route-a", name: "Route A" },
    ],
  );
  const folderB = folderFixture(
    "mounted-route-b",
    "Route B",
    "route-root",
    [],
    [
      { id: "route-root", name: "Route Root" },
      { id: "mounted-route-b", name: "Route B" },
    ],
  );
  const routeRoot = folderFixture("route-root", "Route Root", null, [
    { id: folderA.id, name: folderA.name, parentId: "route-root" },
    { id: folderB.id, name: folderB.name, parentId: "route-root" },
  ]);
  const apiRequests = trackApiRequests(page);
  const routeBNote = {
    ...note,
    folderId: folderB.id,
    id: "route-b-note",
    shortId: "route-b-note",
    title: "Route B Note",
  };
  await routeAuthenticatedHome(
    page,
    { root: routeRoot, [folderA.id]: folderA, [folderB.id]: folderB },
    [routeBNote],
  );
  await page.goto(`/f/${folderA.id}`);
  await expect(
    page.getByRole("navigation", { name: "フォルダ" }).getByText(folderA.name),
  ).toBeVisible();
  await page.goto(`/f/${folderB.id}`);
  await expect(page).toHaveURL(`/f/${folderB.id}`);
  await expect(
    page.getByRole("navigation", { name: "フォルダ" }).getByText(folderB.name),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Route B Note" })).toBeVisible();
  const folderBRequestCount = apiRequests.filter(
    (path) => path === `/api/folders/${folderB.id}`,
  ).length;
  const peer = await page.context().newPage();
  try {
    await denyFolderFromPeer(peer, folderA.id);
    await expect
      .poll(
        () =>
          apiRequests.filter((path) => path === `/api/folders/${folderB.id}`)
            .length,
      )
      .toBe(folderBRequestCount);
    await expect(
      page
        .getByRole("navigation", { name: "フォルダ" })
        .getByText(folderB.name),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Route B Note" }),
    ).toBeVisible();
    await expect(page.getByText(/キャッシュ|停止|警告/)).toHaveCount(0);
  } finally {
    await peer.close();
  }
});
