import type { MedallionSet } from "@miyulabmd/shared";
import { medalForLayerIndex } from "@miyulabmd/shared";
import { useState } from "react";
import { Button } from "../ui/Button.tsx";
import { Field } from "../ui/Field.tsx";
import { Modal, ModalFooter, ModalHeader } from "../ui/Modal.tsx";
import { Select } from "../ui/Select.tsx";
import { ErrorText, MutedText } from "../ui/Text.tsx";

type Props = {
  busy?: boolean;
  /** The folder's own stored assignment (not inherited). */
  current?: { setId: string; layerKey: string } | null;
  error?: string | null;
  folderName: string;
  /** Effective assignment inherited from an ancestor (display-only). */
  inherited?: { assignedPath: string; layerLabel: string } | null;
  onClear: () => void;
  onClose: () => void;
  onSubmit: (setId: string, layerKey: string) => void;
  sets: MedallionSet[];
};

/**
 * §2.6 フォルダへのメダリオン層の割当ダイアログ。
 * 層は表示ラベルのみで、編集可否はノートの編集ロックが担う。
 * 割当は子フォルダ・ノートへ最寄祖先ルールで継承される。
 */
export function MedallionDialog({
  busy = false,
  current = null,
  error,
  folderName,
  inherited = null,
  onClear,
  onClose,
  onSubmit,
  sets,
}: Props) {
  const [setId, setSetId] = useState(current?.setId ?? sets[0]?.id ?? "");
  const set = sets.find((entry) => entry.id === setId) ?? sets[0];
  const [layerKey, setLayerKey] = useState(
    current?.layerKey ?? set?.layers[0]?.key ?? "",
  );

  function close() {
    if (!busy) {
      onClose();
    }
  }

  function changeSet(nextSetId: string) {
    setSetId(nextSetId);
    const next = sets.find((entry) => entry.id === nextSetId);
    if (next && !next.layers.some((layer) => layer.key === layerKey)) {
      setLayerKey(next.layers[0]?.key ?? "");
    }
  }

  return (
    <Modal
      as="form"
      className="w-[min(26rem,100%)]"
      labelledBy="medallion-dialog-title"
      onClose={close}
      onSubmit={(event) => {
        event.preventDefault();
        if (setId && layerKey) {
          onSubmit(setId, layerKey);
        }
      }}
    >
      <ModalHeader
        id="medallion-dialog-title"
        onClose={close}
        title={`メダリオン層 — ${folderName}`}
      />
      {sets.length === 0 ? (
        <MutedText>
          層セットがありません。設定の「メダリオン層」ページで作成してください。
        </MutedText>
      ) : (
        <>
          <Field label="層セット">
            <Select
              aria-label="層セット"
              className="w-full rounded-md px-2 py-1.5"
              disabled={busy}
              onChange={(event) => changeSet(event.target.value)}
              value={setId}
            >
              {sets.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="層">
            <Select
              aria-label="層"
              className="w-full rounded-md px-2 py-1.5"
              disabled={busy || !set}
              onChange={(event) => setLayerKey(event.target.value)}
              value={layerKey}
            >
              {(set?.layers ?? []).map((layer, index) => (
                <option key={layer.key} value={layer.key}>
                  {medalForLayerIndex(index)} {layer.label}
                </option>
              ))}
            </Select>
          </Field>
        </>
      )}
      {inherited && !current && (
        <MutedText className="text-xs">
          現在は「{inherited.assignedPath}」から {inherited.layerLabel}
          を継承しています。
        </MutedText>
      )}
      <MutedText className="text-xs">
        層は表示ラベルです。編集可否はノートごとの編集ロックで管理します。割当は配下のフォルダとノートに継承されます。
      </MutedText>
      {error && <ErrorText>{error}</ErrorText>}
      <ModalFooter>
        {current && (
          <Button disabled={busy} onClick={onClear} variant="ghost">
            割当を解除
          </Button>
        )}
        <Button disabled={busy} onClick={close} variant="ghost">
          キャンセル
        </Button>
        <Button
          disabled={busy || !(setId && layerKey)}
          type="submit"
          variant="accent"
        >
          {busy ? "保存中…" : "割り当て"}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
