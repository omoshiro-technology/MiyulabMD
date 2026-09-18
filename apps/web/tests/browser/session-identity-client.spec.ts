import { expect, test } from "@playwright/test";
import { note } from "./fixtures/note.ts";

test("captured Alice cannot publish Bob's response even when the shared note is owned by Alice", async ({
  page,
}) => {
  await page.goto("/tests/browser/fixtures/storage.html");
  const result = await page.evaluate(async (note) => {
    const apiUrl = "/src/lib/api.ts";
    const { fetchNote } = await import(apiUrl);
    const originalFetch = globalThis.fetch;
    let disposed = false;
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          cancel() {
            disposed = true;
          },
          start(controller) {
            controller.enqueue(new TextEncoder().encode(JSON.stringify(note)));
            controller.close();
          },
        }),
        { headers: { "X-MiyulabMD-Session-User": "user:bob" } },
      );
    try {
      const outcome = await fetchNote(note.id, { viewerId: "alice" }).then(
        () => ({ published: true }),
        (error: Error & { status?: number }) => ({
          name: error.name,
          published: false,
          status: error.status,
        }),
      );
      return { disposed, outcome };
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, note);
  expect(result).toEqual({
    disposed: true,
    outcome: { name: "ApiIdentityError", published: false, status: 200 },
  });
});

test("private history and settings/source reads reject a cookie actor mismatch", async ({
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
      const calls = [
        fetchNoteHistory("note", {}, { viewerId: "alice" }),
        fetchTokens({ viewerId: "alice" }),
        fetchArticleSources({ viewerId: "alice" }),
      ];
      return await Promise.all(
        calls.map((call) =>
          call.then(
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

test("a guest note session cannot publish a newly authenticated cookie's response", async ({
  page,
}) => {
  await page.goto("/tests/browser/fixtures/storage.html");
  const result = await page.evaluate(async (note) => {
    const url = "/src/lib/note-read-session.ts";
    const { createNoteReadSession } = await import(url);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify(note), {
          headers: { "X-MiyulabMD-Session-User": "user:bob" },
        }),
      );
    const session = createNoteReadSession({
      cacheViewerId: null,
      mode: "guest",
      user: null,
    });
    try {
      return await session.read(note.id).then(
        () => "published",
        (error: Error) => error.name,
      );
    } finally {
      session.dispose();
      globalThis.fetch = originalFetch;
    }
  }, note);
  expect(result).toBe("ApiIdentityError");
});

test("Home and drive acquisition reject Bob's metadata before saving or publishing it", async ({
  page,
}) => {
  await page.goto("/tests/browser/fixtures/storage.html");
  const result = await page.evaluate(async (note) => {
    const homeUrl = "/src/lib/home-metadata-reader.ts";
    const prefetchUrl = "/src/lib/mydrive-prefetch.ts";
    const cacheUrl = "/src/lib/offline-cache.ts";
    const { readHomeMetadata } = await import(homeUrl);
    const { prefetchMyDrive } = await import(prefetchUrl);
    const { openOfflineCache } = await import(cacheUrl);
    const viewer = {
      cacheViewerId: "alice",
      mode: "authenticated",
      user: { displayName: "Alice", email: "alice@example.test", id: "alice" },
    };
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = async (input) => {
      await Promise.resolve();
      const path = String(input);
      calls.push(path);
      const body = path === "/api/notes" ? { notes: [note] } : { folders: [] };
      return new Response(JSON.stringify(body), {
        headers: { "X-MiyulabMD-Session-User": "user:bob" },
      });
    };
    try {
      const home = await readHomeMetadata({
        folderId: undefined,
        isCurrentOwner: () => true,
        signal: new AbortController().signal,
        viewer,
      }).then(
        () => "published",
        (error: Error) => error.name,
      );
      calls.length = 0;
      const prefetch = await prefetchMyDrive(viewer);
      const cache = await openOfflineCache({ userId: "alice" });
      try {
        return {
          calls,
          home,
          note: await cache.getNote(note.id),
          noteList: await cache.getNoteList(),
          prefetch,
        };
      } finally {
        cache.close();
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, note);
  expect(result).toEqual({
    calls: ["/api/folders/tree"],
    home: "ApiIdentityError",
    note: null,
    noteList: null,
    prefetch: { folders: 0, notes: 0, reason: "auth", status: "stopped" },
  });
});

test("expected guest, missing/malformed headers and real HTTP statuses stay distinct from communication errors", async ({
  page,
}) => {
  await page.goto("/tests/browser/fixtures/storage.html");
  const result = await page.evaluate(async () => {
    const apiUrl = "/src/lib/api.ts";
    const { fetchNote, ApiCommunicationError, ApiIdentityError } = await import(
      apiUrl
    );
    const originalFetch = globalThis.fetch;
    const cases = [
      { actor: "user:bob", status: 200, viewerId: null },
      { actor: "guest", status: 403, viewerId: "alice" },
      { actor: null, status: 503, viewerId: "alice" },
      { actor: "user:", status: 200, viewerId: "alice" },
      { actor: "user:alice, user:bob", status: 200, viewerId: "alice" },
      { actor: "user:alice", status: 403, viewerId: "alice" },
      { actor: "guest", status: 200, viewerId: null },
      { actor: null, status: 200, viewerId: undefined },
    ];
    try {
      const outcomes: unknown[] = [];
      for (const scenario of cases) {
        globalThis.fetch = async () =>
          new Response(JSON.stringify({ error: "Denied", id: "shared" }), {
            headers: scenario.actor
              ? { "X-MiyulabMD-Session-User": scenario.actor }
              : {},
            status: scenario.status,
          });
        outcomes.push(
          await fetchNote("shared", { viewerId: scenario.viewerId }).then(
            (value: { ok: boolean; status?: number }) => ({
              ok: value.ok,
              status: value.status ?? 200,
            }),
            (error: Error & { status: number }) => ({
              communication: error instanceof ApiCommunicationError,
              identity: error instanceof ApiIdentityError,
              status: error.status,
            }),
          ),
        );
      }
      return outcomes;
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
  expect(result).toEqual([
    { communication: false, identity: true, status: 200 },
    { communication: false, identity: true, status: 403 },
    { communication: false, identity: true, status: 503 },
    { communication: false, identity: true, status: 200 },
    { communication: false, identity: true, status: 200 },
    { ok: false, status: 403 },
    { ok: true, status: 200 },
    { ok: true, status: 200 },
  ]);
});

test("response rejection preserves effective Request/init cancellation reasons and disposes the body", async ({
  page,
}) => {
  await page.goto("/tests/browser/fixtures/storage.html");
  const result = await page.evaluate(async () => {
    const transportUrl = "/src/lib/api-transport.ts";
    const { requestJson } = await import(transportUrl);
    const originalFetch = globalThis.fetch;
    try {
      const outcomes: { disposed: boolean; outcome: string }[] = [];
      for (const precedence of ["request", "override", "null"] as const) {
        const requestController = new AbortController();
        const initController = new AbortController();
        const reason = { cancellation: precedence };
        const options = { viewerId: "alice" };
        let disposed = false;
        globalThis.fetch = async () => {
          await Promise.resolve();
          // Mutating the caller options during I/O cannot change the expectation.
          options.viewerId = "bob";
          requestController.abort(
            precedence === "override" ? { ignoredRequestReason: true } : reason,
          );
          if (precedence === "override") {
            initController.abort(reason);
          }
          return new Response(
            new ReadableStream({
              cancel() {
                disposed = true;
              },
              start(controller) {
                controller.enqueue(new TextEncoder().encode("{}"));
                controller.close();
              },
            }),
            { headers: { "X-MiyulabMD-Session-User": "user:bob" } },
          );
        };
        const input = new Request(`${location.origin}/api/notes/test`, {
          signal: requestController.signal,
        });
        const init =
          precedence === "request"
            ? undefined
            : { signal: precedence === "null" ? null : initController.signal };
        const outcome = await requestJson(input, init, options).then(
          () => "published",
          (error: Error) => (error === reason ? "exact-reason" : error.name),
        );
        outcomes.push({ disposed, outcome });
      }
      return outcomes;
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
  expect(result).toEqual([
    { disposed: true, outcome: "exact-reason" },
    { disposed: true, outcome: "exact-reason" },
    { disposed: true, outcome: "ApiIdentityError" },
  ]);
});

test("authenticated note reader neither saves Bob's response nor falls back to a cached Alice body", async ({
  page,
}) => {
  await page.goto("/tests/browser/fixtures/storage.html");
  const result = await page.evaluate(async (note) => {
    const sessionUrl = "/src/lib/note-read-session.ts";
    const cacheUrl = "/src/lib/offline-cache.ts";
    const { createNoteReadSession } = await import(sessionUrl);
    const { openOfflineCache } = await import(cacheUrl);
    const cache = await openOfflineCache({ userId: "alice" });
    await cache.putNote(note);
    const reader = createNoteReadSession({
      cacheViewerId: "alice",
      mode: "authenticated",
      user: { displayName: "Alice", email: "alice@example.test", id: "alice" },
    });
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = async () => {
      await Promise.resolve();
      requests += 1;
      return new Response(
        JSON.stringify({ ...note, markdown: "Bob response", updatedAt: 10 }),
        { headers: { "X-MiyulabMD-Session-User": "user:bob" } },
      );
    };
    try {
      const outcome = await reader.read(note.id).then(
        () => "published",
        (error: Error) => error.name,
      );
      return {
        cachedMarkdown: (await cache.getNote(note.id))?.note.markdown,
        outcome,
        requests,
      };
    } finally {
      globalThis.fetch = originalFetch;
      reader.dispose();
      cache.close();
    }
  }, note);
  expect(result).toEqual({
    cachedMarkdown: note.markdown,
    outcome: "ApiIdentityError",
    requests: 1,
  });
});

for (const changedPath of [
  "/api/folders/alice-root",
  "/api/notes",
  "/api/notes/note-1",
]) {
  test(`drive acquisition stops without retry/save at an identity change on ${changedPath}`, async ({
    page,
  }) => {
    await page.goto("/tests/browser/fixtures/storage.html");
    const result = await page.evaluate(
      async ({ changedPath, note }) => {
        const prefetchUrl = "/src/lib/mydrive-prefetch.ts";
        const cacheUrl = "/src/lib/offline-cache.ts";
        const { prefetchMyDrive } = await import(prefetchUrl);
        const { openOfflineCache } = await import(cacheUrl);
        const root = {
          ...note.access,
          children: [],
          crumbs: [],
          folder: "",
          id: "alice-root",
          locked: true,
          name: "MyDrive",
          parentId: null,
        };
        const owned = { ...note, folderId: root.id };
        const bodies: Record<string, unknown> = {
          "/api/folders/alice-root": root,
          "/api/folders/tree": { folders: [root] },
          "/api/notes": { notes: [owned] },
          "/api/notes/note-1": owned,
        };
        const originalFetch = globalThis.fetch;
        const calls: string[] = [];
        globalThis.fetch = async (input) => {
          await Promise.resolve();
          const path = String(input);
          calls.push(path);
          // The simulated server changes session at this endpoint, independently
          // of request options and the note's owner.
          return new Response(JSON.stringify(bodies[path]), {
            headers: {
              "X-MiyulabMD-Session-User":
                path === changedPath ? "user:bob" : "user:alice",
            },
            status: path === changedPath ? 503 : 200,
          });
        };
        try {
          const prefetch = await prefetchMyDrive({
            cacheViewerId: "alice",
            mode: "authenticated",
            user: {
              displayName: "Alice",
              email: "alice@example.test",
              id: "alice",
            },
          });
          const cache = await openOfflineCache({ userId: "alice" });
          try {
            return {
              calls,
              folder: await cache.getFolder(root.id),
              note: await cache.getNote(note.id),
              noteList: await cache.getNoteList(),
              prefetch,
            };
          } finally {
            cache.close();
          }
        } finally {
          globalThis.fetch = originalFetch;
        }
      },
      { changedPath, note },
    );
    expect(result.prefetch).toMatchObject({
      notes: 0,
      reason: "auth",
      status: "stopped",
    });
    expect(result.calls.at(-1)).toBe(changedPath);
    expect(result.calls.filter((path) => path === changedPath)).toHaveLength(1);
    expect(result.note).toBeNull();
    if (changedPath !== "/api/notes/note-1") {
      expect(result.noteList).toBeNull();
    }
    if (changedPath === "/api/folders/alice-root") {
      expect(result.folder).toBeNull();
    }
  });
}

test("identity notifications isolate listeners, unsubscribe, and ignore intentional aborts", async ({
  page,
}) => {
  await page.goto("/tests/browser/fixtures/storage.html");
  const result = await page.evaluate(async () => {
    const fetchUrl = "/src/lib/api-fetch.ts";
    const { apiFetch, subscribeApiIdentityChange } = await import(fetchUrl);
    const originalFetch = globalThis.fetch;
    const events: { expectedViewerId: string | null; status: number }[] = [];
    const unsubscribeBroken = subscribeApiIdentityChange(() => {
      throw new Error("A subscriber cannot replace the identity rejection");
    });
    const unsubscribe = subscribeApiIdentityChange(
      (error: { expectedViewerId: string | null; status: number }) => {
        events.push({
          expectedViewerId: error.expectedViewerId,
          status: error.status,
        });
      },
    );
    globalThis.fetch = async () =>
      new Response("{}", {
        headers: { "X-MiyulabMD-Session-User": "user:bob" },
        status: 503,
      });
    try {
      const first = await apiFetch("/api/notes", undefined, {
        viewerId: "alice",
      }).catch((error: Error) => error.name);
      unsubscribe();
      const second = await apiFetch("/api/notes", undefined, {
        viewerId: null,
      }).catch((error: Error) => error.name);
      const controller = new AbortController();
      const reason = { intentional: true };
      const unsubscribeAbort = subscribeApiIdentityChange(() => {
        events.push({ expectedViewerId: "unexpected-abort-event", status: 0 });
      });
      globalThis.fetch = async () => {
        await Promise.resolve();
        controller.abort(reason);
        return new Response("{}", {
          headers: { "X-MiyulabMD-Session-User": "user:bob" },
        });
      };
      try {
        const aborted = await apiFetch(
          "/api/notes",
          { signal: controller.signal },
          { viewerId: "alice" },
        ).catch((error: unknown) => error === reason);
        return { aborted, events, first, second };
      } finally {
        unsubscribeAbort();
      }
    } finally {
      unsubscribe();
      unsubscribeBroken();
      globalThis.fetch = originalFetch;
    }
  });
  expect(result).toEqual({
    aborted: true,
    events: [{ expectedViewerId: "alice", status: 503 }],
    first: "ApiIdentityError",
    second: "ApiIdentityError",
  });
});
