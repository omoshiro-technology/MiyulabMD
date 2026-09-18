import { type BrowserContext, expect, type Page, test } from "@playwright/test";

test.use({ serviceWorkers: "allow" });

async function verifyOfflineNote(
  page: Page,
  context: BrowserContext,
  baseURL: string | undefined,
  route: "canonical" | "short" | "share",
) {
  await context.route("**/*", (route) =>
    new URL(route.request().url()).origin === baseURL
      ? route.continue()
      : route.abort(),
  );
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await page.goto("/auth/login?email=worker-offline%40example.test");
  await page.waitForURL(`${baseURL}/`);
  const created = await context.request.post("/api/notes", {
    data: {
      markdown:
        "# Private offline acceptance\n\nStored private body.\n\n- [ ] Preserve task",
      permission: "private",
    },
  });
  expect(created.status()).toBe(201);
  const note = await created.json();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const registration = await navigator.serviceWorker.getRegistration("/");
        return registration?.active?.state;
      }),
    )
    .toBe("activated");
  // Viewing an editable note warms a collaboration session; hold the
  // handshake open without a sync reply so the synced marker is never set
  // and the cached note stays read-only offline.
  await page.routeWebSocket("**/ws/notes/**", (socket) => {
    socket.onMessage(() => {
      // Keep the handshake open without a sync reply.
    });
  });
  await page.goto(`/n/${note.id}`);
  await expect(
    page.getByText("Stored private body.", { exact: true }),
  ).toBeVisible();
  await expect(page.locator("#ssr-preview")).toHaveCount(0);
  await expect(
    page.getByRole("button", { exact: true, name: "Edit" }),
  ).toBeEnabled();
  await expect
    .poll(() =>
      page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
    )
    .toBe(true);

  if (route !== "canonical") {
    await page.goto(`/${route === "share" ? "s" : "n"}/${note.shortId}`);
    await expect(
      page.getByText("Stored private body.", { exact: true }),
    ).toBeVisible();
    await expect(page.locator("#ssr-preview")).toHaveCount(0);
  }
  const sockets: string[] = [];
  page.on("websocket", (socket) => sockets.push(socket.url()));
  await context.setOffline(true);
  const response = await page.reload({ waitUntil: "domcontentloaded" });
  expect(response?.fromServiceWorker()).toBe(true);
  expect(await response?.text()).not.toContain("Stored private body.");
  await expect(
    page.getByText("Stored private body.", { exact: true }),
  ).toBeVisible();
  // オフライン状態はヘッダーのアイコンが示す。タップで最終同期時刻を表示。
  const offlineButton = page.getByRole("button", { name: "オフライン" });
  await expect(offlineButton).toBeVisible();
  await offlineButton.click();
  await expect(page.getByText(/最終同期/)).toBeVisible();
  await expect(
    page.getByRole("button", { exact: true, name: "Edit" }),
  ).toHaveCount(0);
  await expect(page.getByRole("checkbox")).toBeDisabled();
  expect(sockets).toEqual([]);
}

for (const route of ["canonical", "short", "share"] as const) {
  test(`real private note reloads readonly through ${route} from the production shell while offline`, async ({
    page,
    context,
    baseURL,
  }) => {
    await verifyOfflineNote(page, context, baseURL, route);
  });
}
