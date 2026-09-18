import { expect, test } from "@playwright/test";

test("real Worker establishes a browser session through DEV_AUTH", async ({
  page,
  context,
  baseURL,
}) => {
  const outside: string[] = [];
  await context.route("**/*", async (route) => {
    if (new URL(route.request().url()).origin === baseURL) {
      await route.continue();
    } else {
      // Production's optional font stylesheet is deliberately offline here.
      if (new URL(route.request().url()).hostname !== "fonts.googleapis.com") {
        outside.push(route.request().url());
      }
      await route.abort();
    }
  });
  expect(await (await context.request.get("/api/health")).json()).toEqual({
    ok: true,
  });
  expect(await (await context.request.get("/api/me")).json()).toEqual({
    user: null,
  });
  expect(
    (await context.request.post("/api/notes", { data: {} })).status(),
  ).toBe(401);
  expect(await (await context.request.get("/api/auth/config")).json()).toEqual({
    access: false,
    mock: true,
  });

  const established = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/auth/establish" &&
      response.request().method() === "POST",
  );
  await page.goto("/auth/login?email=worker-acceptance%40example.test");
  expect((await established).status()).toBe(302);
  await page.waitForURL(`${baseURL}/`);
  const { user } = await (await context.request.get("/api/me")).json();
  expect(user.email).toBe("worker-acceptance@example.test");
  expect(user.id).toEqual(expect.any(String));
  expect(
    (await context.cookies()).find(
      (cookie) => cookie.name === "miyulabmd_session",
    ),
  ).toMatchObject({ httpOnly: true, path: "/", sameSite: "Lax" });
  expect(outside).toEqual([]);
});

test("private note crosses real D1, R2, Durable Object, API and production SSR", async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  await context.route("**/*", (route) =>
    new URL(route.request().url()).origin === baseURL
      ? route.continue()
      : route.abort(),
  );
  await page.goto("/auth/login?email=worker-note%40example.test");
  await page.waitForURL(`${baseURL}/`);
  const markdown = "# Real Worker acceptance\n\nPRIVATE_WORKER_SSR_BODY";
  const created = await context.request.post("/api/notes", {
    data: { markdown, permission: "private" },
  });
  expect(created.status()).toBe(201);
  const note = await created.json();
  const read = await context.request.get(`/api/notes/${note.id}`);
  expect(read.status()).toBe(200);
  expect(await read.json()).toMatchObject({ id: note.id, markdown });
  const staleTask = await context.request.patch(
    `/api/notes/${note.id}/task-checkbox`,
    {
      data: { checked: true, contextHash: "0".repeat(64), line: 1 },
    },
  );
  expect(staleTask.status(), await staleTask.text()).toBe(409);

  // A byte-for-byte upload/read proves this is a real local R2 binding.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    "base64",
  );
  const upload = await context.request.post(`/api/notes/${note.id}/images`, {
    data: png,
    headers: { "Content-Type": "image/png" },
  });
  expect(upload.status()).toBe(201);
  const image = await upload.json();
  const downloaded = await context.request.get(image.url);
  expect(downloaded.status()).toBe(200);
  expect(await downloaded.body()).toEqual(png);

  // No-JS browser verifies actual SSR, not React rendering or a fixture header.
  const ssrContext = await browser.newContext({
    baseURL,
    javaScriptEnabled: false,
    serviceWorkers: "block",
    storageState: await context.storageState(),
  });
  try {
    await ssrContext.route("**/*", (route) =>
      new URL(route.request().url()).origin === baseURL
        ? route.continue()
        : route.abort(),
    );
    const ssrPage = await ssrContext.newPage();
    const response = await ssrPage.goto(`/n/${note.shortId}`);
    expect(response?.status()).toBe(200);
    expect(response?.headers()["cache-control"]).toBe("private, no-store");
    expect(response?.headers()["x-pwa-ssr-fixture"]).toBeUndefined();
    await expect(ssrPage.locator("#ssr-preview")).toContainText(
      "PRIVATE_WORKER_SSR_BODY",
    );
    expect(
      JSON.parse(
        (await ssrPage.locator("#note-bootstrap").textContent()) ?? "",
      ),
    ).toMatchObject({ id: note.id, markdown });
    await expect(ssrPage).toHaveTitle("Real Worker acceptance · MiyulabMD");
  } finally {
    await ssrContext.close();
  }

  const asset = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.startsWith("/assets/") &&
      response.url().endsWith(".js") &&
      response.status() === 200,
  );
  await page.goto(`/n/${note.shortId}`);
  expect((await asset).fromServiceWorker()).toBe(false);
  await expect(
    page.getByRole("link", { exact: true, name: "MiyulabMD ホーム" }),
  ).toBeVisible();
  // The Worker authenticates the websocket and forwards it to DocumentRoom.
  expect(
    await page.evaluate(
      (id) =>
        new Promise<string>((resolve, reject) => {
          const socket = new WebSocket(
            `${location.origin.replace("http", "ws")}/ws/notes/${id}`,
          );
          // Yjs sync step 1 with an empty state vector; server replies with step 2.
          socket.onopen = () => socket.send(new Uint8Array([0, 0, 1, 0]));
          const timer = setTimeout(() => {
            socket.close();
            reject(
              new Error("DocumentRoom did not send its initial sync frame"),
            );
          }, 10_000);
          socket.onmessage = () => {
            clearTimeout(timer);
            socket.close();
            resolve("sync");
          };
          socket.onerror = () => {
            clearTimeout(timer);
            reject(new Error("DocumentRoom websocket failed"));
          };
        }),
      note.id,
    ),
  ).toBe("sync");

  await context.request.get("/auth/logout");
  expect(await (await context.request.get("/api/me")).json()).toEqual({
    user: null,
  });
  expect((await context.request.get(`/api/notes/${note.id}`)).status()).toBe(
    401,
  );
  expect((await context.request.get(image.url)).status()).toBe(401);
  const guestHtml = await (
    await context.request.get(`/n/${note.shortId}`)
  ).text();
  expect(guestHtml).not.toContain("PRIVATE_WORKER_SSR_BODY");
});
