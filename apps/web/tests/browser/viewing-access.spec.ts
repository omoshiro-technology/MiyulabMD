import { expect, test } from "@playwright/test";
import type { ViewerContext } from "../../src/lib/viewer-context.ts";

test("only the current owned viewing scope can grant mutation access", async ({
  page,
}) => {
  await page.goto("/tests/browser/fixtures/storage.html");
  const checks = await page.evaluate(async () => {
    const moduleUrl = "/src/lib/viewing-access.ts";
    const gateUrl = "/src/lib/mutation-gate.ts";
    const { bindMutationAccess, createViewingAccess, runMutation } =
      await import(moduleUrl);
    const { ReadOnlyViewingError } = await import(gateUrl);
    const alice: ViewerContext = {
      cacheViewerId: "alice",
      mode: "authenticated",
      user: {
        displayName: "Alice",
        email: "alice@example.test",
        id: "alice",
      },
    };
    let viewer = alice;
    const viewing = createViewingAccess(() => viewer);
    const attempt = () => {
      try {
        return runMutation(() => "allowed");
      } catch (error) {
        return error instanceof ReadOnlyViewingError ? "blocked" : "unexpected";
      }
    };
    const results: Record<string, unknown> = {};
    results.unbound = attempt();
    const unbindOld = bindMutationAccess(viewing.getAccess);
    let unbindNew: (() => void) | undefined;
    try {
      results.root = attempt();
      const first = viewing.beginView(viewer);
      results.firstCurrent = first.isCurrent();
      results.pending = attempt();
      results.firstPublished = first.publish({
        source: "network",
        viewer: structuredClone(viewer),
      });
      results.firstNetwork = attempt();

      const second = viewing.beginView(viewer);
      results.firstReplaced = first.isCurrent();
      first.dispose();
      results.afterOldDispose = attempt();
      results.stalePublish = first.publish({
        source: "network",
        viewer: structuredClone(viewer),
      });
      const cached = { source: "cache", viewer: structuredClone(viewer) };
      results.cachePublished = second.publish(cached);
      cached.source = "network";
      results.afterInputMutation = attempt();
      const observed = viewing.getAccess();
      try {
        observed.source = "network";
      } catch {
        // A read-only result is also a valid way to protect the snapshot.
      }
      results.afterObservedMutation = attempt();
      second.publish({ source: "network", viewer: structuredClone(viewer) });
      results.networkAgain = attempt();

      viewer = {
        cacheViewerId: "bob",
        mode: "authenticated",
        user: { displayName: "Bob", email: "bob@example.test", id: "bob" },
      };
      results.changedViewer = attempt();
      results.ownerInvalidated = second.isCurrent();
      results.oldViewerPublish = second.publish({
        source: "network",
        viewer: structuredClone(alice),
      });
      const bobView = viewing.beginView(viewer);
      bobView.publish({ source: "network", viewer: structuredClone(viewer) });
      results.bob = attempt();
      const stale = viewing.beginView(alice);
      results.staleCurrent = stale.isCurrent();
      results.staleBeginPublish = stale.publish({
        source: "network",
        viewer: structuredClone(alice),
      });
      stale.dispose();
      second.dispose();
      results.afterStaleHandles = attempt();

      unbindNew = bindMutationAccess(viewing.getAccess);
      unbindOld();
      results.afterOldUnbind = attempt();
      unbindNew();
      results.afterUnbind = attempt();
      bobView.dispose();
      results.disposed = bobView.isCurrent();
      return results;
    } finally {
      unbindOld();
      unbindNew?.();
    }
  });
  expect(checks).toEqual({
    afterInputMutation: "blocked",
    afterObservedMutation: "blocked",
    afterOldDispose: "blocked",
    afterOldUnbind: "allowed",
    afterStaleHandles: "allowed",
    afterUnbind: "blocked",
    bob: "allowed",
    cachePublished: true,
    changedViewer: "blocked",
    disposed: false,
    firstCurrent: true,
    firstNetwork: "allowed",
    firstPublished: true,
    firstReplaced: false,
    networkAgain: "allowed",
    oldViewerPublish: false,
    ownerInvalidated: false,
    pending: "blocked",
    root: "allowed",
    staleBeginPublish: false,
    staleCurrent: false,
    stalePublish: false,
    unbound: "blocked",
  });
});
