import { expect, test } from "@playwright/test";
import { note } from "./fixtures/note.ts";

test("durable device epoch rejects stale Alice and Bob handles when BroadcastChannel is missed", async ({
  page,
  context,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(globalThis, "BroadcastChannel", { value: undefined }),
  );
  await page.goto("/tests/browser/fixtures/storage.html");
  const other = await context.newPage();
  await other.addInitScript(() =>
    Object.defineProperty(globalThis, "BroadcastChannel", { value: undefined }),
  );
  await other.goto("/tests/browser/fixtures/storage.html");
  try {
    await other.evaluate(async (source) => {
      const { openOfflineCache } = await import("/src/lib/offline-cache.ts");
      const alice = await openOfflineCache({ userId: "manual-tab-alice-7" });
      const bob = await openOfflineCache({ userId: "manual-tab-bob-7" });
      await alice.putNote({
        ...source,
        id: "manual-tab-note-a-7",
        ownerId: "manual-tab-alice-7",
      });
      await bob.putNote({
        ...source,
        id: "manual-tab-note-b-7",
        ownerId: "manual-tab-bob-7",
      });
      Object.assign(window, { alice, bob });
    }, note);
    await page.evaluate(async () => {
      const { clearOfflineCacheDevice } = await import(
        "/src/lib/offline-cache.ts"
      );
      await clearOfflineCacheDevice();
    });
    const stale = await other.evaluate(async (source) => {
      const fixture = window as typeof window & {
        alice: {
          getNote(id: string): Promise<unknown>;
          putNote(n: unknown): Promise<void>;
          close(): void;
        };
        bob: {
          putNote(n: unknown): Promise<void>;
          close(): void;
        };
      };
      // The durable purge generation fences writes even when the
      // BroadcastChannel lifecycle message was missed.
      const alice = await fixture.alice
        .putNote({ ...source, id: "manual-tab-late-a-7" })
        .then(
          () => false,
          () => true,
        );
      const bob = await fixture.bob
        .putNote({ ...source, id: "manual-tab-late-b-7" })
        .then(
          () => false,
          () => true,
        );
      // The pre-purge handle cannot resurrect purged data: the record was
      // deleted, so the stale handle's read is a miss.
      const reopened = await fixture.alice.getNote("manual-tab-note-a-7");
      return { alice, bob, reopened };
    }, note);
    const fresh = await page.evaluate(async (source) => {
      const { openOfflineCache } = await import("/src/lib/offline-cache.ts");
      const cache = await openOfflineCache({ userId: "manual-tab-alice-7" });
      try {
        await cache.putNote({ ...source, id: "manual-tab-fresh-7" });
        return (await cache.getNote("manual-tab-fresh-7"))?.note.id;
      } finally {
        cache.close();
      }
    }, note);
    expect(stale).toEqual({
      alice: true,
      bob: true,
      reopened: null,
    });
    expect(fresh).toBe("manual-tab-fresh-7");
  } finally {
    await other.close();
  }
});
