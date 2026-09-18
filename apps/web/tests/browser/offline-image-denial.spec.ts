import { expect, test } from "@playwright/test";

const imagePath = "/api/notes/parent/images/image";
const headers = { "X-MiyulabMD-Session-User": "user:alice" };
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);

test("a denial fences every image read begun before that denial was observed", async ({
  page,
}) => {
  await page.goto("/tests/browser/fixtures/storage.html");
  const result = await page.evaluate(async () => {
    const url = "/src/lib/offline-cache.ts";
    const { openOfflineCache } = await import(url);
    const cache = await openOfflineCache({ userId: "alice" });
    try {
      const deniedRequest = await cache.beginImageRead("parent", "image");
      const laterRequest = await cache.beginImageRead("parent", "image");
      await cache.denyImage("parent", "image", deniedRequest);
      const published = await cache
        .putImage(
          "parent",
          "image",
          new Blob(["stale"], { type: "image/png" }),
          { orderingToken: laterRequest },
        )
        .then(
          () => true,
          () => false,
        );
      const stale = await cache.getImage("parent", "image");
      const freshRequest = await cache.beginImageRead("parent", "image");
      await cache.putImage(
        "parent",
        "image",
        new Blob(["fresh"], { type: "image/png" }),
        { orderingToken: freshRequest },
      );
      return {
        fresh: await (await cache.getImage("parent", "image"))?.text(),
        published,
        stale: Boolean(stale),
      };
    } finally {
      cache.close();
    }
  });
  expect(result).toEqual({ fresh: "fresh", published: false, stale: false });
});

test("a pre-denial image response cannot revive bytes denied by another tab", async ({
  page,
  context,
}) => {
  await page.goto("/tests/browser/fixtures/storage.html");
  const other = await context.newPage();
  await other.goto("/tests/browser/fixtures/storage.html");
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await page.route(`**${imagePath}`, async (route) => {
    started.resolve();
    await release.promise;
    await route.fulfill({ body: png, contentType: "image/png", headers });
  });
  await other.route(`**${imagePath}`, (route) =>
    route.fulfill({ headers, json: { error: "Forbidden" }, status: 403 }),
  );
  const acquire = async (cacheOnly: boolean) => {
    const imageUrl = "/src/lib/attached-images.ts";
    const { acquireAttachedImage } = await import(imageUrl);
    return await acquireAttachedImage(
      {
        imageId: "image",
        noteId: "parent",
        url: "/api/notes/parent/images/image",
      },
      { cacheOnly, userId: "alice" },
    ).then(
      (blob: Blob | null) => Boolean(blob),
      () => false,
    );
  };
  try {
    await other.evaluate(
      async (bytes) => {
        const url = "/src/lib/offline-cache.ts";
        const { openOfflineCache } = await import(url);
        const cache = await openOfflineCache({ userId: "alice" });
        try {
          await cache.putImage(
            "parent",
            "image",
            new Blob([new Uint8Array(bytes)], { type: "image/png" }),
          );
        } finally {
          cache.close();
        }
      },
      [...png],
    );
    expect(await other.evaluate(acquire, true)).toBe(true);
    const pending = page.evaluate(acquire, false);
    await started.promise;
    expect(await other.evaluate(acquire, false)).toBe(false);
    expect(await other.evaluate(acquire, true)).toBe(false);
    release.resolve();
    const published = await pending;
    const restored = await other.evaluate(acquire, true);
    expect({ published, restored }).toEqual({
      published: false,
      restored: false,
    });
  } finally {
    release.resolve();
    await other.close();
  }
});
