import assert from "node:assert/strict";
import test from "node:test";
import {
  encodeSnapshotSaved,
  isSnapshotSavedForRoom,
  MESSAGE_SNAPSHOT_SAVED,
} from "./snapshot-saved.ts";

test("saved protocol contains only its type, version and room ID", () => {
  const frame = encodeSnapshotSaved("room");
  assert.equal(frame[0], MESSAGE_SNAPSHOT_SAVED);
  assert.deepEqual(Array.from(frame), [4, 1, 114, 111, 111, 109]);
  assert.equal(isSnapshotSavedForRoom(frame.subarray(1), "room"), true);
  assert.equal(isSnapshotSavedForRoom(frame.subarray(1), "other"), false);
});

test("unknown versions, malformed UTF-8, empty and extended payloads are ignored", () => {
  for (const bytes of [
    [],
    [1],
    [2, 114, 111, 111, 109],
    [1, 255],
    [1, 114, 111, 111, 109, 0],
  ]) {
    assert.equal(isSnapshotSavedForRoom(new Uint8Array(bytes), "room"), false);
  }
});
