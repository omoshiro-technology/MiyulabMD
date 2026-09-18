import { expect, test } from "@playwright/test";

test("private history, token, and source callers reject a mismatched cookie actor", async ({
  page,
}) => {
  await page.goto("/tests/browser/fixtures/storage.html");
  const result = await page.evaluate(async () => {
    const { fetchArticleSources, fetchNoteHistory, fetchTokens } = await import(
      "/src/lib/api.ts"
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ events: [], sources: [], tokens: [] }), {
        headers: { "X-MiyulabMD-Session-User": "user:bob" },
      });
    try {
      return await Promise.all(
        [
          fetchNoteHistory("note", {}, { viewerId: "alice" }),
          fetchTokens({ viewerId: "alice" }),
          fetchArticleSources({ viewerId: "alice" }),
        ].map((request) =>
          request.then(
            () => "published",
            (error: Error) => error.name,
          ),
        ),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
  expect(result).toEqual([
    "ApiIdentityError",
    "ApiIdentityError",
    "ApiIdentityError",
  ]);
});
