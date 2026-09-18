import { expect, test } from "@playwright/test";
import { note } from "./fixtures/note.ts";

const image = {
  imageId: "image-1",
  noteId: "note-1",
  url: "/api/notes/note-1/images/image-1",
};
const imagePath = image.url;

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/browser/fixtures/storage.html");
});

test("network-only preview verifies guest and authenticated actors without storage", async ({
  page,
}) => {
  const result = await page.evaluate(async (target) => {
    const { acquireAttachedImageNetworkOnly } = await import(
      "/src/lib/network-attached-images.ts"
    );
    const originalFetch = globalThis.fetch;
    const originalOpen = indexedDB.open;
    const originalDirectory = navigator.storage.getDirectory;
    let requests = 0;
    let opens = 0;
    let directories = 0;
    globalThis.fetch = (_input, init) => {
      requests += 1;
      const expected = (init?.headers as Headers | undefined)?.get(
        "X-MiyulabMD-Session-User",
      );
      // apiFetch carries the expected identity in its own option, while the
      // fixture response represents the server's checked session identity.
      const actor = expected ?? (requests === 2 ? "guest" : "user:alice");
      return Promise.resolve(
        new Response("png", {
          headers: {
            "Content-Type": "image/png",
            "X-MiyulabMD-Session-User": actor,
          },
        }),
      );
    };
    indexedDB.open = ((...args: Parameters<typeof indexedDB.open>) => {
      opens += 1;
      return originalOpen.apply(indexedDB, args);
    }) as typeof indexedDB.open;
    navigator.storage.getDirectory = () => {
      directories += 1;
      return Promise.reject(new Error("network-only opened OPFS"));
    };
    try {
      const guestWrong = await acquireAttachedImageNetworkOnly(target, {
        expectedViewerId: null,
      });
      const guest = await acquireAttachedImageNetworkOnly(target, {
        expectedViewerId: null,
      });
      const alice = await acquireAttachedImageNetworkOnly(target, {
        expectedViewerId: "alice",
      });
      return {
        alice: Boolean(alice),
        aliceBytes: await alice?.text(),
        directories,
        guest: Boolean(guest),
        guestBytes: await guest?.text(),
        guestWrong: Boolean(guestWrong),
        opens,
        requests,
      };
    } finally {
      globalThis.fetch = originalFetch;
      indexedDB.open = originalOpen;
      navigator.storage.getDirectory = originalDirectory;
    }
  }, image);
  // A response carrying another actor must not be accepted as guest.
  expect(result.guestWrong).toBe(false);
  expect(result.guest).toBe(true);
  expect(result.alice).toBe(true);
  expect(result.guestBytes).toBe("png");
  expect(result.aliceBytes).toBe("png");
  expect(result.opens).toBe(0);
  expect(result.directories).toBe(0);
});

test("actor namespaces do not share requests and same actor shares one request", async ({
  page,
}) => {
  const result = await page.evaluate(async (target) => {
    const { acquireAttachedImageNetworkOnly } = await import(
      "/src/lib/network-attached-images.ts"
    );
    let requests = 0;
    const releases: Array<(response: Response) => void> = [];
    globalThis.fetch = () => {
      requests += 1;
      return new Promise<Response>((resolve) => {
        releases.push(resolve);
      });
    };
    const firstController = new AbortController();
    const second = acquireAttachedImageNetworkOnly(target, {
      expectedViewerId: "alice",
      signal: firstController.signal,
    });
    const third = acquireAttachedImageNetworkOnly(target, {
      expectedViewerId: "alice",
    });
    const guest = acquireAttachedImageNetworkOnly(target, {
      expectedViewerId: null,
    }).catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const beforeAbort = requests;
    firstController.abort("first consumer left");
    for (const resolve of releases) {
      resolve(
        new Response("png", {
          headers: {
            "Content-Type": "image/png",
            "X-MiyulabMD-Session-User": "user:alice",
          },
        }),
      );
    }
    const values = await Promise.allSettled([second, third, guest]);
    return {
      beforeAbort,
      requests,
      second: values[0]?.status,
      third: values[1]?.status,
    };
  }, image);
  expect(result.beforeAbort).toBe(2);
  expect(result.requests).toBe(2);
  expect(result.second).toBe("rejected");
  expect(result.third).toBe("fulfilled");
});

test("managed images are hidden without context while external images remain", async ({
  page,
}) => {
  const html = await page.evaluate(async () => {
    const { resolvePreviewImages } = await import("/src/lib/preview-images.ts");
    return resolvePreviewImages(
      '<img src="/api/notes/note-1/images/image-1"><img src="https://example.com/x.png">',
      { enabled: false, urls: new Map() },
    );
  });
  expect(html).not.toContain("/api/notes/note-1/images/image-1");
  expect(html).toContain("https://example.com/x.png");
});

test("DOM-free image fallback strips managed sources and preserves prose", async ({
  page,
}) => {
  const html = await page.evaluate(async () => {
    const { sanitizePreviewImagesWithoutDocument } = await import(
      "/src/lib/preview-images.ts"
    );
    return sanitizePreviewImagesWithoutDocument(
      '<p>本文</p><img alt="managed" src="/api/notes/note-1/images/image-1"><img alt="external" src="https://example.com/x.png">',
    );
  });
  expect(html).toContain("<p>本文</p>");
  expect(html).toContain('alt="managed"');
  expect(html).not.toContain("/api/notes/note-1/images/image-1");
  expect(html).toContain("https://example.com/x.png");
});

test("guest MarkdownPreview displays checked attachments through a blob URL", async ({
  page,
}) => {
  const displayed = {
    ...note,
    markdown: `${note.markdown}\n\n![Network attachment](${imagePath})`,
  };
  const imageRequests: string[] = [];
  let wrongActor = true;
  page.on("request", (request) => {
    if (request.resourceType() === "image") {
      imageRequests.push(new URL(request.url()).pathname);
    }
  });
  await page.route("**/api/**", (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === imagePath) {
      return route.fulfill({
        body: "png",
        contentType: "image/png",
        headers: {
          "X-MiyulabMD-Session-User": wrongActor ? "user:alice" : "guest",
        },
      });
    }
    if (pathname === `/api/notes/${note.id}`) {
      return route.fulfill({
        headers: { "X-MiyulabMD-Session-User": "guest" },
        json: displayed,
      });
    }
    if (pathname === "/api/me") {
      return route.fulfill({ body: "guest", status: 401 });
    }
    return route.fulfill({
      headers: { "X-MiyulabMD-Session-User": "guest" },
      json: { backlinks: [], outgoing: [] },
    });
  });
  await page.goto(`/n/${note.id}`);
  const previewImage = page.getByRole("img", { name: "Network attachment" });
  await expect(previewImage).toBeAttached();
  await expect(previewImage).not.toHaveAttribute("src");
  await expect(previewImage).not.toBeVisible();
  wrongActor = false;
  await page.reload();
  await expect(previewImage).toBeVisible();
  await expect.poll(() => previewImage.getAttribute("src")).toMatch(/^blob:/);
  expect(imageRequests).toEqual([]);
});

test("guest and Alice requests never share the same URL transport", async ({
  page,
}) => {
  const requests = await page.evaluate(async (target) => {
    const { acquireAttachedImageNetworkOnly } = await import(
      "/src/lib/network-attached-images.ts"
    );
    let count = 0;
    globalThis.fetch = () => {
      count += 1;
      return Promise.resolve(
        new Response("png", {
          headers: {
            "Content-Type": "image/png",
            "X-MiyulabMD-Session-User": count === 1 ? "guest" : "user:alice",
          },
        }),
      );
    };
    await Promise.all([
      acquireAttachedImageNetworkOnly(target, { expectedViewerId: null }),
      acquireAttachedImageNetworkOnly(target, { expectedViewerId: "alice" }),
    ]);
    return count;
  }, image);
  expect(requests).toBe(2);
});

test("unsupported MIME and empty bodies are rejected", async ({ page }) => {
  const results = await page.evaluate(async (target) => {
    const { acquireAttachedImageNetworkOnly } = await import(
      "/src/lib/network-attached-images.ts"
    );
    let call = 0;
    globalThis.fetch = () =>
      Promise.resolve(
        new Response(call++ === 0 ? "text" : "", {
          headers: {
            "Content-Type": call === 1 ? "text/plain" : "image/png",
            "X-MiyulabMD-Session-User": "guest",
          },
        }),
      );
    return [
      await acquireAttachedImageNetworkOnly(target, { expectedViewerId: null }),
      await acquireAttachedImageNetworkOnly(target, { expectedViewerId: null }),
    ].map(Boolean);
  }, image);
  expect(results).toEqual([false, false]);
});

test("401, 403, 404, and 500 never produce raw preview bytes", async ({
  page,
}) => {
  const results = await page.evaluate(async (baseImage) => {
    const { acquireAttachedImageNetworkOnly } = await import(
      "/src/lib/network-attached-images.ts"
    );
    const statuses = [401, 403, 404, 500];
    let index = 0;
    globalThis.fetch = () =>
      new Response("", {
        headers: { "X-MiyulabMD-Session-User": "guest" },
        status: statuses[index++] ?? 500,
      });
    return Promise.all(
      statuses.map((status) =>
        acquireAttachedImageNetworkOnly(
          { ...baseImage, imageId: `image-${status}` },
          { expectedViewerId: null },
        ),
      ),
    ).then((values) => values.map(Boolean));
  }, image);
  expect(results).toEqual([false, false, false, false]);
});

test("missing or mismatched identity is rejected", async ({ page }) => {
  const result = await page.evaluate(async (target) => {
    const { acquireAttachedImageNetworkOnly } = await import(
      "/src/lib/network-attached-images.ts"
    );
    globalThis.fetch = () =>
      Promise.resolve(
        new Response("png", { headers: { "Content-Type": "image/png" } }),
      );
    return Boolean(
      await acquireAttachedImageNetworkOnly(target, {
        expectedViewerId: "alice",
      }),
    );
  }, image);
  expect(result).toBe(false);
});

test("late response after consumer abort is not published", async ({
  page,
}) => {
  const result = await page.evaluate(async (target) => {
    const { acquireAttachedImageNetworkOnly } = await import(
      "/src/lib/network-attached-images.ts"
    );
    const controller = new AbortController();
    globalThis.fetch = () =>
      new Promise<Response>((_resolve, _reject) => {
        // Keep transport pending to verify a late response cannot publish.
      });
    const pending = acquireAttachedImageNetworkOnly(target, {
      expectedViewerId: "alice",
      signal: controller.signal,
    });
    controller.abort("unmounted");
    return Promise.allSettled([pending]).then((values) => values[0]?.status);
  }, image);
  expect(result).toBe("rejected");
});

test("cache-disabled authenticated preview performs zero local storage calls", async ({
  page,
}) => {
  const result = await page.evaluate(async (target) => {
    let opens = 0;
    const original = indexedDB.open;
    indexedDB.open = ((...args: Parameters<typeof indexedDB.open>) => {
      opens += 1;
      return original.apply(indexedDB, args);
    }) as typeof indexedDB.open;
    const originalDirectory = navigator.storage.getDirectory;
    let directories = 0;
    navigator.storage.getDirectory = () => {
      directories += 1;
      return Promise.reject(new Error("network-only opened OPFS"));
    };
    try {
      const { acquireAttachedImageNetworkOnly } = await import(
        "/src/lib/network-attached-images.ts"
      );
      globalThis.fetch = () =>
        Promise.resolve(
          new Response("png", {
            headers: {
              "Content-Type": "image/png",
              "X-MiyulabMD-Session-User": "guest",
            },
          }),
        );
      await acquireAttachedImageNetworkOnly(target, { expectedViewerId: null });
      return { directories, opens };
    } finally {
      indexedDB.open = original;
      navigator.storage.getDirectory = originalDirectory;
    }
  }, image);
  expect(result).toEqual({ directories: 0, opens: 0 });
});
