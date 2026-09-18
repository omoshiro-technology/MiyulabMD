import { expect, test } from "@playwright/test";

test.use({ serviceWorkers: "allow" });

test("a real private attachment survives offline production reload from OPFS", async ({
  page,
  context,
  baseURL,
}) => {
  await context.route("**/*", (route) =>
    new URL(route.request().url()).origin === baseURL
      ? route.continue()
      : route.abort(),
  );
  // The online view warms a collaboration session in preview; hold the
  // handshake open without a sync reply so the note stays unsynced and the
  // offline reload exercises the read-only path this test covers.
  await page.routeWebSocket("**/ws/notes/**", (socket) => {
    socket.onMessage(() => {
      // Keep the handshake open without a sync reply.
    });
  });
  await page.addInitScript(() => {
    Object.assign(window, { committedImages: 0 });
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, ...args) {
      const request = originalPut.call(this, value, ...args);
      const record = value as { key?: string; value?: string };
      if (this.name === "metadata" && record.key?.startsWith("image:")) {
        try {
          if (JSON.parse(record.value ?? "{}").fileName) {
            this.transaction.addEventListener(
              "complete",
              () => {
                const observed = window as unknown as {
                  committedImages: number;
                };
                observed.committedImages += 1;
              },
              { once: true },
            );
          }
        } catch {
          // Denial markers are not committed image references.
        }
      }
      return request;
    };
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await page.goto("/auth/login?email=worker-image%40example.test");
  await page.waitForURL(`${baseURL}/`);
  const parentResponse = await context.request.post("/api/notes", {
    data: { markdown: "# Private image parent", permission: "private" },
  });
  expect(parentResponse.status()).toBe(201);
  const parent = await parentResponse.json();
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    "base64",
  );
  const upload = await context.request.post(`/api/notes/${parent.id}/images`, {
    data: png,
    headers: { "Content-Type": "image/png" },
  });
  expect(upload.status()).toBe(201);
  const attachment = await upload.json();
  const created = await context.request.post("/api/notes", {
    data: {
      markdown: `# Private attached note\n\nPrivate image body.\n\n![App attachment](${attachment.url})`,
      permission: "private",
    },
  });
  expect(created.status()).toBe(201);
  const note = await created.json();
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (await navigator.serviceWorker.getRegistration("/"))?.active?.state,
      ),
    )
    .toBe("activated");
  await page.goto(`/n/${note.id}`);
  const image = page.getByRole("img", { name: "App attachment" });
  const imageWidth = () =>
    image.evaluate((element: HTMLImageElement) => element.naturalWidth);
  await expect(
    page.getByText("Private image body.", { exact: true }),
  ).toBeVisible();
  await expect(image).toHaveAttribute("src", /^blob:/);
  await expect.poll(imageWidth).toBe(1);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { committedImages: number }).committedImages,
      ),
    )
    .toBeGreaterThan(0);
  await expect
    .poll(() =>
      page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
    )
    .toBe(true);
  const { frameTree } = await cdp.send("Page.getFrameTree");
  const previousLoader = frameTree.frame.loaderId as string;
  const noteRequests: { loaderId: string; url: string }[] = [];
  const sockets: string[] = [];
  cdp.on("Network.requestWillBeSent", (event) => {
    if (new URL(event.request.url).pathname.startsWith("/api/notes")) {
      noteRequests.push({ loaderId: event.loaderId, url: event.request.url });
    }
  });
  page.on("websocket", (socket) => sockets.push(socket.url()));
  await context.setOffline(true);
  const response = await page.reload({ waitUntil: "domcontentloaded" });
  expect(response?.fromServiceWorker()).toBe(true);
  expect(await response?.text()).not.toContain("Private image body.");
  await expect(
    page.getByText("Private image body.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "オフライン" })).toBeVisible();
  await expect(image).toHaveAttribute("src", /^blob:/);
  await expect.poll(imageWidth).toBe(1);
  await expect(
    page.getByRole("button", { exact: true, name: "Edit" }),
  ).toHaveCount(0);
  // An already-running online cycle may finish/abort while the old document
  // unloads. The offline document itself must not request note/image APIs.
  const reloadRequests = noteRequests.filter(
    (request) => request.loaderId !== previousLoader,
  );
  expect(reloadRequests).toEqual([]);
  console.log("Image request document ownership", {
    offlineDocument: reloadRequests.length,
    previousDocument: noteRequests.length - reloadRequests.length,
  });
  expect(sockets).toEqual([]);
});
