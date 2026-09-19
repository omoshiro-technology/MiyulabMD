import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fetchOgTarget,
  isBlockedHost,
  isBlockedOgUrl,
  OG_TARGET_HEADER,
  OG_USER_AGENT,
  parseOgTargetUrl,
} from "../og-fetch-shared.ts";
import { fetchOgPreview, ogCacheKey, parseOgHtml } from "./og.ts";

test("parseOgHtml reads Open Graph tags from head", () => {
  const html = `<!doctype html><html><head>
    <meta property="og:title" content="Hello &amp; Co">
    <meta name="description" content="A page">
    <meta property="og:image" content="/card.png">
    <meta property="og:site_name" content="Example">
    <title>Fallback</title>
  </head><body>${"x".repeat(200)}</body></html>`;
  const card = parseOgHtml(html, "https://example.com/post");
  assert.equal(card.title, "Hello & Co");
  assert.equal(card.description, "A page");
  assert.equal(card.image, "https://example.com/card.png");
  assert.equal(card.siteName, "Example");
});

test("parseOgHtml decodes query entities in og:image", () => {
  const html = `<!doctype html><html><head>
    <meta property="og:title" content="Build">
    <meta property="og:image" content="https://example.com/ogp?name=a&amp;characters=1,2">
  </head></html>`;
  const card = parseOgHtml(html, "https://example.com/build");
  assert.equal(card.image, "https://example.com/ogp?name=a&characters=1,2");
});

test("fetchOgPreview sends a User-Agent", async () => {
  const original = globalThis.fetch;
  let userAgent = "";
  globalThis.fetch = (_input, init) => {
    userAgent = new Headers(init?.headers).get("user-agent") ?? "";
    return new Response("<html><head><title>Example</title></head></html>", {
      status: 200,
    });
  };
  try {
    const result = await fetchOgPreview("https://example.com/");
    assert.ok(!("error" in result));
    assert.equal(userAgent, OG_USER_AGENT);
  } finally {
    globalThis.fetch = original;
  }
});

test("parseOgTargetUrl reads x-og-target and rejects workers.dev", () => {
  const ok = parseOgTargetUrl(
    new Request("https://og-fetch.workers.dev/", {
      headers: { [OG_TARGET_HEADER]: "https://stellasora-tools.miyulab.dev/" },
    }),
  );
  assert.equal(ok?.toString(), "https://stellasora-tools.miyulab.dev/");
  assert.equal(
    parseOgTargetUrl(
      new Request("https://og-fetch.workers.dev/", {
        headers: { [OG_TARGET_HEADER]: "https://miyulabmd.workers.dev/" },
      }),
    ),
    null,
  );
  assert.equal(parseOgTargetUrl(new Request("https://example.com/")), null);
});

test("isBlockedHost covers loopback aliases and IPv6", () => {
  assert.equal(isBlockedHost("127.0.0.1"), true);
  assert.equal(isBlockedHost("127.0.0.2"), true);
  assert.equal(isBlockedHost("127.1"), true);
  assert.equal(isBlockedHost("0.0.0.0"), true);
  assert.equal(isBlockedHost("0"), true);
  assert.equal(isBlockedHost("::1"), true);
  assert.equal(isBlockedHost("[::1]"), true);
  assert.equal(isBlockedHost("::ffff:127.0.0.1"), true);
  assert.equal(isBlockedHost("::ffff:7f00:1"), true);
  assert.equal(isBlockedHost("[::ffff:7f00:1]"), true);
  assert.equal(isBlockedHost("0:0:0:0:0:ffff:7f00:1"), true);
  assert.equal(isBlockedHost("::ffff:a00:1"), true);
  assert.equal(isBlockedHost("::ffff:c0a8:101"), true);
  assert.equal(isBlockedHost("::ffff:ac10:1"), true);
  assert.equal(isBlockedHost("::ffff:a9fe:101"), true);
  assert.equal(isBlockedHost("::ffff:808:808"), false);
  assert.equal(isBlockedHost("0x7f000001"), true);
  assert.equal(isBlockedHost("2130706433"), true);
  assert.equal(isBlockedHost("example.com"), false);
});

test("isBlockedOgUrl rejects URL-canonicalized IPv4-mapped private targets", () => {
  assert.equal(isBlockedOgUrl(new URL("http://[::ffff:127.0.0.1]/")), true);
  assert.equal(isBlockedOgUrl(new URL("http://[::ffff:7f00:1]/")), true);
  assert.equal(isBlockedOgUrl(new URL("http://[::ffff:10.0.0.1]/")), true);
  assert.equal(isBlockedOgUrl(new URL("http://[::ffff:192.168.1.1]/")), true);
  assert.equal(isBlockedOgUrl(new URL("http://[::ffff:172.16.0.1]/")), true);
  assert.equal(isBlockedOgUrl(new URL("http://[::ffff:169.254.1.1]/")), true);
  assert.equal(isBlockedOgUrl(new URL("http://[::ffff:0.0.0.0]/")), true);
  assert.equal(isBlockedOgUrl(new URL("http://[::ffff:0:127.0.0.1]/")), true);
  assert.equal(isBlockedOgUrl(new URL("http://[::ffff:8.8.8.8]/")), false);
  assert.equal(isBlockedOgUrl(new URL("https://example.com/")), false);
  assert.equal(
    parseOgTargetUrl(
      new Request("https://og-fetch.workers.dev/", {
        headers: { [OG_TARGET_HEADER]: "http://[::ffff:127.0.0.1]/" },
      }),
    ),
    null,
  );
});

test("fetchOgTarget does not follow redirects to IPv4-mapped loopback", async () => {
  let fetched = 0;
  const response = await fetchOgTarget(
    new URL("https://example.com/"),
    (input) => {
      fetched += 1;
      const url = String(input);
      if (fetched === 1 && url === "https://example.com/") {
        return Promise.resolve(
          new Response(null, {
            headers: { Location: "http://[::ffff:127.0.0.1]/" },
            status: 302,
          }),
        );
      }
      throw new Error(`must not fetch blocked mapped target: ${url}`);
    },
  );
  assert.equal(fetched, 1);
  assert.equal(response.status, 400);
  assert.equal(await response.text(), "blocked host");
});

test("fetchOgPreview does not follow redirects to blocked hosts", async () => {
  const original = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (_input) => {
    fetched += 1;
    if (fetched === 1) {
      return Promise.resolve(
        new Response(null, {
          headers: { Location: "http://127.0.0.1/" },
          status: 302,
        }),
      );
    }
    throw new Error("must not fetch blocked redirect target");
  };
  try {
    const result = await fetchOgPreview("https://example.com/");
    assert.equal(fetched, 1);
    assert.equal("error" in result, true);
    if ("error" in result) {
      assert.equal(result.status, 400);
    }
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchOgPreview does not fall back when outbound rejects the URL", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("should not use global fetch");
  };
  try {
    const result = await fetchOgPreview("https://example.com/", {
      fetch: async () => new Response("invalid url", { status: 400 }),
    });
    assert.equal("error" in result, true);
    if ("error" in result) {
      assert.equal(result.status, 400);
    }
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchOgPreview prefers the outbound fetcher", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("should not use global fetch");
  };
  try {
    let targetHeader = "";
    const result = await fetchOgPreview("https://example.com/page", {
      fetch: (_input, init) => {
        targetHeader = new Headers(init?.headers).get(OG_TARGET_HEADER) ?? "";
        return new Response(
          `<html><head><meta property="og:title" content="Via outbound"></head></html>`,
          { status: 200 },
        );
      },
    });
    assert.ok(!("error" in result));
    assert.equal(result.title, "Via outbound");
    assert.equal(targetHeader, "https://example.com/page");
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchOgPreview falls back to global fetch when outbound fails", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      `<html><head><meta property="og:title" content="Direct"></head></html>`,
      { status: 200 },
    );
  try {
    const result = await fetchOgPreview("https://example.com/", {
      fetch: async () => new Response("no", { status: 530 }),
    });
    assert.ok(!("error" in result));
    assert.equal(result.title, "Direct");
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchOgTarget does not forward target Set-Cookie headers", async () => {
  const response = await fetchOgTarget(
    new URL("https://example.com/"),
    async () =>
      new Response("<html></html>", {
        headers: {
          "Content-Type": "text/html",
          "Set-Cookie": "secret=1",
        },
        status: 200,
      }),
  );
  assert.equal(response.ok, true);
  assert.equal(response.headers.get("Set-Cookie"), null);
  assert.equal(response.headers.get("Content-Type"), "text/html");
});

test("ogCacheKey normalizes the target URL", () => {
  const key = ogCacheKey("https://md.example", "https://x.com/norotororo");
  assert.ok(key);
  assert.equal(
    new URL(key.url).searchParams.get("url"),
    "https://x.com/norotororo",
  );
});
