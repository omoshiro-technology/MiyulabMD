import type {
  MedallionResolution,
  Note,
  NoteSummary,
  SessionUser,
} from "@miyulabmd/shared";
import { type ReactNode, useRef, useState } from "react";
import { useDismiss } from "../../hooks/use-dismiss.ts";
import type { CollabAwareness } from "../../lib/collaboration.ts";
import {
  folderMenuContext,
  lockMenuContext,
  menuItemTierClass,
} from "../../lib/editor-header.ts";
import { SitePublishMenuItem } from "../layout/SitePublishButton.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import {
  ChevronDownIcon,
  FolderOutlineIcon,
  HistoryIcon,
  LinkIcon,
  LockIcon,
  MoreIcon,
  SearchIcon,
} from "../ui/icons.tsx";
import { MenuItem, MenuPanel, MenuRow, MenuSeparator } from "../ui/Menu.tsx";
import { MutedText } from "../ui/Text.tsx";
import { EditLockPanel } from "./EditLockPanel.tsx";
import { FolderPanelFields } from "./FolderPopover.tsx";
import { useAwarenessPeers } from "./PresenceBar.tsx";

type MenuView = "menu" | "folder" | "lock";

type Props = {
  awareness: CollabAwareness | undefined;
  folder: string;
  folderId: string | null;
  isOwner: boolean;
  /** Effective (nearest-ancestor) medallion for the note's folder, if any. */
  medallion?: MedallionResolution | null;
  note: Note;
  user: SessionUser | null;
  onFolderBlur: () => void;
  onFolderChange: (folder: string) => void;
  onHistory: () => void;
  onLinks: () => void;
  onNoteChange: (note: NoteSummary) => void;
  onSearch?: () => void;
};

function MenuItemLabel({
  icon,
  label,
  context,
  hasSubview,
}: {
  icon: ReactNode;
  label: string;
  context?: string;
  hasSubview?: boolean;
}) {
  return (
    <span className="flex items-center gap-2">
      {icon}
      <span>{label}</span>
      {context && (
        <span className="ml-auto max-w-28 truncate pl-3 text-[0.75rem] text-muted">
          {context}
        </span>
      )}
      {hasSubview && <ChevronDownIcon className="-rotate-90 opacity-60" />}
    </span>
  );
}

/**
 * 「⋯ ノート」オーバーフローメニュー（specs/knowledge-management.html §3.1）。
 * フォルダ / リンク / 履歴 / 編集ロックを集約し、幅に応じて検索・サイト更新・
 * presence 情報行が退避してくる。フォルダと編集ロックはパネル内サブビューで
 * 既存のポップオーバー内容をそのまま開く。
 */
export function EditorOverflowMenu({
  awareness,
  folder,
  folderId,
  isOwner,
  medallion,
  note,
  user,
  onFolderBlur,
  onFolderChange,
  onHistory,
  onLinks,
  onNoteChange,
  onSearch,
}: Props) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<MenuView>("menu");
  const rootRef = useRef<HTMLDivElement>(null);
  const peers = useAwarenessPeers(awareness);
  useDismiss(
    open,
    () => {
      setOpen(false);
      setView("menu");
    },
    rootRef,
  );

  function close() {
    setOpen(false);
    setView("menu");
  }

  return (
    <div className="relative" ref={rootRef}>
      <IconButton
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="ノートメニュー"
        onClick={() => setOpen((value) => !value)}
        title="ノート"
        variant="ghost"
      >
        <MoreIcon />
      </IconButton>
      {open && (
        <MenuPanel role={view === "menu" ? "menu" : "dialog"} width="15rem">
          {view === "menu" && (
            <>
              {onSearch && (
                <MenuItem
                  className={menuItemTierClass("search")}
                  onClick={() => {
                    close();
                    onSearch();
                  }}
                >
                  <MenuItemLabel icon={<SearchIcon />} label="検索" />
                </MenuItem>
              )}
              <MenuItem onClick={() => setView("folder")}>
                <MenuItemLabel
                  context={folderMenuContext(folder)}
                  hasSubview={true}
                  icon={<FolderOutlineIcon />}
                  label="フォルダ"
                />
              </MenuItem>
              <MenuItem
                onClick={() => {
                  close();
                  onLinks();
                }}
              >
                <MenuItemLabel icon={<LinkIcon />} label="リンク" />
              </MenuItem>
              <MenuItem
                onClick={() => {
                  close();
                  onHistory();
                }}
              >
                <MenuItemLabel icon={<HistoryIcon />} label="履歴" />
              </MenuItem>
              <MenuItem onClick={() => setView("lock")}>
                <MenuItemLabel
                  context={lockMenuContext(note, medallion)}
                  hasSubview={true}
                  icon={<LockIcon />}
                  label="編集ロック"
                />
              </MenuItem>
              <div className={menuItemTierClass("siteUpdate")}>
                <SitePublishMenuItem folder={folder} user={user} />
              </div>
              {peers.length > 0 && (
                <div className={menuItemTierClass("presence")}>
                  <MenuSeparator />
                  <MenuRow>
                    <MutedText>共同編集中: {peers.length}人</MutedText>
                  </MenuRow>
                </div>
              )}
            </>
          )}
          {view === "folder" && (
            <>
              <MenuItem onClick={() => setView("menu")}>
                <MenuItemLabel
                  icon={<ChevronDownIcon className="rotate-90" />}
                  label="ノート"
                />
              </MenuItem>
              <MenuSeparator />
              <FolderPanelFields
                folder={folder}
                folderId={folderId}
                isOwner={isOwner && !note.editLocked}
                onFolderBlur={onFolderBlur}
                onFolderChange={onFolderChange}
              />
            </>
          )}
          {view === "lock" && (
            <>
              <MenuItem onClick={() => setView("menu")}>
                <MenuItemLabel
                  icon={<ChevronDownIcon className="rotate-90" />}
                  label="ノート"
                />
              </MenuItem>
              <MenuSeparator />
              <EditLockPanel
                isOwner={isOwner}
                note={note}
                onChanged={onNoteChange}
              />
            </>
          )}
        </MenuPanel>
      )}
    </div>
  );
}
