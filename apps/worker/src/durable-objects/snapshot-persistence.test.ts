import assert from "node:assert/strict";
import test from "node:test";
import {
  SnapshotPersistence,
  type SnapshotStorage,
  type SnapshotTransaction,
} from "./snapshot-persistence.ts";

function storage() {
  const values = new Map<string, unknown>();
  let alarm: number | null = null;
  let failAlarm = false;
  const store: SnapshotStorage = {
    delete(key: string) {
      return Promise.resolve(values.delete(key));
    },
    deleteAlarm() {
      alarm = null;
      return Promise.resolve();
    },
    get<T>(key: string) {
      return Promise.resolve(values.get(key) as T | undefined);
    },
    put(key: string, value: unknown) {
      values.set(key, value);
      return Promise.resolve();
    },
    setAlarm(time: number | Date) {
      if (failAlarm) {
        return Promise.reject(new Error("alarm unavailable"));
      }
      alarm = Number(time);
      return Promise.resolve();
    },
    async transaction<T>(
      run: (txn: SnapshotTransaction) => Promise<T>,
    ): Promise<T> {
      const before = new Map(values);
      const beforeAlarm = alarm;
      try {
        return await run(store);
      } catch (error) {
        values.clear();
        for (const [key, value] of before) {
          values.set(key, value);
        }
        alarm = beforeAlarm;
        throw error;
      }
    },
  };
  return {
    alarm: () => alarm,
    failAlarm: () => {
      failAlarm = true;
    },
    store,
    values,
  };
}

test("an alarm scheduling failure cannot commit Yjs without pending work", async () => {
  const s = storage();
  const writer = new SnapshotPersistence(s.store, () => Promise.resolve());
  await writer.persist(new Uint8Array([1]), "previous");
  const before = new Map(s.values);
  const beforeAlarm = s.alarm();
  s.failAlarm();
  await assert.rejects(
    writer.persist(new Uint8Array([2]), "lost wakeup"),
    /alarm unavailable/,
  );
  assert.deepEqual(s.values, before);
  assert.equal(s.alarm(), beforeAlarm);
});

test("pending snapshot and alarm survive actor reconstruction", async () => {
  const s = storage();
  const written: string[] = [];
  const first = new SnapshotPersistence(s.store, (text) => {
    written.push(text);
    return Promise.resolve();
  });
  const before = Date.now();
  await first.persist(new Uint8Array([1]), "durable body");
  assert.deepEqual(s.values.get("yjs-update"), new Uint8Array([1]));
  const alarm = s.alarm();
  assert.ok(alarm !== null && alarm >= before + 3000);
  assert.deepEqual(written, []);
  const reconstructed = new SnapshotPersistence(s.store, (text) => {
    written.push(text);
    return Promise.resolve();
  });
  await reconstructed.flush();
  assert.deepEqual(written, ["durable body"]);
  assert.equal(s.values.has("snapshot-pending"), false);
  assert.equal(s.alarm(), null);
});

test("failed D1 persistence retains dirty state and a durable retry", async () => {
  const s = storage();
  let fail = true;
  const writer = new SnapshotPersistence(s.store, () => {
    if (fail) {
      return Promise.reject(new Error("D1 unavailable"));
    }
    return Promise.resolve();
  });
  await writer.persist(new Uint8Array([1]), "retry me");
  await assert.rejects(writer.flush(), /D1 unavailable/);
  assert.ok(s.values.has("snapshot-pending"));
  const alarm = s.alarm();
  assert.ok(alarm !== null && alarm > Date.now());
  fail = false;
  await writer.flush();
  assert.equal(s.values.has("snapshot-pending"), false);
});

test("in-flight flush cannot clear a newer edit and concurrent flushes stay ordered", async () => {
  const s = storage();
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const written: string[] = [];
  const writer = new SnapshotPersistence(s.store, async (text) => {
    if (text === "old") {
      started();
      await gate;
    }
    written.push(text);
  });
  await writer.persist(new Uint8Array([1]), "old");
  const oldFlush = writer.flush();
  await entered;
  await writer.persist(new Uint8Array([2]), "new");
  release();
  await oldFlush;
  assert.ok(s.values.has("snapshot-pending"));
  assert.ok(s.alarm());
  await Promise.all([writer.flush(), writer.flush()]);
  assert.deepEqual(written, ["old", "new"]);
  assert.equal(s.values.has("snapshot-pending"), false);
});
