import { expect, test } from "@playwright/test";

test("storage retention requests never block authenticated acquisition", async ({
  page,
}) => {
  await page.goto("/tests/browser/fixtures/storage.html");
  const requestStarted = Promise.withResolvers<void>();
  await page.route("**/api/folders/tree", async (route) => {
    requestStarted.resolve();
    await route.fulfill({
      headers: { "X-MiyulabMD-Session-User": "user:alice" },
      json: { error: "Unauthorized" },
      status: 401,
    });
  });
  await page.evaluate(async () => {
    let persistCalls = 0;
    let estimateCalls = 0;
    Object.defineProperties(navigator.storage, {
      estimate: {
        configurable: true,
        value: () => {
          estimateCalls += 1;
          return Promise.resolve({ quota: 1, usage: 1 });
        },
      },
      persist: {
        configurable: true,
        value: () => {
          persistCalls += 1;
          return new Promise<boolean>(() => undefined);
        },
      },
    });
    const url = "/src/lib/mydrive-prefetch-coordinator.ts";
    const { attachMyDrivePrefetchCoordinator } = await import(url);
    const coordinator = attachMyDrivePrefetchCoordinator({
      cacheViewerId: "alice",
      mode: "authenticated",
      user: { displayName: "Alice", email: "alice@example.test", id: "alice" },
    });
    Object.assign(window, {
      retentionProbe: () => {
        coordinator.dispose();
        return { estimateCalls, persistCalls };
      },
    });
  });
  await requestStarted.promise;
  const counts = await page.evaluate(() => {
    const probe = (
      window as unknown as {
        retentionProbe: () => { estimateCalls: number; persistCalls: number };
      }
    ).retentionProbe;
    return probe();
  });
  expect(counts).toEqual({ estimateCalls: 1, persistCalls: 1 });
});

for (const mode of ["missing", "rejected", "denied"] as const) {
  test(`storage ${mode} remains best effort without repeated retention prompts`, async ({
    page,
  }) => {
    await page.goto("/tests/browser/fixtures/storage.html");
    const result = await page.evaluate(async (behavior) => {
      let calls = 0;
      Object.defineProperties(navigator.storage, {
        estimate: {
          configurable: true,
          value:
            behavior === "missing"
              ? undefined
              : () => Promise.reject(new Error("Storage unavailable")),
        },
        persist: {
          configurable: true,
          value:
            behavior === "missing"
              ? undefined
              : () => {
                  calls += 1;
                  return behavior === "denied"
                    ? Promise.resolve(false)
                    : Promise.reject(new Error("Storage unavailable"));
                },
        },
      });
      const url = "/src/lib/offline-storage-retention.ts";
      const { requestOfflineStoragePersistence, estimateOfflineStorage } =
        await import(url);
      const first = await requestOfflineStoragePersistence();
      const second = await requestOfflineStoragePersistence();
      return {
        calls,
        estimate: await estimateOfflineStorage(),
        first,
        second,
      };
    }, mode);
    expect(result).toEqual({
      calls: mode === "missing" ? 0 : 1,
      estimate: null,
      first: mode === "denied" ? false : undefined,
      second: mode === "denied" ? false : undefined,
    });
  });
}

test("storage estimates are approximate snapshots and invalid values are unknown", async ({
  page,
}) => {
  await page.goto("/tests/browser/fixtures/storage.html");
  const result = await page.evaluate(async () => {
    let estimate = { quota: 10, usage: 12 };
    Object.defineProperty(navigator.storage, "estimate", {
      configurable: true,
      value: () => Promise.resolve(estimate),
    });
    const url = "/src/lib/offline-storage-retention.ts";
    const { estimateOfflineStorage, getOfflineStorageEstimate } = await import(
      url
    );
    await estimateOfflineStorage();
    const snapshot = getOfflineStorageEstimate();
    snapshot.usage = 0;
    const unchanged = getOfflineStorageEstimate();
    estimate = { quota: Number.NaN, usage: -1 };
    const invalid = await estimateOfflineStorage();
    return { invalid, unchanged };
  });
  expect(result).toEqual({
    invalid: null,
    unchanged: { available: 0, quota: 10, usage: 12 },
  });
});
