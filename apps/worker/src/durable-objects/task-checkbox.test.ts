import assert from "node:assert/strict";
import { test } from "node:test";
import { taskContextHash } from "@miyulabmd/markdown";
import * as Y from "yjs";
import { applyTaskCheckbox } from "./task-checkbox.ts";

function document(markdown: string) {
  const doc = new Y.Doc();
  const text = doc.getText("markdown");
  text.insert(0, markdown);
  return { doc, text };
}

test("API changes exactly one character and synchronizes with an editor's pending text edits", async () => {
  const markdown = "# Title\n\n- [ ] hogehoge\n\nbody";
  const room = document(markdown);
  const editor = new Y.Doc();
  Y.applyUpdate(editor, Y.encodeStateAsUpdate(room.doc));
  editor.getText("markdown").insert(markdown.length, " edited");
  const updates: Uint8Array[] = [];
  room.doc.on("update", (update: Uint8Array) => updates.push(update));
  const result = await applyTaskCheckbox(room.text, {
    checked: true,
    contextHash: await taskContextHash(markdown),
    line: 3,
  });
  assert.equal(result.ok, true);
  assert.equal(updates.length, 1);
  assert.equal(room.text.toString(), markdown.replace("[ ]", "[x]"));
  for (const update of updates) {
    Y.applyUpdate(editor, update);
  }
  Y.applyUpdate(room.doc, Y.encodeStateAsUpdate(editor));
  assert.equal(
    room.text.toString(),
    `${markdown.replace("[ ]", "[x]")} edited`,
  );
  assert.equal(editor.getText("markdown").toString(), room.text.toString());
  room.doc.destroy();
  editor.destroy();
});

test("desired state is idempotent even when another viewer already checked it", async () => {
  const original = "- [ ] one\n- [ ] two";
  const { doc, text } = document(original);
  const contextHash = await taskContextHash(original);
  await applyTaskCheckbox(text, { checked: true, contextHash, line: 1 });
  const again = await applyTaskCheckbox(text, {
    checked: true,
    contextHash,
    line: 1,
  });
  assert.equal(again.ok && again.changed, false);
  await applyTaskCheckbox(text, { checked: true, contextHash, line: 2 });
  await applyTaskCheckbox(text, { checked: false, contextHash, line: 1 });
  assert.equal(text.toString(), "- [ ] one\n- [x] two");
  doc.destroy();
});

test("stale content, duplicate-line insertion, removed tasks and non-tasks fail without writes", async () => {
  const original = "- [ ] same\n- [ ] same\n\nbody";
  const contextHash = await taskContextHash(original);
  for (const markdown of [
    `- [ ] same\n${original}`,
    original.replace("body", "changed"),
    original.replaceAll("- [ ] same", "plain"),
  ]) {
    const { doc, text } = document(markdown);
    assert.deepEqual(
      await applyTaskCheckbox(text, { checked: true, contextHash, line: 2 }),
      { ok: false },
    );
    assert.equal(text.toString(), markdown);
    doc.destroy();
  }
  const { doc, text } = document(original);
  assert.deepEqual(
    await applyTaskCheckbox(text, { checked: true, contextHash, line: 4 }),
    { ok: false },
  );
  assert.equal(text.toString(), original);
  doc.destroy();
});

test("an editor update during asynchronous hashing cannot be overwritten", async () => {
  const original = "- [ ] original";
  const { doc, text } = document(original);
  const input = {
    checked: true,
    contextHash: await taskContextHash(original),
    line: 1,
  };
  const pending = applyTaskCheckbox(text, input);
  text.insert(0, "new line\n");
  assert.deepEqual(await pending, { ok: false });
  assert.equal(text.toString(), `new line\n${original}`);
  doc.destroy();
});
