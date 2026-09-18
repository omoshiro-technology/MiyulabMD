import {
  collectTaskCheckboxes,
  type TaskCheckboxUpdate,
  taskContextHash,
} from "@miyulabmd/markdown";
import type * as Y from "yjs";
import { APPLY_EDIT_ORIGIN } from "./history-edit.ts";

/** Recheck after hashing, then validate and mutate without yielding to another edit. */
export async function applyTaskCheckbox(
  ytext: Y.Text,
  input: TaskCheckboxUpdate,
) {
  const current = ytext.toString();
  const task = collectTaskCheckboxes(current).find(
    (item) => item.line === input.line,
  );
  if (
    !task ||
    (await taskContextHash(current)) !== input.contextHash ||
    ytext.toString() !== current
  ) {
    return { ok: false as const };
  }
  const changed = task.checked !== input.checked;
  if (changed) {
    ytext.doc?.transact(() => {
      ytext.delete(task.offset, 1);
      ytext.insert(task.offset, input.checked ? "x" : " ");
    }, APPLY_EDIT_ORIGIN);
  }
  return {
    changed,
    checked: input.checked,
    offset: task.offset,
    ok: true as const,
  };
}
