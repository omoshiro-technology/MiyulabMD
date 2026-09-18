import { folderUrl } from "@miyulabmd/shared";
import { useRef, useState } from "react";
import { Link } from "react-router";
import { useDismiss } from "../../hooks/use-dismiss.ts";
import { HeaderButton } from "../ui/HeaderButton.tsx";
import { Input } from "../ui/Input.tsx";
import { FolderOutlineIcon } from "../ui/icons.tsx";
import { MenuPanel } from "../ui/Menu.tsx";
import { MutedText } from "../ui/Text.tsx";

type Props = {
  folder: string;
  folderId: string | null;
  isOwner: boolean;
  onFolderChange: (value: string) => void;
  onFolderBlur: () => void;
};

/**
 * フォルダパネルの中身。「⋯ ノート」メニューのサブビューからも再利用する
 * （specs/knowledge-management.html §3.1: メニュー項目から現行パネルを開く）。
 */
export function FolderPanelFields({
  folder,
  folderId,
  isOwner,
  onFolderChange,
  onFolderBlur,
}: Props) {
  return (
    <div className="grid gap-2 px-3 py-2">
      {isOwner && (
        <>
          <Input
            aria-label="ノートのフォルダ"
            className="w-full"
            onBlur={onFolderBlur}
            onChange={(event) => onFolderChange(event.target.value)}
            placeholder="例: work/infra"
            type="text"
            value={folder}
            variant="pill"
          />
          {folderId && (
            <Link className="text-accent no-underline" to={folderUrl(folderId)}>
              開く
            </Link>
          )}
        </>
      )}
      {!isOwner && folderId && (
        <Link className="text-accent no-underline" to={folderUrl(folderId)}>
          フォルダを開く
        </Link>
      )}
      {!(isOwner || folderId) && <MutedText>なし</MutedText>}
    </div>
  );
}

export function FolderPopover(props: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), rootRef);

  return (
    <div className="relative" ref={rootRef}>
      <HeaderButton
        aria-expanded={open}
        aria-haspopup="dialog"
        icon={<FolderOutlineIcon />}
        label="フォルダ"
        onClick={() => setOpen((value) => !value)}
        variant="outline"
      />
      {open && (
        <MenuPanel role="dialog" width="16rem">
          <FolderPanelFields {...props} />
        </MenuPanel>
      )}
    </div>
  );
}
