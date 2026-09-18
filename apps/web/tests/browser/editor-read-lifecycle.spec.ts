import { expect, type Page, test } from "@playwright/test";
import { note } from "./fixtures/note.ts";

// Every request in these fixtures is served by Alice, including late replies.
const headers = { "X-MiyulabMD-Session-User": "user:alice" };

async function mockEditorApis(
  page: Page,
  mode: "normal" | "denied-note" | "unavailable-viewer" = "normal",
) {
  const writes: string[] = [];
  let noteReads = 0;
  const second = {
    ...note,
    folder: "second-folder",
    id: "note-2",
    markdown: "# Second\n\nSecond body",
    shortId: "short-2",
    title: "Second",
  };
  await page.route("**/api/**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      writes.push(`${request.method()} ${path}`);
      return route.fulfill({ headers, json: note });
    }
    switch (path) {
      case "/api/me":
        if (mode === "unavailable-viewer") {
          return route.fulfill({
            headers,
            json: { error: "Forbidden" },
            status: 403,
          });
        }
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
      case "/api/article-sources":
        return route.fulfill({ headers, json: { sources: [] } });
      case `/api/notes/${note.id}`:
        noteReads += 1;
        return mode === "denied-note"
          ? route.fulfill({
              headers,
              json: { error: "Forbidden" },
              status: 403,
            })
          : route.fulfill({ headers, json: note });
      case `/api/notes/${second.id}`:
        return route.fulfill({ headers, json: second });
      default:
        return route.fulfill({
          headers,
          json: { error: "No fixture" },
          status: 404,
        });
    }
  });
  return {
    get noteReads() {
      return noteReads;
    },
    second,
    writes,
  };
}

test("viewing an editable note warms collaboration and edit mode keeps the session", async ({
  page,
}) => {
  const { second } = await mockEditorApis(page);
  let connections = 0;
  await page.routeWebSocket("**/ws/notes/**", () => {
    connections += 1;
  });
  // Preview warms the edit cache session so the note is offline-editable.
  await page.goto(`/n/${note.id}`);
  await expect(page.getByText("通信なしでも読みたい本文。")).toBeVisible();
  await expect.poll(() => connections).toBe(1);
  // Entering edit mode reuses the warmed session instead of reconnecting.
  await page.getByRole("button", { exact: true, name: "Edit" }).click();
  await expect(page).toHaveURL(/[?&]mode=edit/);
  expect(connections).toBe(1);

  await page.evaluate((id) => {
    history.pushState(history.state, "", `/n/${id}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, second.id);
  await expect(page.getByText("Second body", { exact: true })).toBeVisible();
  await expect.poll(() => connections).toBe(2);
  await page.getByRole("button", { exact: true, name: "Edit" }).click();
  await expect(page).toHaveURL(/[?&]mode=edit/);
  expect(connections).toBe(2);
});

test("a failed note read never grants mutation access", async ({ page }) => {
  const { writes } = await mockEditorApis(page, "denied-note");
  await page.goto(`/n/${note.id}`);
  await expect(
    page.getByText(/Forbidden|このノートを表示する権限がありません/),
  ).toBeVisible();
  const outcome = await page.evaluate(async (id) => {
    const moduleUrl = "/src/lib/api.ts";
    const api = await import(moduleUrl);
    try {
      await api.updateNote(id, { title: "Must not be sent" });
      return "not-blocked";
    } catch (error) {
      return error instanceof Error ? error.name : "UnknownError";
    }
  }, note.id);
  expect(outcome).toBe("ReadOnlyViewingError");
  expect(writes).toEqual([]);
});

test("an unavailable viewer cannot initiate a note read or editing", async ({
  page,
}) => {
  const activity = await mockEditorApis(page, "unavailable-viewer");
  await page.goto(`/n/${note.id}`);
  await expect(page.getByText(/閲覧情報を確認できません/)).toBeVisible();
  expect(activity.noteReads).toBe(0);
  await expect(page.getByText("通信なしでも読みたい本文。")).toHaveCount(0);
  await expect(
    page.getByRole("button", { exact: true, name: "Edit" }),
  ).toHaveCount(0);
});

async function nextFrames(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

for (const outcome of ["success", "failure"] as const) {
  test(`a late folder ${outcome} cannot change the next note or seed legacy cache`, async ({
    page,
  }) => {
    const { second } = await mockEditorApis(page);
    let started: () => void = () => {
      // Assigned synchronously below.
    };
    const mutationStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release: (() => Promise<void>) | undefined;
    await page.route(`**/api/notes/${note.id}`, (route) => {
      if (route.request().method() !== "PATCH") {
        return route.fallback();
      }
      release = () =>
        outcome === "success"
          ? route.fulfill({
              headers,
              json: { ...note, folder: "late-old-folder" },
            })
          : route.fulfill({
              headers,
              json: { error: "Old save failed" },
              status: 500,
            });
      started();
    });
    await page.goto(`/n/${note.id}`);
    await expect(page.getByText("通信なしでも読みたい本文。")).toBeVisible();
    await page.getByRole("button", { exact: true, name: "フォルダ" }).click();
    await page.getByLabel("ノートのフォルダ").fill("requested-folder");
    await nextFrames(page);
    await page.getByLabel("ノートのフォルダ").press("Tab");
    await mutationStarted;

    await page.evaluate((id) => {
      history.pushState(history.state, "", `/n/${id}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, second.id);
    await expect(page.getByText("Second body", { exact: true })).toBeVisible();
    if (!release) {
      throw new Error("Folder mutation was not captured");
    }
    const response = page.waitForResponse(
      (value) =>
        value.request().method() === "PATCH" &&
        new URL(value.url()).pathname === `/api/notes/${note.id}`,
    );
    await release();
    await (await response).finished();
    await nextFrames(page);
    await page.getByRole("button", { exact: true, name: "フォルダ" }).click();
    await expect(page.getByLabel("ノートのフォルダ")).toHaveValue(
      second.folder,
    );
    await expect(
      page.getByText("Old save failed", { exact: true }),
    ).toHaveCount(0);
    const stale = await page.evaluate(async (id) => {
      const moduleUrl = "/src/lib/note-cache.ts";
      const { peekNote } = await import(moduleUrl);
      return peekNote(id) ?? null;
    }, note.id);
    expect(stale).toBeNull();
  });
}

test("an open share dialog is not carried into another cached note", async ({
  page,
}) => {
  const { second } = await mockEditorApis(page);
  await page.route(`**/api/notes/${second.id}`, (route) =>
    route.fulfill({ headers, json: { error: "Unavailable" }, status: 503 }),
  );
  await page.goto(`/n/${note.id}`);
  await expect(page.getByText("通信なしでも読みたい本文。")).toBeVisible();
  await page.evaluate(async (cachedNote) => {
    const moduleUrl = "/src/lib/offline-cache.ts";
    const { openOfflineCache } = await import(moduleUrl);
    const cache = await openOfflineCache({ userId: "alice" });
    try {
      await cache.putNote(cachedNote);
    } finally {
      cache.close();
    }
  }, second);
  await page.getByRole("button", { exact: true, name: "共有" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.evaluate((id) => {
    history.pushState(history.state, "", `/n/${id}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, second.id);
  await expect(page.getByText("Second body", { exact: true })).toBeVisible();
  // 表示キャッシュ由来かつ未同期のノートは閲覧のみ（Edit は出ない）。
  await expect(
    page.getByRole("button", { exact: true, name: "Edit" }),
  ).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
