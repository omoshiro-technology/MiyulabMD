import assert from "node:assert/strict";
import test from "node:test";
import { writeSnapshotAndNotify } from "./snapshot-saved.ts";

test("only completed D1 writes notify current subscribers, including the editor", async () => {
  let complete!: () => void;
  const write = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const frames: Uint8Array[] = [];
  let subscribers: { send(frame: Uint8Array): void }[] = [];
  const saved = writeSnapshotAndNotify(
    async () => {
      await write;
      return "persisted" as const;
    },
    "room",
    () => subscribers,
  );
  assert.deepEqual(frames, []);
  subscribers = [
    {
      send() {
        throw new Error("closed");
      },
    },
    {
      send(frame) {
        frames.push(frame);
      },
    },
  ];
  complete();
  await saved;
  assert.deepEqual(
    frames.map((frame) => Array.from(frame)),
    [[4, 1, 114, 111, 111, 109]],
  );
});

test("a failed/uncommitted D1 write never emits a saved notification", async () => {
  let sent = 0;
  await assert.rejects(
    writeSnapshotAndNotify(
      () => Promise.reject(new Error("D1 failed")),
      "room",
      () => [
        {
          send() {
            sent++;
          },
        },
      ],
    ),
    /D1 failed/,
  );
  assert.equal(sent, 0);
});

test("a rejected write (gold lock) resolves without notifying subscribers", async () => {
  let sent = 0;
  const result = await writeSnapshotAndNotify(
    () => Promise.resolve("rejected" as const),
    "room",
    () => [
      {
        send() {
          sent++;
        },
      },
    ],
  );
  assert.equal(result, "rejected");
  assert.equal(sent, 0);
});
