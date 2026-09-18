import assert from "node:assert/strict";
import { test } from "node:test";
import { handleAuthRequest } from "../routes/auth.ts";
import { sessionCookieHeader } from "./session.ts";

const env = {
  ACCESS_AUD: "test-audience",
  ACCESS_TEAM_DOMAIN: "logout-test.cloudflareaccess.com",
  SESSION_SECRET: "logout-test-secret-not-a-production-credential",
} as Env;

test("logout preparation reports the incoming verified actor without following Access", async () => {
  const cookie = await sessionCookieHeader(
    { displayName: "Bob", email: "bob@example.test", id: "bob" },
    env,
  );
  const response = await handleAuthRequest(
    new Request("https://notes.test/auth/logout", {
      headers: { Cookie: cookie, "X-MiyulabMD-Logout": "prepare" },
      method: "POST",
    }),
    env,
  );
  assert.equal(response?.status, 200);
  assert.equal(response.headers.get("X-MiyulabMD-Session-User"), "user:bob");
  assert.match(response.headers.get("Set-Cookie") ?? "", /Max-Age=0/);
  assert.equal(response.headers.get("Location"), null);
  assert.deepEqual(await response.json(), { ok: true });
});

test("native GET and ordinary POST keep Access redirects and cookie deletion", async () => {
  for (const method of ["GET", "POST"]) {
    const response = await handleAuthRequest(
      new Request("https://notes.test/auth/logout", { method }),
      env,
    );
    assert.equal(response?.status, 302);
    assert.equal(
      response.headers.get("Location"),
      "https://logout-test.cloudflareaccess.com/cdn-cgi/access/logout?returnTo=https%3A%2F%2Fnotes.test%2F",
    );
    assert.match(response.headers.get("Set-Cookie") ?? "", /Max-Age=0/);
  }
});
