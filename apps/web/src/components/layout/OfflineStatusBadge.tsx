import { useRef, useState } from "react";
import { useDismiss } from "../../hooks/use-dismiss.ts";
import { cn } from "../../lib/cn.ts";
import { readLastLiveSyncAt } from "../../lib/viewer-context.ts";
import { GlobeOffIcon } from "../ui/icons.tsx";

/**
 * ヘッダーのオフライン表示。サーバーと疎通できない状態（表示キャッシュ
 * フォールバック）でのみ描画される。PC はホバー、モバイルはタップで
 * 最終同期時刻をポップアップ表示する。
 */
export function OfflineStatusBadge() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  useDismiss(open, () => setOpen(false), rootRef);
  const lastSyncAt = readLastLiveSyncAt();

  return (
    <span className="group relative flex items-center" ref={rootRef}>
      <button
        aria-expanded={open}
        aria-label="オフライン"
        className="flex cursor-pointer items-center border-0 bg-transparent p-1 text-muted"
        onClick={() => setOpen((value) => !value)}
        title="オフライン"
        type="button"
      >
        <GlobeOffIcon />
      </button>
      <span
        className={cn(
          "absolute top-[calc(100%+0.45rem)] left-0 z-40 whitespace-nowrap rounded-xl border border-border bg-canvas px-3 py-2 text-xs shadow-menu group-hover:block",
          open ? "block" : "hidden",
        )}
        role="status"
      >
        オフライン
        {lastSyncAt === null
          ? ""
          : ` · 最終同期 ${new Date(lastSyncAt).toLocaleString("ja-JP")}`}
      </span>
    </span>
  );
}
