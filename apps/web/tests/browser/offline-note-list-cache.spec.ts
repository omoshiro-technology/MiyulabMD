import type { NoteSummary } from "@miyulabmd/shared";
import { expect, test } from "@playwright/test";

type CachedNoteList = { notes: NoteSummary[]; cachedAt: number };
type CacheFixture = Window & {
  listCache: {
    getNoteList(): Promise<CachedNoteList | null>;
    getNote(id: string): Promise<unknown>;
  };
};

const summary: NoteSummary = {
  access: {
    effectiveReadScope: "self",
    effectiveWriteScope: "self",
    flags: { canAdmin: true, canEdit: true, canView: true },
    grants: [],
    inherit: true,
    readScope: null,
    source: "default",
    sourceFolder: null,
    writeScope: null,
  },
  alias: null,
  articleMeta: {},
  createdAt: 1,
  folder: "資料",
  folderId: "docs",
  id: "note-in-docs",
  ownerId: "alice",
  permission: "private",
  shortId: "short-docs",
  title: "資料内のノート",
  updatedAt: 2,
};

test("a cached note list survives reload without requiring cached note bodies", async ({
  page,
  context,
}) => {
  const moduleUrl = "/src/lib/offline-cache.ts";
  const notes: NoteSummary[] = [
    summary,
    {
      ...summary,
      folder: "資料/議事録",
      folderId: "meetings",
      id: "meeting-note",
      shortId: "short-meeting",
      title: "議事録",
    },
  ];
  const startedAt = Date.now();
  await page.goto("/tests/browser/fixtures/storage.html");
  const before = await page.evaluate(
    async ({ moduleUrl, notes }) => {
      const { openOfflineCache } = await import(moduleUrl);
      const cache = await openOfflineCache({ userId: "alice" });
      try {
        const before = await cache.getNoteList();
        await cache.putNoteList(notes);
        return before;
      } finally {
        cache.close();
      }
    },
    { moduleUrl, notes },
  );
  expect(before).toBeNull();

  await page.reload();
  await page.evaluate(async (moduleUrl) => {
    const { openOfflineCache } = await import(moduleUrl);
    Object.assign(window, {
      listCache: await openOfflineCache({ userId: "alice" }),
    });
  }, moduleUrl);
  await context.setOffline(true);

  const result = await page.evaluate(async (id) => {
    const cache = (window as CacheFixture).listCache;
    return {
      body: await cache.getNote(id),
      list: await cache.getNoteList(),
    };
  }, summary.id);
  expect(result.list?.notes).toEqual(notes);
  expect(result.list?.cachedAt).toBeGreaterThanOrEqual(startedAt);
  expect(result.list?.cachedAt).toBeLessThanOrEqual(Date.now());
  expect(result.body).toBeNull();
});
