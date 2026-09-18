import { expect, test } from "@playwright/test";

test("drive notifications respect request boundaries and preserve transport behavior", async ({
  page,
}) => {
  const requests: string[] = [];
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    requests.push(path);
    if (path === "/api/notes/redirect") {
      return route.fulfill({
        // Redirect targets must be served by the real test server: Playwright
        // routing only intercepts the initial request in this redirect chain.
        headers: { Location: "/tests/browser/fixtures/storage.html" },
        status: 303,
      });
    }
    if (path === "/api/notes/abort") {
      return route.abort("internetdisconnected");
    }
    return route.fulfill({
      headers: { "Access-Control-Allow-Origin": "*" },
      json: { ok: true },
      status: path === "/api/notes/failure" ? 500 : 200,
    });
  });
  await page.goto("/tests/browser/fixtures/storage.html");
  const result = await page.evaluate(async () => {
    const apiUrl = "/src/lib/api-fetch.ts";
    const eventsUrl = "/src/lib/drive-changed.ts";
    const accessUrl = "/src/lib/viewing-access.ts";
    const { apiFetch } = await import(apiUrl);
    const { onDriveChanged } = await import(eventsUrl);
    const { bindMutationAccess } = await import(accessUrl);
    let source: "network" | "cache" = "network";
    const unbind = bindMutationAccess(() => ({
      source,
      viewer: { cacheViewerId: null, mode: "guest", user: null },
    }));
    let notifications = 0;
    const unsubscribe = onDriveChanged(() => {
      notifications += 1;
    });
    const base = window.location.href;
    const foreign = new URL("/api/notes", base);
    foreign.hostname = "localhost";
    const cases: {
      label: string;
      input: RequestInfo | URL;
      init?: RequestInit;
    }[] = [
      { input: "/api/notes", label: "GET" },
      { init: { method: "HEAD" }, input: "/api/notes", label: "HEAD" },
      { init: { method: "OPTIONS" }, input: "/api/notes", label: "OPTIONS" },
      {
        init: { method: "GET" },
        input: new Request(new URL("/api/notes", base), { method: "POST" }),
        label: "override read",
      },
      {
        init: { method: "POST" },
        input: new Request(new URL("/api/notes", base)),
        label: "override write",
      },
      {
        init: { method: "PATCH" },
        input: new URL("/api/folders/folder?query=yes", base),
        label: "URL write",
      },
      { init: { method: "DELETE" }, input: "/api/notes/note", label: "delete" },
      {
        init: { method: "POST" },
        input: "/api/notes-extra",
        label: "lookalike",
      },
      { init: { method: "PATCH" }, input: "/api/me", label: "profile" },
      { init: { method: "POST" }, input: foreign, label: "foreign" },
      {
        init: { method: "POST" },
        input: "/api/notes/redirect",
        label: "redirect",
      },
      {
        init: { method: "PATCH" },
        input: "/api/notes/failure",
        label: "failure",
      },
    ];
    const rows: {
      body: string;
      label: string;
      notifications: number;
      redirected: boolean;
      status: number;
    }[] = [];
    try {
      for (const entry of cases) {
        const before = notifications;
        const response = await apiFetch(entry.input, entry.init);
        rows.push({
          body: await response.text(),
          label: entry.label,
          notifications: notifications - before,
          redirected: response.redirected,
          status: response.status,
        });
      }
      const beforeAbort = notifications;
      let aborted = false;
      try {
        await apiFetch("/api/notes/abort", { method: "PATCH" });
      } catch {
        aborted = true;
      }
      const abortNotifications = notifications - beforeAbort;
      source = "cache";
      let synchronousError: string | null = null;
      let pending: Promise<Response> | undefined;
      try {
        pending = apiFetch("/api/notes/denied-by-gate", { method: "POST" });
      } catch (error) {
        synchronousError = error instanceof Error ? error.name : "unknown";
      }
      await pending?.catch(() => undefined);
      return { aborted, abortNotifications, rows, synchronousError };
    } finally {
      unsubscribe();
      unbind();
    }
  });
  expect(result.rows.map(({ notifications }) => notifications)).toEqual([
    0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0,
  ]);
  expect(result.rows.find(({ label }) => label === "URL write")?.body).toBe(
    '{"ok":true}',
  );
  expect(result.rows.find(({ label }) => label === "redirect")).toMatchObject({
    body: expect.stringContaining("Browser storage test fixture"),
    notifications: 0,
    redirected: true,
    status: 200,
  });
  expect(result.aborted).toBe(true);
  expect(result.abortNotifications).toBe(0);
  expect(result.synchronousError).toBe("ReadOnlyViewingError");
  expect(requests).not.toContain("/api/notes/denied-by-gate");
});
