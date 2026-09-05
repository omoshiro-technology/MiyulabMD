import type { FolderCrumb, FolderRecord, NoteSummary } from "@miyulabmd/shared";
import { folderUrl, MY_DRIVE_NAME, SHARED_PATH } from "@miyulabmd/shared";
import type { MouseEvent } from "react";
import { Link } from "react-router";
import { cn } from "../../lib/cn.ts";
import { prefetchFolder } from "../../lib/list-cache.ts";
import { prefetchNote } from "../../lib/note-cache.ts";
import { DriveList, DriveRow } from "../ui/DriveList.tsx";
import { FolderIcon, MarkdownIcon } from "../ui/icons.tsx";
import { AccessScopeMeta } from "./AccessScopeMeta.tsx";

type Props = {
  notes: NoteSummary[];
  currentFolderId: string | null;
  crumbs: FolderCrumb[];
  parentId: string | null;
  childrenFolders: FolderRecord[];
  showRootCrumb?: boolean;
  isDriveRoot?: boolean;
  showAllNotes?: boolean;
  rootHref?: string;
  openMenuId?: string | null;
  pending?: boolean;
  placeholder?: boolean;
  onItemMenu: (event: MouseEvent, target: MenuTarget) => void;
};

export type MenuTarget =
  | { kind: "folder"; id: string; name: string }
  | { kind: "note"; note: NoteSummary };

function notesInFolder(
  notes: NoteSummary[],
  currentFolderId: string | null,
): NoteSummary[] {
  return notes
    .filter((note) => (note.folderId ?? null) === currentFolderId)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function ListSkeleton() {
  return (
    <DriveList>
      {[0, 1, 2].map((index) => (
        <li
          key={index}
          className="flex min-h-12 items-center gap-[0.7rem] border-b border-border px-[0.9rem] py-[0.55rem] last:border-b-0"
        >
          <div className="size-[22px] shrink-0 animate-pulse rounded bg-surface" />
          <div className="h-4 max-w-[12rem] flex-1 animate-pulse rounded bg-surface" />
        </li>
      ))}
    </DriveList>
  );
}

export function NoteTree({
  notes,
  currentFolderId,
  crumbs,
  parentId,
  childrenFolders,
  showRootCrumb = false,
  isDriveRoot = false,
  showAllNotes = false,
  rootHref = SHARED_PATH,
  openMenuId = null,
  pending = false,
  placeholder = false,
  onItemMenu,
}: Props) {
  const items = showAllNotes
    ? [...notes].sort((a, b) => b.updatedAt - a.updatedAt)
    : notesInFolder(notes, currentFolderId);
  const folders = [...childrenFolders].sort((a, b) =>
    a.name.localeCompare(b.name, "ja"),
  );

  function handleRowMenu(event: MouseEvent, target: MenuTarget) {
    event.preventDefault();
    event.stopPropagation();
    onItemMenu(event, target);
  }

  return (
    <div>
      <nav
        className="mb-3 flex flex-wrap items-center gap-[0.15rem] text-[0.9rem]"
        aria-label="フォルダ"
      >
        {showRootCrumb && (
          <Link
            to="/"
            className={cn(
              "border-0 bg-transparent p-0 font-inherit text-inherit no-underline",
              isDriveRoot ? "cursor-default text-muted" : "cursor-pointer",
            )}
            onPointerEnter={() => prefetchFolder()}
          >
            {MY_DRIVE_NAME}
          </Link>
        )}
        {crumbs.map((crumb, index) => {
          const current = index === crumbs.length - 1;
          return (
            <span key={crumb.id}>
              {(showRootCrumb || index > 0) && <span aria-hidden> / </span>}
              <Link
                to={folderUrl(crumb.id)}
                className={cn(
                  "border-0 bg-transparent p-0 font-inherit text-inherit no-underline",
                  current ? "cursor-default text-muted" : "cursor-pointer",
                )}
                onPointerEnter={() => prefetchFolder(crumb.id)}
                onContextMenu={(event) =>
                  handleRowMenu(event, {
                    kind: "folder",
                    id: crumb.id,
                    name: crumb.name,
                  })
                }
              >
                {crumb.name}
              </Link>
            </span>
          );
        })}
      </nav>

      {currentFolderId && !isDriveRoot && (
        <Link
          className="mb-3 block border-0 bg-transparent p-0 font-inherit text-accent no-underline"
          to={parentId ? folderUrl(parentId) : rootHref}
          onPointerEnter={() => {
            if (parentId) prefetchFolder(parentId);
          }}
        >
          上のフォルダへ
        </Link>
      )}

      {placeholder ? (
        <ListSkeleton />
      ) : folders.length === 0 && items.length === 0 ? (
        <p>このフォルダは空です。</p>
      ) : (
        <DriveList
          className={cn(
            pending && "opacity-60 transition-opacity duration-150",
          )}
        >
          {folders.map((folder) => {
            const target = {
              kind: "folder" as const,
              id: folder.id,
              name: folder.name,
            };
            return (
              <DriveRow
                key={folder.id}
                href={folderUrl(folder.id)}
                name={folder.name}
                icon={<FolderIcon />}
                meta={
                  folder.readScope && folder.writeScope ? (
                    <AccessScopeMeta
                      readScope={folder.readScope}
                      writeScope={folder.writeScope}
                    />
                  ) : undefined
                }
                menuOpen={openMenuId === folder.id}
                onMenu={(event) => handleRowMenu(event, target)}
                onPointerEnter={() => prefetchFolder(folder.id)}
              />
            );
          })}
          {items.map((note) => {
            const target = { kind: "note" as const, note };
            return (
              <DriveRow
                key={note.id}
                href={`/n/${note.id}`}
                name={note.title}
                icon={<MarkdownIcon />}
                meta={
                  <AccessScopeMeta
                    readScope={note.access.effectiveReadScope}
                    writeScope={note.access.effectiveWriteScope}
                  />
                }
                menuOpen={openMenuId === note.id}
                onMenu={(event) => handleRowMenu(event, target)}
                onPointerEnter={() => prefetchNote(note.id)}
              />
            );
          })}
        </DriveList>
      )}
    </div>
  );
}
