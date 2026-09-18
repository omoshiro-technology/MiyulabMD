import type { FolderAccess } from "@miyulabmd/shared";
import { expect, test } from "@playwright/test";

function folder(id: string | null): FolderAccess {
  return {
    children: [],
    crumbs: id ? [{ id, name: id }] : [],
    effectiveReadScope: "all",
    effectiveWriteScope: "self",
    flags: { canAdmin: false, canEdit: false, canView: true },
    grants: [],
    id,
    inherit: false,
    name: id ?? "Drive",
    parentId: null,
    readScope: "all",
    source: "folder",
    sourceFolder: null,
    writeScope: "self",
  };
}

test("an old folder read cannot clear a newer denial across same-context tabs", async ({
  context,
}) => {
  const first = await context.newPage();
  const second = await context.newPage();
  await first.goto("/tests/browser/fixtures/storage.html");
  await second.goto("/tests/browser/fixtures/storage.html");
  const result = await first.evaluate(async (initial) => {
    const url = "/src/lib/offline-cache.ts";
    const { openOfflineCache } = await import(url);
    const cache = await openOfflineCache({ userId: "two-tab-user" });
    await cache.putFolder(initial);
    const oldRead = await cache.beginFolderRead("folder-a");
    cache.close();
    return oldRead;
  }, folder("folder-a"));
  await second.evaluate(async () => {
    const url = "/src/lib/offline-cache.ts";
    const { openOfflineCache } = await import(url);
    const cache = await openOfflineCache({ userId: "two-tab-user" });
    await cache.denyFolder("folder-a");
    cache.close();
  });
  const snapshot = await first.evaluate(
    async ({ oldRead, initial }) => {
      const url = "/src/lib/offline-cache.ts";
      const { openOfflineCache } = await import(url);
      const cache = await openOfflineCache({ userId: "two-tab-user" });
      await cache.putFolder(initial);
      const staleRejected = await cache
        .clearFolderDenial("folder-a", oldRead)
        .then(
          () => false,
          () => true,
        );
      const denied = await cache.getFolder("folder-a");
      const freshRead = await cache.beginFolderRead("folder-a");
      await cache.clearFolderDenial("folder-a", freshRead);
      const revalidated = await cache.getFolder("folder-a");
      cache.close();
      return { denied, revalidated, staleRejected };
    },
    { initial: folder("folder-a"), oldRead: result },
  );
  await first.close();
  await second.close();
  expect(snapshot.denied).toBeNull();
  expect(snapshot.staleRejected).toBe(true);
  expect(snapshot.revalidated?.folder.id).toBe("folder-a");
});

for (const literalId of [
  "root",
  "null",
  "\u0000offline-root-route",
  '["folder",null]',
]) {
  test(`null root denial is separate from literal folder ID ${JSON.stringify(literalId)}`, async ({
    page,
  }) => {
    await page.goto("/tests/browser/fixtures/storage.html");
    const snapshot = await page.evaluate(
      async ({ root, literal }) => {
        const url = "/src/lib/offline-cache.ts";
        const { openOfflineCache } = await import(url);
        const cache = await openOfflineCache({ userId: "root-boundary-user" });
        await cache.putFolder(root, { asDriveRoot: true });
        await cache.putFolder(literal);
        await cache.denyFolder(null);
        const rootSnapshot = await cache.getFolder(null);
        const literalSnapshot = await cache.getFolder(literal.id);
        cache.close();
        return { literal: literalSnapshot, root: rootSnapshot };
      },
      { literal: folder(literalId), root: folder(null) },
    );
    expect(snapshot.root).toBeNull();
    expect(snapshot.literal?.folder.id).toBe(literalId);
  });
}

test("folder generations survive revalidation without invalidating independent folders", async ({
  page,
}) => {
  await page.goto("/tests/browser/fixtures/storage.html");
  const result = await page.evaluate(
    async ({ target, sibling }) => {
      const url = "/src/lib/offline-cache.ts";
      const { openOfflineCache } = await import(url);
      const cache = await openOfflineCache({ userId: "alice" });
      try {
        const before = await cache.beginFolderRead(target.id);
        await cache.denyFolder(target.id);
        await cache.putFolder(sibling, { orderingToken: before });
        const fresh = await cache.beginFolderRead(target.id);
        await cache.putFolder(target, { orderingToken: fresh });
        await cache.denyFolder(target.id);
        const staleRejected = await cache
          .putFolder(target, { orderingToken: fresh })
          .then(
            () => false,
            () => true,
          );
        return {
          denied: await cache.getFolder(target.id),
          sibling: (await cache.getFolder(sibling.id))?.folder.id,
          staleRejected,
        };
      } finally {
        cache.close();
      }
    },
    { sibling: folder("sibling"), target: folder("target") },
  );
  expect(result).toEqual({
    denied: null,
    sibling: "sibling",
    staleRejected: true,
  });
});

test("Home rejects a held HTTP 200 after another tab observes HTTP 403", async ({
  page,
  context,
}) => {
  const headers = { "X-MiyulabMD-Session-User": "user:alice" };
  await context.route("**/api/notes", (route) =>
    route.fulfill({ headers, json: { notes: [] } }),
  );
  await page.goto("/tests/browser/fixtures/storage.html");
  const peer = await context.newPage();
  await peer.goto("/tests/browser/fixtures/storage.html");
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await page.route("**/api/folders/folder-a", async (route) => {
    started.resolve();
    await release.promise;
    await route.fulfill({ headers, json: folder("folder-a") });
  });
  let denied = true;
  await peer.route("**/api/folders/folder-a", (route) =>
    route.fulfill({
      headers,
      json: denied ? { error: "Forbidden" } : folder("folder-a"),
      status: denied ? 403 : 200,
    }),
  );
  const read = async () => {
    const url = "/src/lib/home-metadata-reader.ts";
    const { readHomeMetadata } = await import(url);
    return readHomeMetadata({
      folderId: "folder-a",
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
      () => ({ ok: true }),
      (error: { name: string; status?: number }) => ({
        name: error.name,
        ok: false,
        status: error.status,
      }),
    );
  };
  const stored = async () => {
    const url = "/src/lib/offline-cache.ts";
    const { openOfflineCache } = await import(url);
    const cache = await openOfflineCache({ userId: "alice" });
    try {
      return await cache.getFolder("folder-a");
    } finally {
      cache.close();
    }
  };
  try {
    const pending = page.evaluate(read);
    await started.promise;
    expect(await peer.evaluate(read)).toMatchObject({ ok: false, status: 403 });
    release.resolve();
    expect(await pending).toMatchObject({ name: "AbortError", ok: false });
    expect(await peer.evaluate(stored)).toBeNull();
    denied = false;
    expect(await peer.evaluate(read)).toEqual({ ok: true });
    // The cache write is detached: the read resolves before it commits, so
    // poll until the revalidated folder lands in storage.
    await expect
      .poll(() => peer.evaluate(stored))
      .toMatchObject({
        folder: { id: "folder-a" },
      });
  } finally {
    release.resolve();
    await peer.close();
  }
});
