import assert from "node:assert/strict";
import test from "node:test";
import { EditLockRecheck, type EditLockRow } from "./edit-lock.ts";

function harness(row: EditLockRow | null, intervalMs = 5_000) {
  const state = { now: 1_000, reads: 0, row };
  const lock = new EditLockRecheck(
    () => {
      state.reads += 1;
      return Promise.resolve(state.row);
    },
    intervalMs,
    () => state.now,
  );
  return { lock, state };
}

test("locked() throttles D1 reads within the interval", async () => {
  const { lock, state } = harness({ edit_locked: 1 });
  assert.equal(await lock.locked(), true);
  assert.equal(await lock.locked(), true);
  assert.equal(state.reads, 1);
});

test("locked() picks up mid-session lock and unlock after the interval", async () => {
  const { lock, state } = harness({ edit_locked: 0 });
  assert.equal(await lock.locked(), false);

  // Mid-session lock: next recheck reports locked.
  state.row = { edit_locked: 1 };
  state.now += 5_001;
  assert.equal(await lock.locked(), true);
  assert.equal(state.reads, 2);

  // Explicit unlock re-opens writes on the following recheck.
  state.row = { edit_locked: 0 };
  state.now += 5_001;
  assert.equal(await lock.locked(), false);
});

test("lockedNow() bypasses and refreshes the throttle cache", async () => {
  const { lock, state } = harness({ edit_locked: 1 });
  assert.equal(await lock.locked(), true);
  assert.equal(state.reads, 1);

  // Fresh read even inside the throttle window.
  state.row = { edit_locked: 0 };
  assert.equal(await lock.lockedNow(), false);
  assert.equal(state.reads, 2);

  // The fresh verdict is cached for the throttled path.
  assert.equal(await lock.locked(), false);
  assert.equal(state.reads, 2);
});

test("concurrent locked() calls share a single read", async () => {
  const { lock, state } = harness({ edit_locked: 1 });
  const [a, b] = await Promise.all([lock.locked(), lock.locked()]);
  assert.equal(a, true);
  assert.equal(b, true);
  assert.equal(state.reads, 1);
});

test("a slower in-flight read cannot overwrite a fresher lockedNow() verdict", async () => {
  // Each readRow captures the row at call time (like a D1 snapshot) but
  // resolves only when released.
  const rows: (EditLockRow | null)[] = [{ edit_locked: 1 }, { edit_locked: 0 }];
  const releases: Array<() => void> = [];
  let calls = 0;
  const lock = new EditLockRecheck(
    () => {
      const row = rows[calls++] ?? null;
      return new Promise<EditLockRow | null>((resolve) => {
        releases.push(() => resolve(row));
      });
    },
    5_000,
    () => 1_000,
  );

  const slow = lock.locked();
  const fresh = lock.lockedNow();
  // The newer read resolves first and caches the unlocked verdict.
  releases[1]?.();
  assert.equal(await fresh, false);
  // The stale read resolves late: its verdict still reaches its own caller,
  // but must not be published into the throttle cache.
  releases[0]?.();
  assert.equal(await slow, true);
  assert.equal(await lock.locked(), false);
  assert.equal(calls, 2);
});

test("read failure fails open and is not cached", async () => {
  let fail = true;
  let reads = 0;
  const lock = new EditLockRecheck(() => {
    reads += 1;
    return fail
      ? Promise.reject(new Error("D1 unavailable"))
      : Promise.resolve({ edit_locked: 1 });
  });
  assert.equal(await lock.locked(), false);
  fail = false;
  assert.equal(await lock.locked(), true);
  assert.equal(reads, 2);
});

test("missing row is treated as unlocked", async () => {
  const { lock } = harness(null);
  assert.equal(await lock.locked(), false);
});
