import { useState } from "react";
import { syncEditCacheDocs } from "../../lib/edit-cache-sync.ts";
import { Button } from "../ui/Button.tsx";
import { Modal, ModalFooter, ModalHeader } from "../ui/Modal.tsx";
import { ErrorText } from "../ui/Text.tsx";

/**
 * purge ガードモーダル（specs/offline-mode.html）。
 * ログアウト/アカウント切替で未送信の可能性がある編集キャッシュ doc が
 * 残っているときに出す。選択肢は3つ:
 *   1. 同期してから実行 — サーバーへ送り切ってから purge
 *   2. 編集を破棄して実行 — ローカル doc ごと捨てる
 *   3. キャンセル — purge しない
 */
export function UnsentEditsGuardModal({
  input,
  onResolve,
}: {
  input: { noteIds: string[]; reason: "logout" | "switch"; userId: string };
  onResolve: (proceed: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const action = input.reason === "logout" ? "ログアウト" : "キャッシュの削除";

  const syncThenProceed = async () => {
    setBusy(true);
    setError(null);
    try {
      const { failed } = await syncEditCacheDocs(input.userId, input.noteIds);
      if (failed.length > 0) {
        setError(
          "同期できませんでした。オンラインになってからやり直すか、「編集を破棄して実行」を選んでください。",
        );
        return;
      }
      onResolve(true);
    } catch {
      setError(
        "同期できませんでした。オンラインになってからやり直すか、「編集を破棄して実行」を選んでください。",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      className="w-[min(28rem,100%)]"
      labelledBy="unsent-edits-guard-title"
      onClose={() => {
        if (!busy) {
          onResolve(false);
        }
      }}
    >
      <ModalHeader
        id="unsent-edits-guard-title"
        title="未送信のオフライン編集があります"
      />
      <p className="mb-2 mt-0">
        この端末にはサーバーへ送信済みか確認できない編集が{" "}
        {input.noteIds.length} 件残っています。このまま{action}
        するとローカルの編集は失われます。
      </p>
      <ul className="mb-4 mt-0 max-h-40 overflow-auto pl-5 text-[0.8rem] text-muted">
        {input.noteIds.map((id) => (
          <li key={id}>
            <code>{id}</code>
          </li>
        ))}
      </ul>
      {error && <ErrorText>{error}</ErrorText>}
      <ModalFooter>
        <Button
          disabled={busy}
          onClick={() => onResolve(false)}
          variant="ghost"
        >
          キャンセル
        </Button>
        <Button
          disabled={busy}
          onClick={() => onResolve(true)}
          variant="danger"
        >
          編集を破棄して実行
        </Button>
        <Button disabled={busy} onClick={syncThenProceed} variant="accent">
          {busy ? "同期中…" : "同期してから実行"}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
