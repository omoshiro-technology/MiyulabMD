import { expect, type Page, test } from "@playwright/test";
import { note } from "./fixtures/note.ts";

const headers = { "X-MiyulabMD-Session-User": "user:alice" };
const imagePath = "/api/notes/another-parent/images/image";
const markdown = `${note.markdown}\n\n![Attachment](${imagePath})`;
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);

async function fixture(page: Page) {
  await page.route("**/api/**", (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === `/api/notes/${note.id}`) {
      return route.fulfill({ headers, json: { ...note, markdown } });
    }
    if (pathname === "/api/me") {
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
    }
    if (pathname === "/api/auth/config") {
      return route.fulfill({ headers, json: { access: false, mock: true } });
    }
    if (pathname === "/api/article-sources") {
      return route.fulfill({ headers, json: { sources: [] } });
    }
    return route.fulfill({
      headers,
      json: { error: "No fixture" },
      status: 404,
    });
  });
}

test("a confirmed image denial removes only that displayed attachment", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const revoke = URL.revokeObjectURL;
    const revoked: string[] = [];
    Object.assign(window, { revokedImageUrls: revoked });
    URL.revokeObjectURL = (url) => {
      revoked.push(url);
      revoke(url);
    };
  });
  await fixture(page);
  const otherPath = "/api/notes/another-parent/images/other";
  await page.route(`**/api/notes/${note.id}`, (route) =>
    route.fulfill({
      headers,
      json: { ...note, markdown: `${markdown}\n\n![Other](${otherPath})` },
    }),
  );
  let denied = false;
  await page.route(`**${imagePath}`, (route) =>
    denied
      ? route.fulfill({ headers, json: { error: "Forbidden" }, status: 403 })
      : route.fulfill({ body: png, contentType: "image/png", headers }),
  );
  await page.route(`**${otherPath}`, (route) =>
    route.fulfill({ body: png, contentType: "image/png", headers }),
  );
  await page.goto(`/n/${note.id}`);
  const image = page.getByRole("img", { exact: true, name: "Attachment" });
  const other = page.getByRole("img", { exact: true, name: "Other" });
  for (const target of [image, other]) {
    await expect
      .poll(() =>
        target.evaluate((node: HTMLImageElement) => node.naturalWidth),
      )
      .toBe(1);
  }
  const oldSource = (await image.getAttribute("src")) ?? "";
  const otherSource = (await other.getAttribute("src")) ?? "";
  denied = true;
  expect(
    await page.evaluate(async (url) => {
      const imageUrl = "/src/lib/attached-images.ts";
      const { acquireAttachedImage, attachedImage } = await import(imageUrl);
      return await acquireAttachedImage(attachedImage(url), {
        cacheOnly: false,
        userId: "alice",
      });
    }, imagePath),
  ).toBeNull();
  await expect(image).not.toHaveAttribute("src", oldSource);
  await expect
    .poll(() =>
      page.evaluate(
        (src) =>
          (
            window as Window & { revokedImageUrls: string[] }
          ).revokedImageUrls.includes(src),
        oldSource,
      ),
    )
    .toBe(true);
  await expect(other).toHaveAttribute("src", otherSource);
  await expect
    .poll(() => other.evaluate((node: HTMLImageElement) => node.naturalWidth))
    .toBe(1);
  await expect(
    page.getByText("通信なしでも読みたい本文。", { exact: true }),
  ).toBeVisible();
});

test("foreground body displays before a slow attachment; missing attachment is meaningful", async ({
  page,
}) => {
  await fixture(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**${imagePath}`, async (route) => {
    await gate;
    await route.fulfill({ headers, json: { error: "Forbidden" }, status: 403 });
  });
  await page.goto(`/n/${note.id}`);
  await expect(
    page.getByText("通信なしでも読みたい本文。", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: "画像を読み込み中" }),
  ).toBeVisible();
  release();
  await expect(
    page.getByRole("status").filter({ hasText: "画像を表示できません" }),
  ).toBeVisible();
  await expect(
    page.getByText("通信なしでも読みたい本文。", { exact: true }),
  ).toBeVisible();
});

test("preview owns blob URLs and purge removes visible assets and revokes them", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const create = URL.createObjectURL;
    const revoke = URL.revokeObjectURL;
    const tracking = { created: [] as string[], revoked: [] as string[] };
    Object.assign(window, { imageUrlTracking: tracking });
    URL.createObjectURL = (blob) => {
      const url = create(blob);
      tracking.created.push(url);
      return url;
    };
    URL.revokeObjectURL = (url) => {
      tracking.revoked.push(url);
      revoke(url);
    };
  });
  await fixture(page);
  let calls = 0;
  await page.route(`**${imagePath}`, (route) => {
    calls += 1;
    return route.fulfill({ body: png, contentType: "image/png", headers });
  });
  await page.goto(`/n/${note.id}`);
  const image = page.getByRole("img", { name: "Attachment" });
  await expect
    .poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth))
    .toBe(1);
  expect(calls).toBe(1);
  const src = await image.getAttribute("src");
  expect(src).toMatch(/^blob:/);
  await page.evaluate(async () => {
    const moduleUrl = "/src/lib/offline-cache.ts";
    const { clearOfflineCacheUser } = await import(moduleUrl);
    await clearOfflineCacheUser("alice");
  });
  await expect(page.locator(`img[src="${src}"]`)).toHaveCount(0);
  const tracking = await page.evaluate(
    () =>
      (
        window as unknown as {
          imageUrlTracking: { created: string[]; revoked: string[] };
        }
      ).imageUrlTracking,
  );
  expect(tracking.revoked).toEqual(expect.arrayContaining(tracking.created));
});

test("peer parent-note denial revokes only that parent's mounted image", async ({
  page,
  context,
}) => {
  await fixture(page);
  const otherPath = "/api/notes/independent-parent/images/other";
  await page.route(`**/api/notes/${note.id}`, (route) =>
    route.fulfill({
      headers,
      json: {
        ...note,
        markdown: `${markdown}\n\n![Other parent](${otherPath})`,
      },
    }),
  );
  for (const path of [imagePath, otherPath]) {
    await page.route(`**${path}`, (route) =>
      route.fulfill({ body: png, contentType: "image/png", headers }),
    );
  }
  await page.goto(`/n/${note.id}`);
  const image = page.getByRole("img", { exact: true, name: "Attachment" });
  const other = page.getByRole("img", { exact: true, name: "Other parent" });
  for (const target of [image, other]) {
    await expect
      .poll(() =>
        target.evaluate((element: HTMLImageElement) => element.naturalWidth),
      )
      .toBe(1);
  }
  const previous = await image.getAttribute("src");
  const independent = await other.getAttribute("src");
  const peer = await context.newPage();
  try {
    await peer.goto("/tests/browser/fixtures/storage.html");
    await peer.route("**/api/notes/another-parent", (route) =>
      route.fulfill({ headers, json: { error: "Forbidden" }, status: 403 }),
    );
    const denied = await peer.evaluate(async () => {
      const url = "/src/lib/note-read-session.ts";
      const { createNoteReadSession } = await import(url);
      const session = createNoteReadSession({
        cacheViewerId: "alice",
        mode: "authenticated",
        user: {
          displayName: "Alice",
          email: "alice@example.test",
          id: "alice",
        },
      });
      try {
        return await session.read("another-parent");
      } finally {
        session.dispose();
      }
    });
    expect(denied).toMatchObject({ ok: false, status: 403 });
    await expect(image).not.toHaveAttribute("src", previous ?? "");
    await expect(other).toHaveAttribute("src", independent ?? "");
    await expect(
      page.getByText("通信なしでも読みたい本文。", { exact: true }),
    ).toBeVisible();
  } finally {
    await peer.close();
  }
});
