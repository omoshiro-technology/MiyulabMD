import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { createMutationGate, type MutationAccess } from "./mutation-gate.ts";
import type { ViewerContext } from "./viewer-context.ts";

afterEach(() => mock.restoreAll());

test("mutation dispatch uses current viewing access, including callbacks created before a transition", async () => {
  const authenticated: ViewerContext = {
    cacheViewerId: "alice",
    mode: "authenticated",
    user: {
      displayName: "Alice",
      email: "alice@example.test",
      id: "alice",
    },
  };
  const guest: ViewerContext = {
    cacheViewerId: null,
    mode: "guest",
    user: null,
  };
  const cached: ViewerContext = {
    cacheViewerId: "alice",
    mode: "cached",
    user: null,
  };
  const unavailable: ViewerContext = {
    cacheViewerId: null,
    mode: "unavailable",
    user: null,
  };
  let access: MutationAccess = { source: "pending", viewer: unavailable };
  let sent = 0;
  mock.method(globalThis, "fetch", () => {
    sent += 1;
    return Promise.resolve(new Response(null, { status: 204 }));
  });

  const gate = createMutationGate(() => access);
  // A stable callback must not retain permission from when it was created.
  const update = () =>
    gate.run(() => fetch("/api/notes/note-1", { method: "PATCH" }));
  const cases: (MutationAccess & { allowed: boolean })[] = [
    { allowed: false, source: "pending", viewer: unavailable },
    { allowed: true, source: "network", viewer: authenticated },
    { allowed: false, source: "cache", viewer: authenticated },
    { allowed: false, source: "pending", viewer: authenticated },
    { allowed: false, source: "cache", viewer: cached },
    { allowed: false, source: "network", viewer: cached },
    { allowed: false, source: "network", viewer: unavailable },
    { allowed: true, source: "network", viewer: guest },
    { allowed: false, source: "cache", viewer: guest },
    { allowed: true, source: "network", viewer: authenticated },
  ];
  for (const scenario of cases) {
    access = { source: scenario.source, viewer: scenario.viewer };
    const before = sent;
    assert.equal(gate.canMutate(), scenario.allowed);
    if (scenario.allowed) {
      assert.equal((await update()).status, 204);
      assert.equal(sent, before + 1);
    } else {
      assert.throws(update, { name: "ReadOnlyViewingError" });
      assert.equal(sent, before, "a blocked mutation must not reach fetch");
    }
  }
});
