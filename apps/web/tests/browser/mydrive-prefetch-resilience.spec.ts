import { expect, type Route, test } from "@playwright/test";
import { note } from "./fixtures/note.ts";

const headers = { "X-MiyulabMD-Session-User": "user:alice" };

for (const failure of ["network", "server"] as const) {
  test(`prefetch spaces bounded ${failure} retries and continues independent notes`, async ({
    page,
  }) => {
    const requests: { id: string; at: number }[] = [];
    const rootId = "alice-root";
    const notes = ["failed", "independent"].map((id) => ({
      ...note,
      folderId: rootId,
      id,
      shortId: id,
    }));
    await page.route("**/api/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/folders/tree") {
        return route.fulfill({
          headers,
          json: {
            folders: [{ id: rootId, name: "MyDrive", parentId: null }],
          },
        });
      }
      if (path === `/api/folders/${rootId}`) {
        return route.fulfill({
          headers,
          json: {
            ...note.access,
            children: [],
            crumbs: [],
            id: rootId,
            name: "MyDrive",
            parentId: null,
          },
        });
      }
      if (path === "/api/notes") {
        return route.fulfill({ headers, json: { notes } });
      }
      const id = path.split("/").pop() ?? "";
      requests.push({ at: Date.now(), id });
      if (id === "failed") {
        return failure === "network"
          ? route.abort("internetdisconnected")
          : route.fulfill({
              headers,
              json: { error: "Transient" },
              status: 503,
            });
      }
      return route.fulfill({ headers, json: notes[1] });
    });
    await page.goto("/tests/browser/fixtures/storage.html");
    const result = await page.evaluate(async () => {
      const url = "/src/lib/mydrive-prefetch.ts";
      const { prefetchMyDrive } = await import(url);
      return prefetchMyDrive({
        cacheViewerId: "alice",
        mode: "authenticated",
        user: { displayName: "Alice", email: "a@example.test", id: "alice" },
      });
    });
    expect(requests.map(({ id }) => id)).toEqual([
      "failed",
      "failed",
      "independent",
    ]);
    expect(requests[1].at - requests[0].at).toBeGreaterThanOrEqual(450);
    expect(result).toEqual({
      folders: 1,
      notes: 1,
      reason: "network",
      status: "stopped",
    });
  });
}

for (const scenario of [
  "recover",
  "circuit",
  "abort-delay",
  "auth",
  "quota",
  "malformed",
  "rebuild",
  "cooldown",
] as const) {
  test(`prefetch resilience: ${scenario}`, async ({ page }) => {
    const rootId = "alice-root";
    const notes = ["first", "second", "third", "new"].map((id) => ({
      ...note,
      folderId: rootId,
      id,
      shortId: id,
    }));
    const bodies: string[] = [];
    let cycles = 0;
    let nextCycle = false;
    const bodyResponse = (route: Route, id: string) => {
      bodies.push(id);
      if (scenario === "malformed") {
        return route.fulfill({
          body: "{",
          contentType: "application/json",
          headers,
        });
      }
      if (id === "first") {
        return route.fulfill({ headers, json: notes[0] });
      }
      if (scenario === "auth") {
        return route.fulfill({
          headers,
          json: { error: "Expired" },
          status: 401,
        });
      }
      const firstSecondRequest =
        id === "second" && bodies.filter((body) => body === id).length === 1;
      const transient =
        scenario === "circuit" ||
        scenario === "abort-delay" ||
        (scenario === "rebuild" && !nextCycle) ||
        (scenario === "recover" && firstSecondRequest);
      if (transient) {
        return route.fulfill({ headers, json: { error: "Down" }, status: 503 });
      }
      return route.fulfill({
        headers,
        json: notes.find((item) => item.id === id),
      });
    };
    await page.route("**/api/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/folders/tree") {
        cycles += 1;
        if (scenario === "cooldown") {
          return route.fulfill({
            headers,
            json: { error: "Down" },
            status: 503,
          });
        }
        return route.fulfill({
          headers,
          json: {
            folders: [{ id: rootId, name: "MyDrive", parentId: null }],
          },
        });
      }
      if (path === `/api/folders/${rootId}`) {
        return route.fulfill({
          headers,
          json: {
            ...note.access,
            children: [],
            crumbs: [],
            id: rootId,
            name: "MyDrive",
            parentId: null,
          },
        });
      }
      if (path === "/api/notes") {
        return route.fulfill({
          headers,
          json: { notes: nextCycle ? [notes[0], notes[3]] : notes.slice(0, 3) },
        });
      }
      return bodyResponse(route, path.split("/").pop() ?? "");
    });
    await page.goto("/tests/browser/fixtures/storage.html");
    if (scenario === "cooldown") {
      await page.clock.install();
    }
    if (scenario === "abort-delay") {
      await page.clock.install({ time: new Date("2025-01-01T00:00:00Z") });
      await page.clock.pauseAt(new Date("2025-01-01T00:00:01Z"));
    }
    const start = () =>
      page.evaluate(async (scenario) => {
        const url = "/src/lib/mydrive-prefetch.ts";
        const { prefetchMyDrive } = await import(url);
        const viewer = {
          cacheViewerId: "alice",
          mode: "authenticated",
          user: { displayName: "Alice", email: "a@example.test", id: "alice" },
        };
        const controller = new AbortController();
        Object.assign(window, {
          abortPrefetch: () => controller.abort("stop"),
        });
        if (scenario === "cooldown") {
          const coordinatorUrl = "/src/lib/mydrive-prefetch-coordinator.ts";
          const { attachMyDrivePrefetchCoordinator } = await import(
            coordinatorUrl
          );
          const coordinator = attachMyDrivePrefetchCoordinator(viewer);
          Object.assign(window, { disposePrefetch: coordinator.dispose });
          return null;
        }
        const originalPut = IDBObjectStore.prototype.put;
        if (scenario === "quota") {
          IDBObjectStore.prototype.put = function (...args) {
            if (this.name === "notes") {
              throw new DOMException("No room", "QuotaExceededError");
            }
            return originalPut.apply(this, args);
          };
        }
        try {
          return await prefetchMyDrive(viewer, { signal: controller.signal });
        } finally {
          IDBObjectStore.prototype.put = originalPut;
        }
      }, scenario);
    const failedBody =
      scenario === "abort-delay"
        ? page.waitForResponse(
            (response) =>
              new URL(response.url()).pathname === "/api/notes/second" &&
              response.status() === 503,
          )
        : null;
    const pending = start();
    if (scenario === "abort-delay") {
      await (await failedBody)?.finished();
      // Control browser time, not Node's polling latency: the retry cannot
      // elapse while the test driver is busy or the machine is under load.
      await page.clock.runFor(50);
      await page.evaluate(() => {
        (window as unknown as { abortPrefetch: () => void }).abortPrefetch();
      });
    }
    const result = await pending;
    if (scenario === "abort-delay") {
      await page.clock.runFor(1000);
    }
    if (scenario === "cooldown") {
      await expect.poll(() => cycles).toBe(2);
      await page.waitForTimeout(100);
      for (let i = 0; i < 5; i += 1) {
        await page.evaluate(() => window.dispatchEvent(new Event("online")));
        await page.waitForTimeout(300);
      }
      expect(cycles).toBe(2);
      await page.clock.fastForward(30_000);
      await expect.poll(() => cycles).toBe(4);
      await page.evaluate(() => {
        (
          window as unknown as { disposePrefetch: () => void }
        ).disposePrefetch();
      });
      return;
    }
    const expected = {
      "abort-delay": {
        bodies: ["first", "second"],
        notes: 1,
        reason: "aborted",
      },
      auth: { bodies: ["first", "second"], notes: 1, reason: "auth" },
      circuit: {
        bodies: ["first", "second", "second", "third", "third"],
        notes: 1,
        reason: "network",
      },
      malformed: { bodies: ["first"], notes: 0, reason: "network" },
      quota: { bodies: ["first"], notes: 0, reason: "storage" },
      rebuild: {
        bodies: ["first", "second", "second", "third", "third"],
        notes: 1,
        reason: "network",
      },
      recover: {
        bodies: ["first", "second", "second", "third"],
        notes: 3,
        reason: null,
      },
    }[scenario];
    expect(bodies).toEqual(expected.bodies);
    expect(result).toEqual({
      folders: 1,
      notes: expected.notes,
      ...(expected.reason
        ? { reason: expected.reason, status: "stopped" }
        : { status: "success" }),
    });
    const savedFirst = await page.evaluate(async () => {
      const url = "/src/lib/offline-cache.ts";
      const { openOfflineCache } = await import(url);
      const cache = await openOfflineCache({ userId: "alice" });
      try {
        return (await cache.getNote("first"))?.note.markdown ?? null;
      } finally {
        cache.close();
      }
    });
    expect(savedFirst).toBe(expected.notes > 0 ? note.markdown : null);
    if (scenario === "rebuild") {
      nextCycle = true;
      expect(await start()).toEqual({
        folders: 1,
        notes: 1,
        status: "success",
      });
      expect(bodies).toEqual([...expected.bodies, "new"]);
    }
  });
}
