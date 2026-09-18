import type {
  FolderAccess,
  NoteSummary,
  ParaBucket,
  ParaListResult,
} from "@miyulabmd/shared";
import { expect, type Page, test } from "@playwright/test";
import { note } from "./fixtures/note.ts";

const headers = { "X-MiyulabMD-Session-User": "user:alice" };

const rootFolder: FolderAccess = {
  children: [
    { folder: "docs", id: "f-docs", name: "docs", parentId: "alice-root" },
    {
      folder: "Projects/Experiment",
      id: "f-exp",
      name: "Experiment",
      parentId: "alice-root",
    },
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

const looseNote: NoteSummary = {
  ...note,
  folderId: "alice-root",
  id: "n-loose",
  title: "loose note",
};

const paraBuckets: ParaBucket[] = [
  {
    folderId: "f-projects",
    key: "projects",
    name: "Projects",
    noteCount: 1,
    path: "Projects",
  },
  {
    folderId: "f-areas",
    key: "areas",
    name: "Areas",
    noteCount: 0,
    path: "Areas",
  },
  {
    folderId: "f-resources",
    key: "resources",
    name: "Resources",
    noteCount: 3,
    path: "Resources",
  },
  {
    folderId: "f-archives",
    key: "archives",
    name: "Archives",
    noteCount: 0,
    path: "Archives",
  },
];

// §2.5: /api/para returns spaces; buckets on the root for the default space.
const paraList: ParaListResult = {
  buckets: paraBuckets,
  spaces: [
    {
      buckets: paraBuckets,
      id: "default",
      isDefault: true,
      name: "Personal",
      rootFolderId: null,
      rootPath: "",
    },
  ],
};

async function mockHome(page: Page) {
  await page.route("**/api/**", (route) => {
    const pathname = new URL(route.request().url()).pathname;
    switch (pathname) {
      case "/api/me":
        return route.fulfill({
          json: {
            user: {
              displayName: "Alice",
              email: "alice@example.test",
              id: "alice",
              // PARA is opt-in (§2.1): the fixture user has it enabled.
              settings: {
                knowledge: { layers: true, para: true, schemes: true },
              },
            },
          },
        });
      case "/api/auth/config":
        return route.fulfill({ json: { access: false, mock: true } });
      case "/api/para":
        return route.fulfill({ headers, json: paraList });
      case "/api/notes":
        return route.fulfill({ headers, json: { notes: [looseNote] } });
      case "/api/notes/move":
        return route.fulfill({
          headers,
          json: {
            destFolderId: "f-docs",
            destPath: "docs",
            dryRun: false,
            failed: 0,
            items: [{ noteId: "n-loose", status: "moved" }],
            moved: 1,
            skipped: 0,
          },
        });
      case "/api/folders":
        return route.fulfill({ headers, json: rootFolder });
      case "/api/folders/f-docs/move":
        return route.fulfill({
          headers,
          json: {
            dryRun: false,
            from: "docs",
            plan: {
              articleSources: 0,
              folders: 1,
              grants: 0,
              notes: 0,
              policies: 0,
            },
            to: "Resources/docs",
          },
        });
      case "/api/para/archive":
        return route.fulfill({
          headers,
          json: {
            dryRun: false,
            from: "Projects/Experiment",
            plan: {
              articleSources: 0,
              folders: 1,
              grants: 0,
              notes: 0,
              policies: 0,
            },
            to: "Archives/2025-01-Experiment",
          },
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

function rowFor(page: Page, name: string) {
  return page
    .locator("li")
    .filter({ has: page.getByRole("link", { exact: true, name }) });
}

test("the PARA section lists the four buckets at the drive root", async ({
  page,
}) => {
  await mockHome(page);
  await page.goto("/tests/browser/fixtures/home-owner.html");

  const para = page.getByRole("region", { name: "PARA" });
  await expect(para).toBeVisible();
  for (const name of ["Projects", "Areas", "Resources", "Archives"]) {
    await expect(para.getByRole("link", { name })).toBeVisible();
  }
});

test("dropping a note onto a folder calls the move API", async ({ page }) => {
  const moves: unknown[] = [];
  await mockHome(page);
  await page.route("**/api/notes/move", (route) => {
    moves.push(route.request().postDataJSON());
    return route.fulfill({
      headers,
      json: {
        destFolderId: "f-docs",
        destPath: "docs",
        dryRun: false,
        failed: 0,
        items: [{ noteId: "n-loose", status: "moved" }],
        moved: 1,
        skipped: 0,
      },
    });
  });
  await page.goto("/tests/browser/fixtures/home-owner.html");

  const source = rowFor(page, "loose note");
  const target = rowFor(page, "docs");
  await expect(source).toHaveAttribute("draggable", "true");

  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await source.dispatchEvent("dragstart", { dataTransfer });
  await target.dispatchEvent("dragover", { dataTransfer });
  await target.dispatchEvent("drop", { dataTransfer });

  await expect.poll(() => moves.length).toBe(1);
  expect(moves[0]).toMatchObject({
    destFolderId: "f-docs",
    noteIds: ["n-loose"],
  });
});

test("dropping a folder onto a PARA bucket calls the folder move API", async ({
  page,
}) => {
  const moves: unknown[] = [];
  await mockHome(page);
  await page.route("**/api/folders/f-docs/move", (route) => {
    moves.push(route.request().postDataJSON());
    return route.fulfill({
      headers,
      json: {
        dryRun: false,
        from: "docs",
        plan: {
          articleSources: 0,
          folders: 1,
          grants: 0,
          notes: 0,
          policies: 0,
        },
        to: "Resources/docs",
      },
    });
  });
  await page.goto("/tests/browser/fixtures/home-owner.html");

  const source = rowFor(page, "docs");
  const target = page
    .getByRole("region", { name: "PARA" })
    .locator("li")
    .filter({
      has: page.getByRole("link", { exact: true, name: "Resources" }),
    });

  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await source.dispatchEvent("dragstart", { dataTransfer });
  await target.dispatchEvent("dragover", { dataTransfer });
  await target.dispatchEvent("drop", { dataTransfer });

  await expect.poll(() => moves.length).toBe(1);
  expect(moves[0]).toMatchObject({ destFolderId: "f-resources" });
});

test("a folder under Projects exposes the archive action", async ({ page }) => {
  const archives: unknown[] = [];
  await mockHome(page);
  await page.route("**/api/para/archive", (route) => {
    archives.push(route.request().postDataJSON());
    return route.fulfill({
      headers,
      json: {
        dryRun: false,
        from: "Projects/Experiment",
        plan: {
          articleSources: 0,
          folders: 1,
          grants: 0,
          notes: 0,
          policies: 0,
        },
        to: "Archives/2025-01-Experiment",
      },
    });
  });
  await page.goto("/tests/browser/fixtures/home-owner.html");

  // Folders outside Projects do not get the archive item.
  await page.getByRole("button", { name: "docs の操作" }).click();
  await expect(
    page.getByRole("menuitem", { name: "完了してアーカイブ（PARA）" }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Experiment の操作" }).click();
  await page
    .getByRole("menuitem", { name: "完了してアーカイブ（PARA）" })
    .click();

  await expect.poll(() => archives.length).toBe(1);
  expect(archives[0]).toMatchObject({ dated: true, folderId: "f-exp" });
});
