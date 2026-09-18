import { useState } from "react";
import {
  readTabHintDismissed,
  readTabKeyMode,
  writeTabHintDismissed,
} from "../../lib/editor-tab.ts";
import { IconButton } from "../ui/IconButton.tsx";
import { CloseIcon } from "../ui/icons.tsx";

// One-time keyboard hint: while Tab is bound to indentation it would
// otherwise trap keyboard focus, so the escape route must be discoverable.
export function TabIndentHint() {
  const [visible, setVisible] = useState(
    () => readTabKeyMode() === "indent" && !readTabHintDismissed(),
  );
  if (!visible) {
    return null;
  }
  return (
    <p
      className="m-0 flex items-center justify-between gap-3 border-b border-border bg-fill px-5 py-1.5 text-[0.85rem] text-muted"
      role="note"
    >
      <span>
        Tab でインデントを挿入します。フォーカスを外す: Esc → Tab、または
        Ctrl-M。
      </span>
      <IconButton
        aria-label="閉じる"
        onClick={() => {
          writeTabHintDismissed();
          setVisible(false);
        }}
        size="sm"
      >
        <CloseIcon />
      </IconButton>
    </p>
  );
}
