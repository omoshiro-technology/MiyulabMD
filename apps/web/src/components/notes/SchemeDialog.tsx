import { NAMING_SCHEME_LABELS, NAMING_SCHEMES } from "@miyulabmd/shared";
import { useState } from "react";
import { Button } from "../ui/Button.tsx";
import { Field } from "../ui/Field.tsx";
import { Modal, ModalFooter, ModalHeader } from "../ui/Modal.tsx";
import { Select } from "../ui/Select.tsx";
import { ErrorText, MutedText } from "../ui/Text.tsx";

type Props = {
  busy?: boolean;
  current?: string | null;
  error?: string | null;
  folderName: string;
  onClose: () => void;
  onSubmit: (scheme: string | null) => void;
};

export function SchemeDialog({
  busy = false,
  current = null,
  error,
  folderName,
  onClose,
  onSubmit,
}: Props) {
  const [scheme, setScheme] = useState(current ?? "");

  function close() {
    if (!busy) {
      onClose();
    }
  }

  return (
    <Modal
      as="form"
      className="w-[min(26rem,100%)]"
      labelledBy="scheme-dialog-title"
      onClose={close}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(scheme === "" ? null : scheme);
      }}
    >
      <ModalHeader
        id="scheme-dialog-title"
        onClose={close}
        title={`命名規則 — ${folderName}`}
      />
      <Field label="このフォルダ直下の命名規則">
        <Select
          aria-label="命名規則"
          className="w-full rounded-md px-2 py-1.5"
          disabled={busy}
          onChange={(event) => setScheme(event.target.value)}
          value={scheme}
        >
          <option value="">なし（自由に命名）</option>
          {NAMING_SCHEMES.map((key) => (
            <option key={key} value={key}>
              {NAMING_SCHEME_LABELS[key]}
            </option>
          ))}
        </Select>
      </Field>
      <MutedText className="text-xs">
        規則は新しく作る子フォルダとノートだけに適用されます。既存の名前は変わりません。
      </MutedText>
      {error && <ErrorText>{error}</ErrorText>}
      <ModalFooter>
        <Button disabled={busy} onClick={close} variant="ghost">
          キャンセル
        </Button>
        <Button disabled={busy} type="submit" variant="accent">
          {busy ? "保存中…" : "保存"}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
