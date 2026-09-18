import { expect, test } from "@playwright/test";

type ConfigProbe = Window & {
  authConfigProbe: { requests: number; release: () => void };
};

test.beforeEach(async ({ page }) => {
  await page.route("**/api/article-sources", (route) =>
    route.fulfill({ json: [] }),
  );
});

test("AppShell resolves the viewer independently of auth config and restores cached identity without authentication", async ({
  page,
}) => {
  const user = {
    displayName: "Alice",
    email: "alice@example.test",
    id: "alice",
  };
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/me", (route) => route.fulfill({ json: { user } }));
  await page.route("**/api/auth/config", (route) =>
    route.abort("internetdisconnected"),
  );
  await page.goto("/tests/browser/fixtures/app-shell.html");
  const state = async () =>
    JSON.parse((await page.getByLabel("Viewer context").textContent()) ?? "{}");
  await expect.poll(state).toMatchObject({
    user,
    userLoading: false,
    viewer: { cacheViewerId: "alice", mode: "authenticated", user },
  });

  await page.unroute("**/api/me");
  await page.route("**/api/me", (route) => route.abort("internetdisconnected"));
  await page.reload();
  await expect.poll(state).toMatchObject({
    user: null,
    userLoading: false,
    viewer: { cacheViewerId: "alice", mode: "cached", user: null },
  });
  expect(errors).toEqual([]);
});

test("a replaced AppShell effect cannot overwrite the newer auth config", async ({
  page,
}) => {
  await page.route("**/api/me", (route) =>
    route.fulfill({ json: { user: null } }),
  );
  await page.addInitScript(() => {
    const originalFetch = globalThis.fetch;
    const control: ConfigProbe["authConfigProbe"] = {
      release: () => {
        throw new Error("First config request has not started");
      },
      requests: 0,
    };
    Object.assign(window, { authConfigProbe: control });
    globalThis.fetch = (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.endsWith("/api/auth/config")) {
        return originalFetch(input, init);
      }
      if (++control.requests === 1) {
        return new Promise<Response>((resolve) => {
          control.release = () =>
            resolve(
              new Response(JSON.stringify({ access: false, mock: true })),
            );
        });
      }
      return Promise.resolve(
        new Response(JSON.stringify({ access: true, mock: false })),
      );
    };
  });
  await page.goto("/tests/browser/fixtures/app-shell.html");
  await expect
    .poll(() =>
      page.evaluate(() => (window as ConfigProbe).authConfigProbe.requests),
    )
    .toBe(2);
  await page.getByRole("button", { exact: true, name: "ゲスト" }).click();
  await expect(
    page.getByRole("menuitem", { exact: true, name: "ログイン" }),
  ).toBeVisible();
  await page.evaluate(() => (window as ConfigProbe).authConfigProbe.release());
  // Allow the fulfilled response and React's queued render to reach the DOM.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  await expect(page.getByLabel("ログイン用メールアドレス")).toHaveCount(0);
  await expect(
    page.getByRole("menuitem", { exact: true, name: "ログイン" }),
  ).toBeVisible();
});
