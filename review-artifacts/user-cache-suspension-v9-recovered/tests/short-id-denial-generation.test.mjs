import assert from "node:assert/strict";
import test from "node:test";

import {
  beginNoteReadOrder,
  bindNoteIdentity,
  clearUserNoteReadOrder,
  enterNoteDenialOrder,
  isCurrentNoteReadOrder,
  noteIdentityIds,
} from "../src/lib/note-access-order.ts";

test("current identities share denial fencing without upgrading old tokens", () => {
  const user = "identity-order";
  bindNoteIdentity(user, "canonical", "short");
  const old = beginNoteReadOrder(user, "canonical");
  const denial = enterNoteDenialOrder(user, "short");
  assert.equal(isCurrentNoteReadOrder(user, "canonical", old), false);
  assert.equal(bindNoteIdentity(user, "canonical", "short", old), false);
  assert.equal(beginNoteReadOrder(user, "canonical"), denial);
  assert.equal(bindNoteIdentity(user, "canonical", "short", denial), true);
  assert.equal(beginNoteReadOrder("other-user", "canonical"), 0);
});

test("obsolete short IDs detach and clear still invalidates unknown IDs", () => {
  const user = "identity-replacement";
  bindNoteIdentity(user, "canonical", "old-short");
  bindNoteIdentity(user, "canonical", "new-short");
  enterNoteDenialOrder(user, "old-short");
  assert.equal(beginNoteReadOrder(user, "canonical"), 0);
  assert.deepEqual(noteIdentityIds(user, "old-short"), ["old-short"]);
  const unknown = beginNoteReadOrder(user, "unknown");
  clearUserNoteReadOrder(user);
  assert.equal(isCurrentNoteReadOrder(user, "unknown", unknown), false);
  assert.deepEqual(noteIdentityIds(user, "new-short"), ["new-short"]);
});

test("a newly discovered denial fences the original canonical request", () => {
  const user = "identity-discovery";
  const old = beginNoteReadOrder(user, "canonical");
  enterNoteDenialOrder(user, "short");
  assert.equal(bindNoteIdentity(user, "canonical", "short", old), false);
  assert.equal(isCurrentNoteReadOrder(user, "canonical", old), false);
});
