import type { SessionUser } from "@miyulabmd/shared";
import { expect, type Route, test } from "@playwright/test";

type ViewerContext = {
  mode: "authenticated" | "guest" | "cached" | "unavailable";
  user: SessionUser | null;
  cacheViewerId: string | null;
  cachedUser?: SessionUser | null;
};
type ContextFixture = Window & {
  resolveViewerContext(): Promise<ViewerContext>;
};

type SwitchFixture = Window & {
  viewerSwitch: {
    controller: AbortController;
    older: Promise<{ context: ViewerContext | null; error: string | null }>;
    resolveViewerContext(): Promise<ViewerContext>;
  };
};

test("restoring the last cached viewer after reload does not authenticate that viewer", async ({
  page,
  context,
}) => {
  const moduleUrl = "/src/lib/viewer-context.ts";
  const user: SessionUser = {
    displayName: "Alice",
    email: "alice@example.test",
    id: "alice",
  };
  await page.route("**/api/me", (route) => route.fulfill({ json: { user } }));
  await page.goto("/tests/browser/fixtures/storage.html");

  const authenticated = await page.evaluate(async (moduleUrl) => {
    const { resolveViewerContext } = await import(moduleUrl);
    return resolveViewerContext();
  }, moduleUrl);
  expect(authenticated).toMatchObject({
    cacheViewerId: user.id,
    mode: "authenticated",
    user,
  });

  await page.reload();
  await page.unroute("**/api/me");
  await page.evaluate(async (moduleUrl) => {
    const { resolveViewerContext } = await import(moduleUrl);
    Object.assign(window, { resolveViewerContext });
  }, moduleUrl);
  await context.setOffline(true);

  const cached = await page.evaluate(() =>
    (window as ContextFixture).resolveViewerContext(),
  );
  expect(cached).toMatchObject({
    cachedUser: {
      displayName: user.displayName,
      email: user.email,
      id: user.id,
    },
    cacheViewerId: user.id,
    mode: "cached",
    user: null,
  });
});

test("a cached viewer cannot mask forbidden or invalid authentication responses", async ({
  page,
}) => {
  const moduleUrl = "/src/lib/viewer-context.ts";
  let response = {
    body: JSON.stringify({
      user: {
        displayName: "Alice",
        email: "alice@example.test",
        id: "alice",
      },
    }),
    contentType: "application/json",
    status: 200,
  };
  await page.route("**/api/me", (route) => route.fulfill(response));
  await page.goto("/tests/browser/fixtures/storage.html");
  const resolve = () =>
    page.evaluate(async (moduleUrl) => {
      const { resolveViewerContext } = await import(moduleUrl);
      try {
        return { context: await resolveViewerContext(), error: null };
      } catch (error) {
        return {
          context: null,
          error: error instanceof Error ? error.name : "UnknownError",
        };
      }
    }, moduleUrl);
  expect((await resolve()).context).toMatchObject({
    cacheViewerId: "alice",
    mode: "authenticated",
  });

  for (const candidate of [
    { body: '{"error":"Forbidden"}', status: 403 },
    { body: '{"error":"Not found"}', status: 404 },
    { body: '{"user":{"id":"unvalidated-user"}}', status: 200 },
  ]) {
    response = { ...response, ...candidate };
    expect((await resolve()).context).toMatchObject({
      cacheViewerId: null,
      mode: "unavailable",
      user: null,
    });
  }
  response = { ...response, body: '{"broken":', status: 200 };
  expect(await resolve()).toEqual({ context: null, error: "SyntaxError" });
});

test("a cancelled old viewer request cannot replace the newer viewer restored after reload", async ({
  page,
  context,
}) => {
  const moduleUrl = "/src/lib/viewer-context.ts";
  const alice: SessionUser = {
    displayName: "Alice",
    email: "alice@example.test",
    id: "alice",
  };
  const bob: SessionUser = {
    displayName: "Bob",
    email: "bob@example.test",
    id: "bob",
  };
  const firstRequest = Promise.withResolvers<Route>();
  let requests = 0;
  await page.route("**/api/me", (route) => {
    requests += 1;
    if (requests === 1) {
      firstRequest.resolve(route);
      return;
    }
    return route.fulfill({ json: { user: bob } });
  });
  await page.goto("/tests/browser/fixtures/storage.html");
  await page.evaluate(async (moduleUrl) => {
    const { resolveViewerContext } = await import(moduleUrl);
    const controller = new AbortController();
    const older = resolveViewerContext({ signal: controller.signal }).then(
      (context: ViewerContext) => ({ context, error: null }),
      (error: unknown) => ({
        context: null,
        error: error instanceof Error ? error.name : "UnknownError",
      }),
    );
    Object.assign(window, {
      viewerSwitch: { controller, older, resolveViewerContext },
    });
  }, moduleUrl);
  const oldRequest = await firstRequest.promise;

  const current = await page.evaluate(() => {
    const state = (window as SwitchFixture).viewerSwitch;
    state.controller.abort();
    return state.resolveViewerContext();
  });
  expect(current).toMatchObject({
    cacheViewerId: bob.id,
    mode: "authenticated",
    user: bob,
  });

  // Deliver the older response only after the new viewer has been confirmed.
  await oldRequest.fulfill({ json: { user: alice } });
  const older = await page.evaluate(
    () => (window as SwitchFixture).viewerSwitch.older,
  );

  await page.reload();
  await page.unroute("**/api/me");
  await page.evaluate(async (moduleUrl) => {
    const { resolveViewerContext } = await import(moduleUrl);
    Object.assign(window, { resolveViewerContext });
  }, moduleUrl);
  await context.setOffline(true);
  const restored = await page.evaluate(() =>
    (window as ContextFixture).resolveViewerContext(),
  );
  expect(restored).toMatchObject({
    cachedUser: {
      displayName: bob.displayName,
      email: bob.email,
      id: bob.id,
    },
    cacheViewerId: bob.id,
    mode: "cached",
    user: null,
  });
  expect(older).toEqual({ context: null, error: "AbortError" });
});

test("cancelling a viewer identity write preserves the previously committed identity", async ({
  page,
}) => {
  await page.goto("/tests/browser/fixtures/storage.html");
  const result = await page.evaluate(async (moduleUrl) => {
    const { persistCachedViewerId, readCachedViewerId } = await import(
      moduleUrl
    );
    await persistCachedViewerId("bob");
    const controller = new AbortController();
    const pending = persistCachedViewerId("alice", {
      signal: controller.signal,
    });
    const outcome = pending.then(
      () => "committed",
      (error: unknown) =>
        error instanceof Error ? error.name : "UnknownError",
    );
    controller.abort();
    return {
      identity: await outcome.then(() => readCachedViewerId()),
      outcome: await outcome,
    };
  }, "/src/lib/offline-cache.ts");
  expect(result).toEqual({ identity: "bob", outcome: "AbortError" });
});
