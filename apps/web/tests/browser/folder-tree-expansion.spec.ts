import type {
  FolderAccess,
  FolderChildrenResult,
  NoteSummary,
} from "@miyulabmd/shared";
import { expect, test } from "@playwright/test";
import { note } from "./fixtures/note.ts";

const headers = { "X-MiyulabMD-Session-User": "user:alice" };

const rootFolder: FolderAccess = {
  children: [
    { id: "f-docs", name: "docs", parentId: "alice-root" },
    { id: "f-empty", name: "empty", parentId: "alice-root" },
    { id: "f-paged", name: "paged", parentId: "alice-root" },
    { id: "f-broken", name: "broken", parentId: "alice-root" },
  ],
  crumbs: [],
  effectiveReadScope: "self",
  effectiveWriteScope: "self",
  flags: { canAdmin: true, canEdit: true, canView: true },
  folder: "",
  grants: [],
  id: "alice-root",
  inherit: true,
  locked: true,
  name: "マイドライブ",
  parentId: null,
  readScope: null,
  source: "default",
  sourceFolder: null,
  writeScope: null,
};

const childNote: NoteSummary = {
  ...note,
  folderId: "f-docs",
  id: "n-child",
  title: "child note",
};

function childrenResult(
  id: string,
  entries: FolderChildrenResult["entries"],
  nextCursor: string | null = null,
): FolderChildrenResult {
  return {
    entries,
    folder: { id, name: id, path: [id] },
    nextCursor,
  };
}

async function mockHome(
  page: import("@playwright/test").Page,
  overrides: Record<
    string,
    (route: import("@playwright/test").Route) => void | Promise<void>
  > = {},
) {
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    const override = overrides[pathname];
    if (override) {
      return override(route);
    }
    switch (pathname) {
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
        return route.fulfill({ headers, json: { notes: [childNote] } });
      case "/api/folders":
        return route.fulfill({ headers, json: rootFolder });
      case "/api/folders/f-docs/children":
        return route.fulfill({
          headers,
          json: childrenResult("f-docs", [
            {
              id: "f-inner",
              name: "inner",
              noteCount: 2,
              parentId: "f-docs",
              type: "folder",
              updatedAt: 1,
            },
            { id: "n-child", title: "child note", type: "note", updatedAt: 2 },
          ]),
        });
      case "/api/folders/f-empty/children":
        return route.fulfill({
          headers,
          json: childrenResult("f-empty", []),
        });
      case "/api/folders/f-paged/children":
        if (url.searchParams.get("cursor") === "50") {
          return route.fulfill({
            headers,
            json: childrenResult("f-paged", [
              { id: "n-p2", title: "paged note 2", type: "note", updatedAt: 2 },
            ]),
          });
        }
        return route.fulfill({
          headers,
          json: childrenResult(
            "f-paged",
            [
              {
                id: "n-p1",
                title: "paged note 1",
                type: "note",
                updatedAt: 1,
              },
            ],
            "50",
          ),
        });
      default:
        return route.fulfill({
          headers,
          json: { error: "No fixture" },
          status: 404,
        });
    }
  });
}

test("expanding a folder lazily loads children, nested folders, and collapses", async ({
  page,
}) => {
  await mockHome(page);
  await page.goto("/tests/browser/fixtures/home-owner.html");

  const expand = page.getByRole("button", { name: "docs を展開" });
  await expect(expand).toBeVisible();

  const requested = page.waitForRequest((request) =>
    request.url().includes("/api/folders/f-docs/children"),
  );
  await expand.click();
  await requested;

  await expect(page.getByRole("link", { name: "inner" })).toBeVisible();
  const childLink = page.getByRole("link", { name: "child note" });
  await expect(childLink).toBeVisible();
  await expect(childLink).toHaveAttribute("href", "/n/n-child");
  await expect(
    page.getByRole("button", { name: "docs を折りたたむ" }),
  ).toBeVisible();

  // Nested expansion works inside the loaded page.
  await page.getByRole("button", { name: "inner を展開" }).click();
  await expect(
    page.getByRole("button", { name: "inner を折りたたむ" }),
  ).toBeVisible();

  // Collapsing the parent hides the whole subtree.
  await page.getByRole("button", { name: "docs を折りたたむ" }).click();
  await expect(page.getByRole("link", { name: "inner" })).toHaveCount(0);
  await expect(childLink).toHaveCount(0);
});

test("an empty expanded folder shows an inline empty state", async ({
  page,
}) => {
  await mockHome(page);
  await page.goto("/tests/browser/fixtures/home-owner.html");
  await page.getByRole("button", { name: "empty を展開" }).click();
  await expect(page.getByText("このフォルダは空です。")).toBeVisible();
});

test("a paginated expansion appends the next page via さらに表示", async ({
  page,
}) => {
  await mockHome(page);
  await page.goto("/tests/browser/fixtures/home-owner.html");
  await page.getByRole("button", { name: "paged を展開" }).click();
  await expect(page.getByRole("link", { name: "paged note 1" })).toBeVisible();

  const more = page.getByRole("button", { name: "さらに表示" });
  await expect(more).toBeVisible();
  const requested = page.waitForRequest(
    (request) =>
      request.url().includes("/api/folders/f-paged/children") &&
      request.url().includes("cursor=50"),
  );
  await more.click();
  await requested;
  await expect(page.getByRole("link", { name: "paged note 2" })).toBeVisible();
  await expect(page.getByRole("button", { name: "さらに表示" })).toHaveCount(0);
});

test("a failed expansion shows an error row that retries on click", async ({
  page,
}) => {
  let fail = true;
  await mockHome(page, {
    "/api/folders/f-broken/children": (route) =>
      fail
        ? route.fulfill({
            headers,
            json: { error: "children failed" },
            status: 500,
          })
        : route.fulfill({
            headers,
            json: childrenResult("f-broken", [
              {
                id: "n-fix",
                title: "recovered note",
                type: "note",
                updatedAt: 1,
              },
            ]),
          }),
  });
  await page.goto("/tests/browser/fixtures/home-owner.html");
  await page.getByRole("button", { name: "broken を展開" }).click();
  const errorRow = page.getByRole("button", { name: /もう一度試す/ });
  await expect(errorRow).toBeVisible();
  fail = false;
  const retried = page.waitForRequest((request) =>
    request.url().includes("/api/folders/f-broken/children"),
  );
  await errorRow.click();
  await retried;
  await expect(
    page.getByRole("link", { name: "recovered note" }),
  ).toBeVisible();
});
