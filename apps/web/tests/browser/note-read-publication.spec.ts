import { expect, test } from "@playwright/test";
import { note } from "./fixtures/note.ts";

type ProbeWindow = Window & {
  publicationProbe: {
    start(depth: number): void;
    restore(): void;
    reader: { dispose(): void };
    pending: Promise<unknown>;
    outcome: Promise<{ error: string | null; source: string | null }>;
  };
};
type PausedEvent = { callFrames: { callFrameId: string }[] };

test("a pending cached read rejects when disposed before publication", async ({
  page,
  context,
}) => {
  await page.route(`**/api/notes/${note.id}`, (route) =>
    route.fulfill({
      headers: { "X-MiyulabMD-Session-User": "user:alice" },
      json: { error: "Unavailable" },
      status: 503,
    }),
  );
  await page.goto("/tests/browser/fixtures/storage.html");
  await page.evaluate(async (note) => {
    const cacheUrl = "/src/lib/offline-cache.ts";
    const readerUrl = "/src/lib/note-read-session.ts";
    const { openOfflineCache } = await import(cacheUrl);
    const { createNoteReadSession } = await import(readerUrl);
    const cache = await openOfflineCache({ userId: "alice" });
    try {
      await cache.putNote(note);
    } finally {
      cache.close();
    }
    const originalText = Blob.prototype.text;
    const probe = {
      checkpoint() {
        // CDP pauses this test-owned function, not an implementation function.
      },
      restore() {
        Blob.prototype.text = originalText;
      },
      start(depth: number) {
        const reader = createNoteReadSession({
          cacheViewerId: "alice",
          mode: "authenticated",
          user: {
            displayName: "Alice",
            email: "alice@example.test",
            id: "alice",
          },
        });
        Blob.prototype.text = async function () {
          const text = await originalText.call(this);
          const checkpointAfter = (remaining: number) => {
            if (remaining === 0) {
              probe.checkpoint();
            } else {
              queueMicrotask(() => checkpointAfter(remaining - 1));
            }
          };
          checkpointAfter(depth);
          return text;
        };
        const pending = reader.read(note.id);
        const outcome = pending.then(
          (result: { source: string }) => ({
            error: null,
            source: result.source,
          }),
          (error: unknown) => ({
            error: error instanceof Error ? error.name : "UnknownError",
            source: null,
          }),
        );
        Object.assign(probe, { outcome, pending, reader });
      },
    };
    Object.assign(window, { publicationProbe: probe });
  }, note);

  const cdp = await context.newCDPSession(page);
  let breakpointId: string | undefined;
  let cancellations = 0;
  try {
    await cdp.send("Debugger.enable");
    const checkpoint = await cdp.send("Runtime.evaluate", {
      expression: "window.publicationProbe.checkpoint",
    });
    expect(checkpoint.result.objectId).toBeTruthy();
    const breakpoint = await cdp.send("Debugger.setBreakpointOnFunctionCall", {
      objectId: checkpoint.result.objectId,
    });
    breakpointId = breakpoint.breakpointId;

    for (const depth of [1, 2, 3, 4, 5, 6]) {
      const paused = new Promise<PausedEvent>((resolve) =>
        cdp.once("Debugger.paused", resolve),
      );
      await page.evaluate(
        (depth) => (window as ProbeWindow).publicationProbe.start(depth),
        depth,
      );
      const event = await paused;
      let pending = false;
      try {
        const promise = await cdp.send("Debugger.evaluateOnCallFrame", {
          callFrameId: event.callFrames[0].callFrameId,
          expression: "window.publicationProbe.pending",
        });
        const properties = await cdp.send("Runtime.getProperties", {
          objectId: promise.result.objectId,
        });
        const state = properties.internalProperties?.find(
          (property: { name: string }) => property.name === "[[PromiseState]]",
        )?.value?.value;
        expect(["pending", "fulfilled", "rejected"]).toContain(state);
        pending = state === "pending";
        if (pending) {
          cancellations += 1;
          await cdp.send("Debugger.evaluateOnCallFrame", {
            callFrameId: event.callFrames[0].callFrameId,
            expression: "window.publicationProbe.reader.dispose()",
          });
        }
      } finally {
        await cdp.send("Debugger.resume");
      }
      const outcome = await page.evaluate(
        () => (window as ProbeWindow).publicationProbe.outcome,
      );
      await page.evaluate(() => {
        const probe = (window as ProbeWindow).publicationProbe;
        probe.restore();
        probe.reader.dispose();
      });
      // A refactor may complete earlier. Never expect cancellation of an
      // already-fulfilled promise; test only operations confirmed pending.
      if (pending) {
        expect(outcome, `pending at checkpoint ${depth}`).toEqual({
          error: "AbortError",
          source: null,
        });
      }
    }
    expect(cancellations).toBeGreaterThan(0);
  } finally {
    if (breakpointId) {
      await cdp.send("Debugger.removeBreakpoint", { breakpointId });
    }
    await cdp.send("Debugger.resume").catch(() => {
      // No pause remains on the successful path.
    });
    await page.evaluate(() => {
      const probe = (window as ProbeWindow).publicationProbe;
      probe.restore();
      probe.reader?.dispose();
    });
    await cdp.detach();
  }
});
