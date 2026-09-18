import { expect, type Page, test } from "@playwright/test";
import { note } from "./fixtures/note.ts";

const latest = {
  ...note,
  folderId: "alice-root",
  markdown: "Latest body",
  updatedAt: 3,
};
const imagePath = "/api/notes/image-parent/images/image-1";
const imageNote = {
  ...latest,
  markdown: `Latest body\n\n![attachment](${imagePath})`,
};

async function installDriveRoutes(
  page: Page,
  options: {
    bodyGate?: Promise<void>;
    onBodyRequest?: () => void;
  } = {},
): Promise<() => number> {
  const { markdown: _markdown, ...summary } = latest;
  let bodyRequests = 0;
  const headers = { "X-MiyulabMD-Session-User": "user:alice" };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/folders/tree") {
      await route.fulfill({
        headers,
        json: {
          folders: [{ id: "alice-root", name: "MyDrive", parentId: null }],
        },
      });
      return;
    }
    if (path === "/api/folders/alice-root") {
      await route.fulfill({
        headers,
        json: {
          ...note.access,
          children: [],
          crumbs: [],
          id: "alice-root",
          locked: true,
          name: "MyDrive",
          parentId: null,
        },
      });
      return;
    }
    if (path === "/api/notes") {
      await route.fulfill({ headers, json: { notes: [summary] } });
      return;
    }
    bodyRequests += 1;
    options.onBodyRequest?.();
    await options.bodyGate;
    await route.fulfill({ headers, json: latest });
  });
  return () => bodyRequests;
}

async function installImageDriveRoutes(
  page: Page,
  bodyGate: Promise<void>,
  onImageRequest?: () => void,
): Promise<{ bodyRequests: () => number; imageRequests: () => number }> {
  const { markdown: _markdown, ...summary } = imageNote;
  let bodyRequests = 0;
  let imageRequests = 0;
  const headers = { "X-MiyulabMD-Session-User": "user:alice" };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/folders/tree") {
      await route.fulfill({
        headers,
        json: {
          folders: [{ id: "alice-root", name: "MyDrive", parentId: null }],
        },
      });
      return;
    }
    if (path === "/api/folders/alice-root") {
      await route.fulfill({
        headers,
        json: {
          ...note.access,
          children: [],
          crumbs: [],
          id: "alice-root",
          locked: true,
          name: "MyDrive",
          parentId: null,
        },
      });
      return;
    }
    if (path === "/api/notes") {
      await route.fulfill({ headers, json: { notes: [summary] } });
      return;
    }
    if (path === imagePath) {
      imageRequests += 1;
      onImageRequest?.();
      await bodyGate;
      await route.fulfill({
        body: "network image",
        contentType: "image/png",
        headers,
      });
      return;
    }
    bodyRequests += 1;
    await route.fulfill({ headers, json: imageNote });
  });
  return {
    bodyRequests: () => bodyRequests,
    imageRequests: () => imageRequests,
  };
}

test("prefetch collects orphans and retries the same validated body once after quota", async ({
  page,
}) => {
  const bodyRequests = await installDriveRoutes(page);
  await page.goto("/tests/browser/fixtures/storage.html");
  const result = await page.evaluate(async (latest) => {
    const cacheUrl = "/src/lib/offline-cache.ts";
    const prefetchUrl = "/src/lib/mydrive-prefetch.ts";
    const { openOfflineCache } = await import(cacheUrl);
    const { prefetchMyDrive } = await import(prefetchUrl);
    const cache = await openOfflineCache({ userId: "alice" });
    await cache.putNote({ ...latest, markdown: "Old body", updatedAt: 1 });
    await cache.putNote({ ...latest, markdown: "Previous body", updatedAt: 2 });
    const root = await navigator.storage.getDirectory();
    const app = await root.getDirectoryHandle("miyulabmd-offline-cache-v1");
    const user = await app.getDirectoryHandle("YWxpY2U");
    const notes = await user.getDirectoryHandle("notes");
    const directory = await notes.getDirectoryHandle("bm90ZS0x");
    const files = async () => {
      const names: string[] = [];
      for await (const [name] of directory.entries()) {
        names.push(name);
      }
      return names;
    };
    const before = await files();
    const original = FileSystemFileHandle.prototype.createWritable;
    let writes = 0;
    FileSystemFileHandle.prototype.createWritable = function (...args) {
      writes += 1;
      return writes === 1
        ? Promise.reject(new DOMException("Storage full", "QuotaExceededError"))
        : original.apply(this, args);
    };
    try {
      const outcome = await prefetchMyDrive({
        cacheViewerId: "alice",
        mode: "authenticated",
        user: {
          displayName: "Alice",
          email: "alice@example.test",
          id: "alice",
        },
      });
      const remaining = await files();
      return {
        body: (await cache.getNote(latest.id))?.note.markdown,
        oldFilesRemoved: before.filter((file) => !remaining.includes(file))
          .length,
        outcome,
        writes,
      };
    } finally {
      FileSystemFileHandle.prototype.createWritable = original;
      cache.close();
    }
  }, latest);
  expect(result).toEqual({
    body: "Latest body",
    oldFilesRemoved: 1,
    outcome: { folders: 1, notes: 1, status: "success" },
    writes: 2,
  });
  expect(bodyRequests()).toBe(1);
});

test("body recovery budget is shared with a later image write", async ({
  page,
}) => {
  const routes = await installImageDriveRoutes(page, Promise.resolve());
  await page.goto("/tests/browser/fixtures/storage.html");
  const result = await page.evaluate(async () => {
    const cacheUrl = "/src/lib/offline-cache.ts";
    const prefetchUrl = "/src/lib/mydrive-prefetch.ts";
    const { openOfflineCache } = await import(cacheUrl);
    const { prefetchMyDrive } = await import(prefetchUrl);
    const cache = await openOfflineCache({ userId: "alice" });
    const original = FileSystemFileHandle.prototype.createWritable;
    let writes = 0;
    FileSystemFileHandle.prototype.createWritable = function (...args) {
      writes += 1;
      return writes === 1 || writes === 3
        ? Promise.reject(new DOMException("Storage full", "QuotaExceededError"))
        : original.apply(this, args);
    };
    try {
      const outcome = await prefetchMyDrive({
        cacheViewerId: "alice",
        mode: "authenticated",
        user: {
          displayName: "Alice",
          email: "alice@example.test",
          id: "alice",
        },
      });
      return { outcome, writes };
    } finally {
      FileSystemFileHandle.prototype.createWritable = original;
      cache.close();
    }
  });
  expect(result).toEqual({
    outcome: {
      folders: 1,
      notes: 1,
      reason: "storage",
      status: "stopped",
    },
    writes: 3,
  });
  expect(routes.bodyRequests()).toBe(1);
  expect(routes.imageRequests()).toBe(1);
});

test("persistent quota stops after one recovery while a shared network reader succeeds", async ({
  page,
}) => {
  let bodyStarted!: () => void;
  const bodyStart = new Promise<void>((resolve) => {
    bodyStarted = resolve;
  });
  let releaseBody!: () => void;
  const bodyGate = new Promise<void>((resolve) => {
    releaseBody = resolve;
  });
  const bodyRequests = await installDriveRoutes(page, {
    bodyGate,
    onBodyRequest: bodyStarted,
  });
  await page.goto("/tests/browser/fixtures/storage.html");

  const prefetch = page.evaluate(async (latest) => {
    const cacheUrl = "/src/lib/offline-cache.ts";
    const prefetchUrl = "/src/lib/mydrive-prefetch.ts";
    const { openOfflineCache } = await import(cacheUrl);
    const { prefetchMyDrive } = await import(prefetchUrl);
    const cache = await openOfflineCache({ userId: "alice" });
    await cache.putNote({ ...latest, markdown: "Old body", updatedAt: 1 });
    await cache.putNote({
      ...latest,
      markdown: "Previous body",
      updatedAt: 2,
    });
    const before = await cache.getNote(latest.id);
    const root = await navigator.storage.getDirectory();
    const app = await root.getDirectoryHandle("miyulabmd-offline-cache-v1");
    const user = await app.getDirectoryHandle("YWxpY2U");
    const notes = await user.getDirectoryHandle("notes");
    const directory = await notes.getDirectoryHandle("bm90ZS0x");
    const files = async () => {
      const names: string[] = [];
      for await (const [name] of directory.entries()) {
        names.push(name);
      }
      return names;
    };
    const filesBefore = await files();
    const original = FileSystemFileHandle.prototype.createWritable;
    let writes = 0;
    FileSystemFileHandle.prototype.createWritable = () => {
      writes += 1;
      return Promise.reject(
        new DOMException("Storage full", "QuotaExceededError"),
      );
    };
    try {
      const outcome = await prefetchMyDrive({
        cacheViewerId: "alice",
        mode: "authenticated",
        user: {
          displayName: "Alice",
          email: "alice@example.test",
          id: "alice",
        },
      });
      const after = await cache.getNote(latest.id);
      const filesAfter = await files();
      return {
        cachedAtAfter: after?.cachedAt,
        cachedAtBefore: before?.cachedAt,
        filesRemoved: filesBefore.filter((file) => !filesAfter.includes(file))
          .length,
        markdown: after?.note.markdown,
        outcome,
        writes,
      };
    } finally {
      FileSystemFileHandle.prototype.createWritable = original;
      cache.close();
    }
  }, latest);

  await bodyStart;
  const foreground = page.evaluate(async (noteId) => {
    const apiUrl = "/src/lib/api.ts";
    const { fetchNote } = await import(apiUrl);
    const request = fetchNote(noteId, { viewerId: "alice" });
    (
      window as typeof window & { foregroundRequestStarted?: boolean }
    ).foregroundRequestStarted = true;
    return request;
  }, latest.id);
  await page.waitForFunction(
    () =>
      (window as typeof window & { foregroundRequestStarted?: boolean })
        .foregroundRequestStarted === true,
  );
  releaseBody();

  await expect(foreground).resolves.toEqual({ data: latest, ok: true });
  const result = await prefetch;
  expect(result).toEqual({
    cachedAtAfter: result.cachedAtBefore,
    cachedAtBefore: result.cachedAtBefore,
    filesRemoved: 1,
    markdown: "Previous body",
    outcome: {
      folders: 1,
      notes: 0,
      reason: "storage",
      status: "stopped",
    },
    writes: 2,
  });
  expect(bodyRequests()).toBe(1);
});

test("abort during quota cleanup does not retry the failed write", async ({
  page,
}) => {
  const bodyRequests = await installDriveRoutes(page);
  await page.goto("/tests/browser/fixtures/storage.html");
  const result = await page.evaluate(async (latest) => {
    const cacheUrl = "/src/lib/offline-cache.ts";
    const prefetchUrl = "/src/lib/mydrive-prefetch.ts";
    const { openOfflineCache } = await import(cacheUrl);
    const { prefetchMyDrive } = await import(prefetchUrl);
    const cache = await openOfflineCache({ userId: "alice" });
    await cache.putNote({ ...latest, markdown: "Old body", updatedAt: 1 });
    await cache.putNote({
      ...latest,
      markdown: "Previous body",
      updatedAt: 2,
    });

    const originalWrite = FileSystemFileHandle.prototype.createWritable;
    const originalRemove = FileSystemDirectoryHandle.prototype.removeEntry;
    let writes = 0;
    FileSystemFileHandle.prototype.createWritable = () => {
      writes += 1;
      return Promise.reject(
        new DOMException("Storage full", "QuotaExceededError"),
      );
    };
    let cleanupStarted!: () => void;
    const cleanupStart = new Promise<void>((resolve) => {
      cleanupStarted = resolve;
    });
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    FileSystemDirectoryHandle.prototype.removeEntry = async function (...args) {
      cleanupStarted();
      await cleanupGate;
      return originalRemove.apply(this, args);
    };
    const controller = new AbortController();
    try {
      const prefetch = prefetchMyDrive(
        {
          cacheViewerId: "alice",
          mode: "authenticated",
          user: {
            displayName: "Alice",
            email: "alice@example.test",
            id: "alice",
          },
        },
        { signal: controller.signal },
      );
      await cleanupStart;
      controller.abort(new DOMException("Cancelled", "AbortError"));
      releaseCleanup();
      const outcome = await prefetch;
      return {
        markdown: (await cache.getNote(latest.id))?.note.markdown,
        outcome,
        writes,
      };
    } finally {
      FileSystemDirectoryHandle.prototype.removeEntry = originalRemove;
      FileSystemFileHandle.prototype.createWritable = originalWrite;
      cache.close();
    }
  }, latest);
  expect(result).toEqual({
    markdown: "Previous body",
    outcome: {
      folders: 1,
      notes: 0,
      reason: "aborted",
      status: "stopped",
    },
    writes: 1,
  });
  expect(bodyRequests()).toBe(1);
});

test("image quota recovery shares one response with a healthy foreground reader", async ({
  page,
}) => {
  let imageStarted!: () => void;
  const imageStart = new Promise<void>((resolve) => {
    imageStarted = resolve;
  });
  let releaseImage!: () => void;
  const imageGate = new Promise<void>((resolve) => {
    releaseImage = resolve;
  });
  const requests = await installImageDriveRoutes(page, imageGate, imageStarted);
  await page.goto("/tests/browser/fixtures/storage.html");

  const prefetch = page.evaluate(async (imageNote) => {
    const cacheUrl = "/src/lib/offline-cache.ts";
    const prefetchUrl = "/src/lib/mydrive-prefetch.ts";
    const { openOfflineCache } = await import(cacheUrl);
    const { prefetchMyDrive } = await import(prefetchUrl);
    const cache = await openOfflineCache({ userId: "alice" });
    await cache.putNote(imageNote);
    await cache.putImage(
      "image-parent",
      "image-1",
      new Blob(["old image"], { type: "image/png" }),
    );
    await cache.putImage(
      "image-parent",
      "image-1",
      new Blob(["previous image"], { type: "image/png" }),
    );
    const original = FileSystemFileHandle.prototype.createWritable;
    let writes = 0;
    FileSystemFileHandle.prototype.createWritable = function (...args) {
      writes += 1;
      return writes === 1
        ? Promise.reject(new DOMException("Storage full", "QuotaExceededError"))
        : original.apply(this, args);
    };
    try {
      const outcome = await prefetchMyDrive({
        cacheViewerId: "alice",
        mode: "authenticated",
        user: {
          displayName: "Alice",
          email: "alice@example.test",
          id: "alice",
        },
      });
      return {
        image: await (await cache.getImage("image-parent", "image-1"))?.text(),
        outcome,
        writes,
      };
    } finally {
      FileSystemFileHandle.prototype.createWritable = original;
      cache.close();
    }
  }, imageNote);

  await imageStart;
  const foreground = page.evaluate(async (imagePath) => {
    const imageUrl = "/src/lib/attached-images.ts";
    const { acquireAttachedImage, attachedImage } = await import(imageUrl);
    const request = acquireAttachedImage(attachedImage(imagePath), {
      cacheOnly: false,
      userId: "alice",
    });
    (
      window as typeof window & { foregroundImageStarted?: boolean }
    ).foregroundImageStarted = true;
    return (await request)?.text();
  }, imagePath);
  await page.waitForFunction(
    () =>
      (window as typeof window & { foregroundImageStarted?: boolean })
        .foregroundImageStarted === true,
  );
  releaseImage();

  await expect(foreground).resolves.toBe("network image");
  await expect(prefetch).resolves.toEqual({
    image: "network image",
    outcome: { folders: 1, notes: 0, status: "success" },
    writes: 2,
  });
  expect(requests.bodyRequests()).toBe(0);
  expect(requests.imageRequests()).toBe(1);
});

test("persistent image quota stops prefetch without poisoning shared foreground bytes", async ({
  page,
}) => {
  let imageStarted!: () => void;
  const imageStart = new Promise<void>((resolve) => {
    imageStarted = resolve;
  });
  let releaseImage!: () => void;
  const imageGate = new Promise<void>((resolve) => {
    releaseImage = resolve;
  });
  const requests = await installImageDriveRoutes(page, imageGate, imageStarted);
  await page.goto("/tests/browser/fixtures/storage.html");

  const prefetch = page.evaluate(async (imageNote) => {
    const cacheUrl = "/src/lib/offline-cache.ts";
    const prefetchUrl = "/src/lib/mydrive-prefetch.ts";
    const { openOfflineCache } = await import(cacheUrl);
    const { prefetchMyDrive } = await import(prefetchUrl);
    const cache = await openOfflineCache({ userId: "alice" });
    await cache.putNote(imageNote);
    await cache.putImage(
      "image-parent",
      "image-1",
      new Blob(["old image"], { type: "image/png" }),
    );
    await cache.putImage(
      "image-parent",
      "image-1",
      new Blob(["previous image"], { type: "image/png" }),
    );
    const original = FileSystemFileHandle.prototype.createWritable;
    let writes = 0;
    FileSystemFileHandle.prototype.createWritable = () => {
      writes += 1;
      return Promise.reject(
        new DOMException("Storage full", "QuotaExceededError"),
      );
    };
    try {
      const outcome = await prefetchMyDrive({
        cacheViewerId: "alice",
        mode: "authenticated",
        user: {
          displayName: "Alice",
          email: "alice@example.test",
          id: "alice",
        },
      });
      return {
        image: await (await cache.getImage("image-parent", "image-1"))?.text(),
        outcome,
        writes,
      };
    } finally {
      FileSystemFileHandle.prototype.createWritable = original;
      cache.close();
    }
  }, imageNote);

  await imageStart;
  const foreground = page.evaluate(async (imagePath) => {
    const imageUrl = "/src/lib/attached-images.ts";
    const { acquireAttachedImage, attachedImage } = await import(imageUrl);
    const request = acquireAttachedImage(attachedImage(imagePath), {
      cacheOnly: false,
      userId: "alice",
    });
    (
      window as typeof window & { foregroundImageStarted?: boolean }
    ).foregroundImageStarted = true;
    return (await request)?.text();
  }, imagePath);
  await page.waitForFunction(
    () =>
      (window as typeof window & { foregroundImageStarted?: boolean })
        .foregroundImageStarted === true,
  );
  releaseImage();

  await expect(foreground).resolves.toBe("network image");
  await expect(prefetch).resolves.toEqual({
    image: "previous image",
    outcome: {
      folders: 1,
      notes: 0,
      reason: "storage",
      status: "stopped",
    },
    writes: 2,
  });
  expect(requests.bodyRequests()).toBe(0);
  expect(requests.imageRequests()).toBe(1);
});
