import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import {
  clearEditCache,
  compactEditCache,
  editCacheDocName,
  hasSyncedOnce,
  hasUnsentEdits,
  isEditCacheEligible,
  isEditCacheOptedOut,
  listEditCacheDocs,
  markYjsSynced,
  needsCompaction,
  registerEditCacheDoc,
  setEditCacheOptOut,
  subscribeUnsentEdits,
  trackUnsentEdits,
} from "./edit-cache.ts";

type Store = {
  getItem(key: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
};

function installStorage() {
  const data = new Map<string, string>();
  const previous = (globalThis as { localStorage?: Store }).localStorage;
  (globalThis as { localStorage?: Store }).localStorage = {
    getItem: (key) => data.get(key) ?? null,
    removeItem: (key) => {
      data.delete(key);
    },
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
  return () => {
    if (previous === undefined) {
      (globalThis as { localStorage?: Store }).localStorage = undefined;
    } else {
      (globalThis as { localStorage?: Store }).localStorage = previous;
    }
  };
}

function withStorage<T>(run: () => T): T {
  const restore = installStorage();
  try {
    return run();
  } finally {
    restore();
  }
}

async function withStorageAsync<T>(run: () => Promise<T>): Promise<T> {
  const restore = installStorage();
  try {
    return await run();
  } finally {
    restore();
  }
}

type EligibleNote = Parameters<typeof isEditCacheEligible>[0];

function eligibleNote(overrides: Partial<EligibleNote> = {}): EligibleNote {
  return {
    access: { effectiveWriteScope: "self" },
    editLocked: false,
    ownerId: "user-1",
    ...overrides,
  } as EligibleNote;
}

test("editCacheDocName namespaces the IDB database by user", () => {
  assert.equal(editCacheDocName("u1", "n1"), "miyulabmd-edit:u1:n1");
  assert.notEqual(editCacheDocName("u1", "n1"), editCacheDocName("u2", "n1"));
});

test("eligible: owner + self write scope + unlocked + not opted out", () =>
  withStorage(() => {
    assert.equal(isEditCacheEligible(eligibleNote(), "user-1"), true);
  }));

test("ineligible when the viewer is not the owner", () =>
  withStorage(() => {
    assert.equal(isEditCacheEligible(eligibleNote(), "user-2"), false);
    assert.equal(isEditCacheEligible(eligibleNote(), ""), false);
  }));

test("ineligible for every write scope except self", () =>
  withStorage(() => {
    for (const scope of ["public", "link", "signed_in", "users"]) {
      const note = eligibleNote({
        access: { effectiveWriteScope: scope },
      } as Partial<EligibleNote>);
      assert.equal(
        isEditCacheEligible(note, "user-1"),
        false,
        `scope ${scope} must not be eligible`,
      );
    }
    assert.equal(isEditCacheEligible(eligibleNote(), "user-1"), true);
  }));

test("edit-locked notes are ineligible (§2.6 permanent lock)", () =>
  withStorage(() => {
    assert.equal(
      isEditCacheEligible(eligibleNote({ editLocked: true }), "user-1"),
      false,
    );
  }));

test("device opt-out makes every note ineligible", () =>
  withStorage(() => {
    assert.equal(isEditCacheEligible(eligibleNote(), "user-1"), true);
    setEditCacheOptOut("user-1", true);
    assert.equal(isEditCacheEligible(eligibleNote(), "user-1"), false);
    // Opt-out is per user; other users keep the default.
    assert.equal(
      isEditCacheEligible(eligibleNote({ ownerId: "user-2" }), "user-2"),
      true,
    );
  }));

test("opt-out defaults to on and round-trips per user", () =>
  withStorage(() => {
    assert.equal(isEditCacheOptedOut("user-1"), false);
    setEditCacheOptOut("user-1", true);
    assert.equal(isEditCacheOptedOut("user-1"), true);
    assert.equal(isEditCacheOptedOut("user-2"), false);
    setEditCacheOptOut("user-1", false);
    assert.equal(isEditCacheOptedOut("user-1"), false);
  }));

test("synced-once marker lifecycle is scoped by user and note", () =>
  withStorage(() => {
    assert.equal(hasSyncedOnce("user-1", "n1"), false);
    markYjsSynced("user-1", "n1");
    assert.equal(hasSyncedOnce("user-1", "n1"), true);
    assert.equal(hasSyncedOnce("user-1", "n2"), false);
    assert.equal(hasSyncedOnce("user-2", "n1"), false);
  }));

test("listEditCacheDocs enumerates registered doc names per user", () =>
  withStorage(() => {
    registerEditCacheDoc("u1", "n1");
    registerEditCacheDoc("u1", "n2");
    registerEditCacheDoc("u1", "n1");
    registerEditCacheDoc("u2", "n3");
    assert.deepEqual(listEditCacheDocs("u1"), [
      "miyulabmd-edit:u1:n1",
      "miyulabmd-edit:u1:n2",
    ]);
    assert.deepEqual(listEditCacheDocs("u2"), ["miyulabmd-edit:u2:n3"]);
    assert.deepEqual(listEditCacheDocs("u3"), []);
  }));

test("clearEditCache(userId, noteId) unregisters the doc and its synced marker", () =>
  withStorageAsync(async () => {
    registerEditCacheDoc("u1", "n1");
    registerEditCacheDoc("u1", "n2");
    markYjsSynced("u1", "n1");
    await clearEditCache("u1", "n1");
    assert.deepEqual(listEditCacheDocs("u1"), ["miyulabmd-edit:u1:n2"]);
    assert.equal(hasSyncedOnce("u1", "n1"), false);
  }));

test("clearEditCache(userId) removes every registered doc and marker", () =>
  withStorageAsync(async () => {
    registerEditCacheDoc("u1", "n1");
    registerEditCacheDoc("u1", "n2");
    registerEditCacheDoc("u2", "n9");
    markYjsSynced("u1", "n1");
    markYjsSynced("u1", "n2");
    await clearEditCache("u1");
    assert.deepEqual(listEditCacheDocs("u1"), []);
    assert.equal(hasSyncedOnce("u1", "n1"), false);
    assert.equal(hasSyncedOnce("u1", "n2"), false);
    // Other users are untouched.
    assert.deepEqual(listEditCacheDocs("u2"), ["miyulabmd-edit:u2:n9"]);
  }));

test("needsCompaction follows the 500-entry threshold", () => {
  assert.equal(needsCompaction(0), false);
  assert.equal(needsCompaction(500), false);
  assert.equal(needsCompaction(501), true);
});

test("compactEditCache skips small update logs without touching storage", async () => {
  let stored = 0;
  const persistence = { _dbsize: 10 };
  assert.equal(
    await compactEditCache(persistence as never, () => {
      stored++;
      return Promise.resolve();
    }),
    false,
  );
  assert.equal(stored, 0);
});

test("compactEditCache writes a merged state over the threshold", async () => {
  let stored = 0;
  const persistence = { _dbsize: 501 };
  assert.equal(
    await compactEditCache(persistence as never, () => {
      stored++;
      return Promise.resolve();
    }),
    true,
  );
  assert.equal(stored, 1);
});

function fakeProvider() {
  const listeners = new Set<(synced: boolean) => void>();
  return {
    emit(synced: boolean) {
      this.synced = synced;
      for (const cb of [...listeners]) {
        cb(synced);
      }
    },
    off(_event: "sync", cb: (synced: boolean) => void) {
      listeners.delete(cb);
    },
    on(_event: "sync", cb: (synced: boolean) => void) {
      listeners.add(cb);
    },
    synced: false,
  };
}

test("local edits while offline set the unsent flag until provider syncs", () => {
  const doc = new Y.Doc();
  const provider = fakeProvider();
  const dispose = trackUnsentEdits({ doc, noteId: "n-unsent-1", provider });
  try {
    assert.equal(hasUnsentEdits("n-unsent-1"), false);
    doc.transact(() => {
      doc.getText("markdown").insert(0, "a");
    });
    assert.equal(hasUnsentEdits("n-unsent-1"), true);
    provider.emit(true);
    assert.equal(hasUnsentEdits("n-unsent-1"), false);
  } finally {
    dispose();
    doc.destroy();
  }
});

test("provider- and persistence-origin updates are not unsent edits", () => {
  const doc = new Y.Doc();
  const provider = fakeProvider();
  const persistence = {};
  const dispose = trackUnsentEdits({
    doc,
    noteId: "n-unsent-2",
    persistence,
    provider,
  });
  try {
    doc.transact(() => {
      doc.getText("markdown").insert(0, "remote");
    }, provider);
    doc.transact(() => {
      doc.getText("markdown").insert(0, "idb");
    }, persistence);
    assert.equal(hasUnsentEdits("n-unsent-2"), false);
  } finally {
    dispose();
    doc.destroy();
  }
});

test("edits while synced are broadcast immediately and not flagged", () => {
  const doc = new Y.Doc();
  const provider = fakeProvider();
  const dispose = trackUnsentEdits({ doc, noteId: "n-unsent-3", provider });
  try {
    provider.emit(true);
    doc.transact(() => {
      doc.getText("markdown").insert(0, "x");
    });
    assert.equal(hasUnsentEdits("n-unsent-3"), false);
  } finally {
    dispose();
    doc.destroy();
  }
});

test("offline edits survive a disconnect and clear on the next sync", () => {
  const doc = new Y.Doc();
  const provider = fakeProvider();
  const dispose = trackUnsentEdits({ doc, noteId: "n-unsent-4", provider });
  try {
    provider.emit(true);
    provider.emit(false);
    doc.transact(() => {
      doc.getText("markdown").insert(0, "offline");
    });
    assert.equal(hasUnsentEdits("n-unsent-4"), true);
    provider.emit(true);
    assert.equal(hasUnsentEdits("n-unsent-4"), false);
  } finally {
    dispose();
    doc.destroy();
  }
});

test("subscribeUnsentEdits notifies listeners on transitions", () => {
  const doc = new Y.Doc();
  const provider = fakeProvider();
  const seen: boolean[] = [];
  const unsubscribe = subscribeUnsentEdits("n-unsent-5", () => {
    seen.push(hasUnsentEdits("n-unsent-5"));
  });
  const dispose = trackUnsentEdits({ doc, noteId: "n-unsent-5", provider });
  try {
    doc.transact(() => {
      doc.getText("markdown").insert(0, "a");
    });
    provider.emit(true);
    assert.deepEqual(seen, [true, false]);
  } finally {
    dispose();
    unsubscribe();
    doc.destroy();
  }
});

test("disposing the tracker stops updates from changing the flag", () => {
  const doc = new Y.Doc();
  const provider = fakeProvider();
  const dispose = trackUnsentEdits({ doc, noteId: "n-unsent-6", provider });
  dispose();
  doc.transact(() => {
    doc.getText("markdown").insert(0, "a");
  });
  assert.equal(hasUnsentEdits("n-unsent-6"), false);
  doc.destroy();
});
