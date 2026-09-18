import { expect, test } from "@playwright/test";
import { note } from "./fixtures/note.ts";

for (const status of [200, 403]) {
  test(`shared ${status} results isolate subscribers and viewer scopes`, async ({
    page,
  }) => {
    await page.goto("/tests/browser/fixtures/storage.html");
    const result = await page.evaluate(
      async ({ note, status }) => {
        const apiUrl = "/src/lib/api.ts";
        const { fetchNote } = await import(apiUrl);
        const aliceOptions = {
          viewerId: "alice",
        };
        const originalFetch = globalThis.fetch;
        const pending: {
          resolve: (response: Response) => void;
          signal: AbortSignal | null | undefined;
        }[] = [];
        globalThis.fetch = (_input, init) =>
          new Promise<Response>((resolve) => {
            pending.push({ resolve, signal: init?.signal });
          });
        const controller = new AbortController();
        const reason = { message: "Only the first subscriber left" };
        try {
          const cancelled = fetchNote(note.id, {
            ...aliceOptions,
            signal: controller.signal,
          }).then(
            () => false,
            (error: unknown) => error === reason,
          );
          const first = fetchNote(note.id, aliceOptions);
          const second = fetchNote(note.id, aliceOptions);
          const otherViewer = fetchNote(note.id, {
            viewerId: "bob",
          });
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          );
          controller.abort(reason);
          const cancelledByIdentity = await cancelled;
          const [aliceRequest, bobRequest] = pending;
          if (!(aliceRequest && bobRequest)) {
            throw new Error("Expected separate Alice and Bob requests");
          }
          const sharedWasAborted = aliceRequest.signal?.aborted;
          const bobNote = {
            ...note,
            access: {
              ...note.access,
              flags: { canAdmin: false, canEdit: false, canView: true },
            },
          };
          aliceRequest.resolve(
            new Response(
              JSON.stringify(status === 200 ? note : { error: "Alice denied" }),
              {
                headers: { "X-MiyulabMD-Session-User": "user:alice" },
                status,
              },
            ),
          );
          bobRequest.resolve(
            new Response(
              JSON.stringify(
                status === 200 ? bobNote : { error: "Bob denied" },
              ),
              {
                headers: { "X-MiyulabMD-Session-User": "user:bob" },
                status,
              },
            ),
          );
          const [a, b, other] = await Promise.all([first, second, otherViewer]);
          if (a.ok) {
            a.data.markdown = "Local mutation";
            a.data.access.flags.canAdmin = false;
          } else {
            a.error = "Local mutation";
          }
          return {
            cancelledByIdentity,
            other,
            requests: pending.length,
            second: b,
            sharedWasAborted,
          };
        } finally {
          globalThis.fetch = originalFetch;
          controller.abort();
        }
      },
      { note, status },
    );
    expect(result.cancelledByIdentity).toBe(true);
    expect(result.sharedWasAborted).toBe(false);
    expect(result.requests).toBe(2);
    if (status === 200) {
      expect(result.second).toEqual({ data: note, ok: true });
      expect(result.other).toMatchObject({
        data: { access: { flags: { canAdmin: false } } },
        ok: true,
      });
    } else {
      expect(result.second).toEqual({
        error: "Alice denied",
        ok: false,
        status: 403,
      });
      expect(result.other).toEqual({
        error: "Bob denied",
        ok: false,
        status: 403,
      });
    }
  });
}

test("last cancellation releases a group without letting old cleanup remove its replacement", async ({
  page,
}) => {
  await page.goto("/tests/browser/fixtures/storage.html");
  const result = await page.evaluate(async (note) => {
    const apiUrl = "/src/lib/api.ts";
    const { fetchNote } = await import(apiUrl);
    // This case exercises transport subscription lifetime, not IDB
    // scheduling — the dedup group keys on the viewer plus read generation.
    const readOptions = {
      viewerId: "alice",
    };
    const originalFetch = globalThis.fetch;
    const pending: {
      resolve: (response: Response) => void;
      signal: AbortSignal | null | undefined;
    }[] = [];
    globalThis.fetch = (_input, init) =>
      new Promise<Response>((resolve) => {
        pending.push({ resolve, signal: init?.signal });
      });
    const first = new AbortController();
    const second = new AbortController();
    const firstReason = { subscriber: 1 };
    const secondReason = { subscriber: 2 };
    const tick = () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const complete = (index: number, markdown: string) => {
      const request = pending[index];
      if (!request) {
        throw new Error(`Missing request ${index}`);
      }
      request.resolve(
        new Response(JSON.stringify({ ...note, markdown }), {
          headers: { "X-MiyulabMD-Session-User": "user:alice" },
        }),
      );
    };
    try {
      const already = new AbortController();
      already.abort(firstReason);
      const preCancelled = await fetchNote(note.id, {
        ...readOptions,
        signal: already.signal,
      }).then(
        () => false,
        (error: unknown) => error === firstReason,
      );
      const requestsBefore = pending.length;
      const a = fetchNote(note.id, {
        ...readOptions,
        signal: first.signal,
      }).catch((error: unknown) => error === firstReason);
      const b = fetchNote(note.id, {
        ...readOptions,
        signal: second.signal,
      }).catch((error: unknown) => error === secondReason);
      await tick();
      first.abort(firstReason);
      second.abort(secondReason);
      const cancelled = await Promise.all([a, b]);
      const underlyingAborted = pending[0]?.signal?.aborted;
      const fresh = fetchNote(note.id, readOptions);
      await tick();
      complete(0, "Old cancelled result");
      await tick();
      const joined = fetchNote(note.id, readOptions);
      await tick();
      const requestsWhileFresh = pending.length;
      complete(1, "Fresh result");
      const recovered = await Promise.all([fresh, joined]);
      const later = fetchNote(note.id, readOptions);
      await tick();
      complete(2, "Later result");
      return {
        cancelled,
        later: await later,
        preCancelled,
        recovered,
        requestsBefore,
        requestsTotal: pending.length,
        requestsWhileFresh,
        underlyingAborted,
      };
    } finally {
      first.abort();
      second.abort();
      globalThis.fetch = originalFetch;
    }
  }, note);
  expect(result.preCancelled).toBe(true);
  expect(result.requestsBefore).toBe(0);
  expect(result.cancelled).toEqual([true, true]);
  expect(result.underlyingAborted).toBe(true);
  expect(result.requestsWhileFresh).toBe(2);
  expect(result.requestsTotal).toBe(3);
  expect(result.recovered).toEqual([
    { data: { ...note, markdown: "Fresh result" }, ok: true },
    { data: { ...note, markdown: "Fresh result" }, ok: true },
  ]);
  expect(result.later).toEqual({
    data: { ...note, markdown: "Later result" },
    ok: true,
  });
});

test("one result-copy failure settles that subscriber without abandoning the others", async ({
  page,
}) => {
  await page.goto("/tests/browser/fixtures/storage.html");
  const result = await page.evaluate(async (note) => {
    const apiUrl = "/src/lib/api.ts";
    const { fetchNote } = await import(apiUrl);
    const readOptions = {
      viewerId: "alice",
    };
    const originalFetch = globalThis.fetch;
    const originalClone = globalThis.structuredClone;
    const fault = new Error("Injected copy failure");
    let copies = 0;
    const unhandled: string[] = [];
    const onUnhandled = (event: PromiseRejectionEvent) => {
      unhandled.push(String(event.reason));
      event.preventDefault();
    };
    window.addEventListener("unhandledrejection", onUnhandled);
    globalThis.fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify(note), {
          headers: { "X-MiyulabMD-Session-User": "user:alice" },
        }),
      );
    globalThis.structuredClone = <T>(
      value: T,
      options?: StructuredSerializeOptions,
    ): T => {
      if (++copies === 1) {
        throw fault;
      }
      return originalClone(value, options);
    };
    const first = new AbortController();
    const second = new AbortController();
    const outcome = {
      first: "pending",
      reasonMatches: false,
      second: "pending",
    };
    try {
      void fetchNote(note.id, {
        ...readOptions,
        signal: first.signal,
      }).then(
        () => {
          outcome.first = "fulfilled";
        },
        (error: unknown) => {
          outcome.first = "rejected";
          outcome.reasonMatches = error === fault;
        },
      );
      void fetchNote(note.id, {
        ...readOptions,
        signal: second.signal,
      }).then(
        () => {
          outcome.second = "fulfilled";
        },
        () => {
          outcome.second = "rejected";
        },
      );
      // Delivery waits on the durable purge-fence read alongside the
      // transport — poll rather than assuming a fixed frame budget.
      for (
        let attempts = 0;
        attempts < 200 &&
        (outcome.first === "pending" || outcome.second === "pending");
        attempts += 1
      ) {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
      }
      return { ...outcome, unhandled: [...unhandled] };
    } finally {
      first.abort();
      second.abort();
      globalThis.fetch = originalFetch;
      globalThis.structuredClone = originalClone;
      window.removeEventListener("unhandledrejection", onUnhandled);
    }
  }, note);
  expect(result).toEqual({
    first: "rejected",
    reasonMatches: true,
    second: "fulfilled",
    unhandled: [],
  });
});
