import { expect, test } from "@playwright/test";
import { note } from "./fixtures/note.ts";

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/browser/fixtures/storage.html");
});

test("shared parser skips external destinations and keys the referenced parent", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const moduleUrl = "/src/lib/attached-images.ts";
    const { collectAttachedImages, attachedImage } = await import(moduleUrl);
    return {
      images: collectAttachedImages(
        [
          "![external](https://example.test/api/notes/other/images/x)",
          "![app](/api/notes/other/images/x)",
          `![duplicate](${location.origin}/api/notes/other/images/x)`,
          "`![code](/api/notes/ignored/images/y)`",
          "![inline](data:image/png;base64,AAAA)",
        ].join("\n\n"),
      ),
      rejected: [
        "/api/notes/n/images/i?download=1",
        "/api/notes/n/images/i#fragment",
        "/api/notes/n%2Fp/images/i",
        "https://external.test/api/notes/n/images/i",
      ].map((url) => attachedImage(url)),
    };
  });
  expect(result.images).toEqual([
    { imageId: "x", noteId: "other", url: "/api/notes/other/images/x" },
  ]);
  expect(result.rejected).toEqual([null, null, null, null]);
});

test("image references and binary files stay user scoped and purge fences expired handles", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const moduleUrl = "/src/lib/offline-cache.ts";
    const { openOfflineCache, clearOfflineCacheUser } = await import(moduleUrl);
    const alice = await openOfflineCache({ userId: "alice" });
    const bob = await openOfflineCache({ userId: "bob" });
    try {
      await alice.putImage(
        "parent",
        "image",
        new Blob(["alice bytes"], { type: "image/png" }),
      );
      const beforeBob = await bob.getImage("parent", "image");
      await bob.putImage(
        "parent",
        "image",
        new Blob(["bob bytes"], { type: "image/png" }),
      );
      const aliceBytes = await (await alice.getImage("parent", "image")).text();
      await clearOfflineCacheUser("alice");
      // A stale pre-purge handle degrades reads to misses; writes reject.
      const staleRead = await alice.getImage("parent", "image");
      const staleWrite = await alice
        .putImage("parent", "image", new Blob(["late"], { type: "image/png" }))
        .then(
          () => false,
          () => true,
        );
      const fresh = await openOfflineCache({ userId: "alice" });
      const afterAlice = await fresh.getImage("parent", "image");
      fresh.close();
      const root = await navigator.storage.getDirectory();
      const app = await root.getDirectoryHandle("miyulabmd-offline-cache-v1");
      const aliceFilesGone = await app
        .getDirectoryHandle(btoa("alice").replace(/[=]+$/, ""))
        .then(
          () => false,
          () => true,
        );
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("miyulabmd-offline-cache");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
        const request = database
          .transaction("metadata")
          .objectStore("metadata")
          .getAllKeys();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      database.close();
      return {
        afterAlice,
        aliceBytes,
        aliceFilesGone,
        beforeBob,
        bobBytes: await (await bob.getImage("parent", "image")).text(),
        imageKeys: keys.filter((key) => String(key).startsWith("image:")),
        staleRead,
        staleWrite,
      };
    } finally {
      alice.close();
      bob.close();
    }
  });
  expect(result).toEqual({
    afterAlice: null,
    aliceBytes: "alice bytes",
    aliceFilesGone: true,
    beforeBob: null,
    bobBytes: "bob bytes",
    imageKeys: ["image:Ym9i:cGFyZW50:aW1hZ2U"],
    staleRead: null,
    staleWrite: true,
  });
});

test("failed binary write and aborted metadata replacement retain the prior committed image", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const moduleUrl = "/src/lib/offline-cache.ts";
    const { openOfflineCache } = await import(moduleUrl);
    const cache = await openOfflineCache({ userId: "alice" });
    const bytes = (value: string) => new Blob([value], { type: "image/png" });
    try {
      await cache.putImage("parent", "image", bytes("prior"));
      const originalWrite = FileSystemWritableFileStream.prototype.write;
      FileSystemWritableFileStream.prototype.write = () =>
        Promise.reject(new DOMException("full", "QuotaExceededError"));
      const writeFailed = await cache
        .putImage("parent", "image", bytes("new"))
        .then(
          () => false,
          () => true,
        );
      FileSystemWritableFileStream.prototype.write = originalWrite;
      const afterWrite = await (await cache.getImage("parent", "image")).text();
      const originalPut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (value, key) {
        const request = originalPut.call(this, value, key);
        if (
          this.name === "metadata" &&
          String(value.key).startsWith("image:")
        ) {
          this.transaction.abort();
        }
        return request;
      };
      const commitFailed = await cache
        .putImage("parent", "image", bytes("newer"))
        .then(
          () => false,
          () => true,
        );
      IDBObjectStore.prototype.put = originalPut;
      return {
        afterCommit: await (await cache.getImage("parent", "image")).text(),
        afterWrite,
        commitFailed,
        writeFailed,
      };
    } finally {
      cache.close();
    }
  });
  expect(result).toEqual({
    afterCommit: "prior",
    afterWrite: "prior",
    commitFailed: true,
    writeFailed: true,
  });
});

for (const status of [403, 404]) {
  test(`image HTTP ${status} keeps the note body and does not use a prior image`, async ({
    page,
  }) => {
    await page.route("**/api/notes/**/images/**", (route) =>
      route.fulfill({
        headers: { "X-MiyulabMD-Session-User": "user:alice" },
        json: { error: "missing" },
        status,
      }),
    );
    const result = await page.evaluate(async (fixture) => {
      const cacheUrl = "/src/lib/offline-cache.ts";
      const imageUrl = "/src/lib/attached-images.ts";
      const { openOfflineCache } = await import(cacheUrl);
      const { acquireAttachedImage, attachedImage } = await import(imageUrl);
      const cache = await openOfflineCache({ userId: "alice" });
      try {
        await cache.putNote(fixture);
        await cache.putImage(
          "other",
          "image",
          new Blob(["prior"], { type: "image/png" }),
        );
        const result = await acquireAttachedImage(
          attachedImage("/api/notes/other/images/image"),
          { cacheOnly: false, userId: "alice" },
        );
        return {
          body: (await cache.getNote(fixture.id)).note.markdown,
          image: result,
          stored: await cache.getImage("other", "image"),
        };
      } finally {
        cache.close();
      }
    }, note);
    expect(result).toEqual({ body: note.markdown, image: null, stored: null });
  });
}

test("overlapping foreground/background acquisitions share bytes, not cancellation", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const imageUrl = "/src/lib/attached-images.ts";
    const { acquireAttachedImage, attachedImage } = await import(imageUrl);
    const image = attachedImage("/api/notes/parent/images/image");
    const originalFetch = globalThis.fetch;
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    globalThis.fetch = async () => {
      calls += 1;
      await gate;
      return new Response(new Blob(["shared"], { type: "image/png" }), {
        headers: { "X-MiyulabMD-Session-User": "user:alice" },
      });
    };
    try {
      const foreground = new AbortController();
      const first = acquireAttachedImage(image, {
        cacheOnly: false,
        signal: foreground.signal,
        userId: "alice",
      }).then(
        () => false,
        () => true,
      );
      const second = acquireAttachedImage(image, {
        cacheOnly: false,
        userId: "alice",
      });
      // The shared transport issues its fetch after the cache handle's
      // open and ordering-token read — wait for the fetch itself rather
      // than a fixed delay.
      for (let attempts = 0; attempts < 200 && !calls; attempts += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      foreground.abort();
      release();
      return {
        calls,
        cancelled: await first,
        data: await (await second).text(),
      };
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
  expect(result).toEqual({ calls: 1, cancelled: true, data: "shared" });
});
