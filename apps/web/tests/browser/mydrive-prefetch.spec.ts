import type { FolderAccess, NoteSummary } from "@miyulabmd/shared";
import { expect, test } from "@playwright/test";
import { note } from "./fixtures/note.ts";

test("authenticated startup prepares unvisited MyDrive folders and bodies without prefetching shared notes", async ({
  page,
}) => {
  const rootId = "alice-root";
  const childId = "unvisited-folder";
  const rootCrumb = { id: rootId, name: "マイドライブ" };
  const childCrumb = { id: childId, name: "まだ開いていない資料" };
  const root: FolderAccess = {
    ...note.access,
    children: [{ ...childCrumb, folder: childCrumb.name, parentId: rootId }],
    crumbs: [rootCrumb],
    folder: "",
    id: rootId,
    locked: true,
    name: rootCrumb.name,
    parentId: null,
  };
  const child: FolderAccess = {
    ...root,
    children: [],
    crumbs: [rootCrumb, childCrumb],
    folder: childCrumb.name,
    id: childId,
    locked: false,
    name: childCrumb.name,
    parentId: rootId,
  };
  const owned = {
    ...note,
    folder: childCrumb.name,
    folderId: childId,
    id: "unvisited-owned-note",
    markdown: "# 自動取得された資料\n\n一度も開かずに準備した本文です。",
    shortId: "unvisited-short",
    title: "未訪問の所有ノート",
  };
  const shared = {
    ...owned,
    folderId: "bobs-shared-folder",
    id: "other-owner-note",
    ownerId: "bob",
    shortId: "other-owner-short",
    title: "他人の共有ノート",
  };
  const summaries: NoteSummary[] = [owned, shared].map(
    ({ markdown: _markdown, ...summary }) => summary,
  );
  const bodyRequests: string[] = [];
  let offline = false;
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (offline) {
      return route.abort("internetdisconnected");
    }
    switch (path) {
      case "/api/me":
        return route.fulfill({
          json: {
            user: {
              displayName: "Alice",
              email: "alice@example.test",
              id: "alice",
            },
          },
        });
      case "/api/auth/config":
        return route.fulfill({ json: { access: false, mock: true } });
      case "/api/notes":
        return route.fulfill({
          headers: { "X-MiyulabMD-Session-User": "user:alice" },
          json: { notes: summaries },
        });
      case "/api/folders/tree":
        return route.fulfill({
          headers: { "X-MiyulabMD-Session-User": "user:alice" },
          json: {
            folders: [
              { ...rootCrumb, folder: "", parentId: null },
              { ...childCrumb, folder: childCrumb.name, parentId: rootId },
            ],
          },
        });
      case "/api/folders":
      case `/api/folders/${rootId}`:
        return route.fulfill({
          headers: { "X-MiyulabMD-Session-User": "user:alice" },
          json: root,
        });
      case `/api/folders/${childId}`:
        return route.fulfill({
          headers: { "X-MiyulabMD-Session-User": "user:alice" },
          json: child,
        });
      case `/api/notes/${owned.id}`:
        bodyRequests.push(owned.id);
        return route.fulfill({
          headers: { "X-MiyulabMD-Session-User": "user:alice" },
          json: owned,
        });
      case `/api/notes/${shared.id}`:
        bodyRequests.push(shared.id);
        return route.fulfill({
          headers: { "X-MiyulabMD-Session-User": "user:alice" },
          json: shared,
        });
      default:
        return route.fulfill({
          headers: { "X-MiyulabMD-Session-User": "user:alice" },
          json: { error: "No fixture" },
          status: 404,
        });
    }
  });

  await page.goto("/");
  await expect(
    page.getByRole("link", { exact: true, name: childCrumb.name }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "新規ノート" })).toBeVisible();
  // No navigation, hover prefetch, direct acquisition calls, or cache seeding:
  // the authenticated app lifetime must prepare this unvisited child itself.
  await expect
    .poll(
      () =>
        page.evaluate(
          async ({ childId, noteId }) => {
            const moduleUrl = "/src/lib/offline-cache.ts";
            const { openOfflineCache } = await import(moduleUrl);
            const cache = await openOfflineCache({ userId: "alice" });
            try {
              return {
                folder: (await cache.getFolder(childId))?.folder.id,
                markdown: (await cache.getNote(noteId))?.note.markdown,
              };
            } finally {
              cache.close();
            }
          },
          { childId, noteId: owned.id },
        ),
      { timeout: 10_000 },
    )
    .toEqual({ folder: childId, markdown: owned.markdown });
  expect(bodyRequests).toContain(owned.id);
  expect(bodyRequests).not.toContain(shared.id);
  await expect(page).toHaveURL(/\/$/);

  // The development shell stays reachable; this is data acquisition coverage,
  // not a replacement for the separate production Service Worker tests.
  offline = true;
  await page.reload();
  await page.getByRole("link", { exact: true, name: childCrumb.name }).click();
  await expect(page.getByRole("link", { name: owned.title })).toBeVisible();
  await page.getByRole("link", { name: owned.title }).click();
  await expect(
    page.getByText("一度も開かずに準備した本文です。"),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "オフライン" })).toBeVisible();
  await expect(
    page.getByRole("button", { exact: true, name: "編集" }),
  ).toHaveCount(0);
});
