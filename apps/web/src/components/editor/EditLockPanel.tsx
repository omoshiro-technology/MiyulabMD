import type { Note, NoteSummary } from "@miyulabmd/shared";
import { useState } from "react";
import { setNoteEditLock } from "../../lib/api.ts";
import { Button } from "../ui/Button.tsx";
import { LockIcon, LockOpenIcon } from "../ui/icons.tsx";
import { ErrorText, MutedText } from "../ui/Text.tsx";

type Props = {
  isOwner: boolean;
  note: Note;
  onChanged: (note: NoteSummary) => void;
};

/**
 * §2.6 編集ロックパネル。「⋯ ノート」メニューの「編集ロック」サブビュー
 * （specs/knowledge-management.html §3.1）から開く。
 *
 * ロックは永続的で、解除はこのパネルの明示操作のみ。ロック中は本文・
 * フォルダ移動・共有・削除のすべてが拒否される（閲覧と解除だけが可能）。
 * メダリオン層はフォルダの表示ラベルであり、ここでは扱わない。
 */
export function EditLockPanel({ isOwner, note, onChanged }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The lock route requires admin rights (owner or full-access share).
  const canToggle = isOwner || note.access.flags.canAdmin === true;

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      const result = await setNoteEditLock(note.id, !note.editLocked);
      if (result.ok) {
        onChanged(result.note);
      } else {
        setError(result.error ?? "操作に失敗しました");
      }
    } catch {
      setError("通信に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-2 px-3 py-2">
      <p className="m-0 text-[0.85rem] font-medium">
        編集ロック
        {note.editLocked && (
          <span className="ml-2 text-[0.75rem] font-normal text-muted">
            ロック中
          </span>
        )}
      </p>
      {!canToggle && <MutedText>閲覧のみ</MutedText>}
      {canToggle &&
        (note.editLocked ? (
          <Button
            className="w-full"
            disabled={busy}
            onClick={() => void toggle()}
            type="button"
            variant="accent"
          >
            <LockOpenIcon />
            ロックを解除
          </Button>
        ) : (
          <Button
            className="w-full"
            disabled={busy}
            onClick={() => void toggle()}
            type="button"
          >
            <LockIcon />
            編集をロック
          </Button>
        ))}
      {note.editLocked ? (
        <MutedText>
          ロック中は本文・フォルダ・共有の変更と削除ができません。解除するまで誰も編集できません。
        </MutedText>
      ) : (
        <MutedText>
          ロックすると解除するまで誰も編集できません（自分を含む）。
        </MutedText>
      )}
      {error && <ErrorText>{error}</ErrorText>}
    </div>
  );
}
