import assert from "node:assert/strict";
import { test } from "node:test";
import { listEditCacheNoteIds, registerEditCacheDoc } from "./edit-cache.ts";
import {
  guardEditCachePurge,
  PurgeCancelledError,
  setPurgeGuard,
} from "./identity-lifecycle.ts";

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
    (globalThis as { localStorage?: Store }).localStorage = previous;
  };
}

async function withStorage<T>(run: () => Promise<T>): Promise<T> {
  const restore = installStorage();
  try {
    return await run();
  } finally {
    restore();
    setPurgeGuard(null);
  }
}

test("guardEditCachePurge: doc が無ければガードを呼ばずに通す", async () => {
  await withStorage(async () => {
    let called = false;
    setPurgeGuard(() => {
      called = true;
      return Promise.resolve(false);
    });
    await guardEditCachePurge("u1", "logout");
    assert.equal(called, false);
  });
});

test("guardEditCachePurge: doc がありガード未登録なら fail-closed で中止する", async () => {
  await withStorage(async () => {
    registerEditCacheDoc("u1", "note-1");
    await assert.rejects(
      () => guardEditCachePurge("u1", "logout"),
      PurgeCancelledError,
    );
    // doc は消えない。
    assert.deepEqual(listEditCacheNoteIds("u1"), ["note-1"]);
  });
});

test("guardEditCachePurge: ガードが false を返したら中止し doc を残す", async () => {
  await withStorage(async () => {
    registerEditCacheDoc("u1", "note-1");
    setPurgeGuard(() => Promise.resolve(false));
    await assert.rejects(
      () => guardEditCachePurge("u1", "switch"),
      PurgeCancelledError,
    );
    assert.deepEqual(listEditCacheNoteIds("u1"), ["note-1"]);
  });
});

test("guardEditCachePurge: ガードが true を返したら編集キャッシュも消して続行する", async () => {
  await withStorage(async () => {
    registerEditCacheDoc("u1", "note-1");
    registerEditCacheDoc("u1", "note-2");
    let received: { noteIds: string[]; reason: string } | null = null;
    setPurgeGuard((input) => {
      received = { noteIds: input.noteIds, reason: input.reason };
      return Promise.resolve(true);
    });
    await guardEditCachePurge("u1", "logout");
    assert.deepEqual(received?.noteIds, ["note-1", "note-2"]);
    assert.equal(received?.reason, "logout");
    // レジストリもクリアされる（indexedDB が無い Node では DB 削除は no-op）。
    assert.deepEqual(listEditCacheNoteIds("u1"), []);
  });
});
