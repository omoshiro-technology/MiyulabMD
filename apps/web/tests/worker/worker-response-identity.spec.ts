import { type APIRequestContext, expect, test } from "@playwright/test";

const header = "x-miyulabmd-session-user";

async function login(request: APIRequestContext, email: string) {
  const html = await (
    await request.get(`/auth/login?email=${encodeURIComponent(email)}`)
  ).text();
  const token = /name="token" value="([^"]+)"/.exec(html)?.[1];
  expect(token).toBeTruthy();
  const established = await request.post("/api/auth/establish", {
    form: { token: token ?? "" },
    maxRedirects: 0,
  });
  expect(established.status()).toBe(302);
  expect(established.headers().location).toBe("/");
  expect(established.headers()[header]).toBe("guest");
  expect(established.headers()["cache-control"]).toBe("private, no-store");
  const { user } = await (await request.get("/api/me")).json();
  return user as { id: string };
}

test("authoritative API response identity follows the verified request cookie", async ({
  request,
  playwright,
  baseURL,
}) => {
  const bobRequest = await playwright.request.newContext({ baseURL });
  try {
    const alice = await login(request, "identity-alice@example.test");
    const bob = await login(bobRequest, "identity-bob@example.test");
    expect(bob.id).not.toBe(alice.id);
    const created = await request.post("/api/notes", {
      data: {
        inheritAccess: false,
        markdown: "# Identity",
        readScope: "public",
        writeScope: "self",
      },
    });
    expect(created.status()).toBe(201);
    const note = await created.json();
    expect(note.access.effectiveReadScope).toBe("public");
    expect(created.headers()[header]).toBe(`user:${alice.id}`);

    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
      "base64",
    );
    const upload = await request.post(`/api/notes/${note.id}/images`, {
      data: png,
      headers: { "Content-Type": "image/png" },
    });
    expect(upload.status()).toBe(201);
    const image = await upload.json();
    // A successful Alice preflight says nothing about the next request's cookie.
    expect((await (await request.get("/api/me")).json()).user.id).toBe(
      alice.id,
    );
    const cookies = (await bobRequest.storageState()).cookies;
    const cookie = cookies
      .map(({ name, value }) => `${name}=${value}`)
      .join("; ");
    for (const [cookieValue, identity] of [
      [cookie, `user:${bob.id}`],
      ["", "guest"],
      ["miyulabmd_session=invalid", "guest"],
      ["miyulabmd_session=%ZZ", "guest"],
    ]) {
      for (const [path, status] of [
        [`/api/notes/${note.id}`, 200],
        ["/api/notes", 200],
        [image.url, 200],
        ["/api/notes/nonexistent-identity-note", 404],
        ["/api/unknown-identity-route", 404],
        ["/api/auth/establish", 405],
      ] as const) {
        const response = await request.get(path, {
          headers: { Cookie: cookieValue, [header]: `user:${alice.id}` },
          maxRedirects: 0,
        });
        expect(response.status(), path).toBe(status);
        expect(response.headers()[header], path).toBe(identity);
        expect(response.headers()["cache-control"], path).toBe(
          "private, no-store",
        );
        if (path === `/api/notes/${note.id}`) {
          expect((await response.json()).ownerId).toBe(alice.id);
        }
        if (path === image.url) {
          expect(await response.body()).toEqual(png);
        }
      }
    }
    const denied = await request.post("/api/notes", {
      data: {},
      headers: { Cookie: "", [header]: `user:${alice.id}` },
    });
    expect(denied.status()).toBe(401);
    expect(denied.headers()[header]).toBe("guest");
    expect(denied.headers()["cache-control"]).toBe("private, no-store");
  } finally {
    await bobRequest.dispose();
  }
});

test("logout preparation clears the real cookie and reports its incoming actor", async ({
  request,
}) => {
  const user = await login(request, "logout-preparation@example.test");
  const prepared = await request.post("/auth/logout", {
    headers: {
      "X-MiyulabMD-Logout": "prepare",
      [header]: "user:spoofed",
    },
    maxRedirects: 0,
  });
  expect(prepared.status()).toBe(200);
  expect(prepared.headers()[header]).toBe(`user:${user.id}`);
  expect(prepared.headers()["cache-control"]).toBe("private, no-store");
  expect(prepared.headers().location).toBeUndefined();
  expect(await prepared.json()).toEqual({ ok: true });
  const after = await request.get("/api/me");
  expect(after.headers()[header]).toBe("guest");
  expect((await after.json()).user).toBeNull();

  const repeated = await request.post("/auth/logout", {
    headers: { "X-MiyulabMD-Logout": "prepare" },
    maxRedirects: 0,
  });
  expect(repeated.status()).toBe(200);
  expect(repeated.headers()[header]).toBe("guest");
  const native = await request.get("/auth/logout", { maxRedirects: 0 });
  expect(native.status()).toBe(302);
  expect(native.headers().location).toBe("/");
});
