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
  readonly?: boolean;
  listingIncomplete?: boolean;
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
          className="flex min-h-12 items-center gap-[0.7rem] border-b border-border px-[0.9rem] py-[0.55rem] last:border-b-0"
          key={index}
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
  readonly = false,
  listingIncomplete = false,
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
        aria-label="フォルダ"
        className="mb-3 flex flex-wrap items-center gap-[0.15rem] text-[0.9rem]"
      >
        {showRootCrumb && (
          <Link
            className={cn(
              "border-0 bg-transparent p-0 font-inherit text-inherit no-underline",
              isDriveRoot ? "cursor-default text-muted" : "cursor-pointer",
            )}
            onPointerEnter={() => {
              if (!readonly) {
                prefetchFolder();
              }
            }}
            to="/"
          >
            {MY_DRIVE_NAME}
          </Link>
        )}
        {crumbs.map((crumb, index) => {
          const current = index === crumbs.length - 1;
          return (
            <span key={crumb.id}>
              {(showRootCrumb || index > 0) && (
                <span aria-hidden={true}> / </span>
              )}
              <Link
                className={cn(
                  "border-0 bg-transparent p-0 font-inherit text-inherit no-underline",
                  current ? "cursor-default text-muted" : "cursor-pointer",
                )}
                onContextMenu={
                  readonly
                    ? undefined
                    : (event) =>
                        handleRowMenu(event, {
                          id: crumb.id,
                          kind: "folder",
                          name: crumb.name,
                        })
                }
                onPointerEnter={() => {
                  if (!readonly) {
                    prefetchFolder(crumb.id);
                  }
                }}
                to={folderUrl(crumb.id)}
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
          onPointerEnter={() => {
            if (parentId && !readonly) {
              prefetchFolder(parentId);
            }
          }}
          to={parentId ? folderUrl(parentId) : rootHref}
        >
          上のフォルダへ
        </Link>
      )}

      {placeholder && <ListSkeleton />}
      {!(placeholder || listingIncomplete) &&
        folders.length === 0 &&
        items.length === 0 && <p>このフォルダは空です。</p>}
      {!placeholder && (folders.length > 0 || items.length > 0) && (
        <DriveList
          className={cn(
            pending && "opacity-60 transition-opacity duration-150",
          )}
        >
          {folders.map((folder) => {
            const target = {
              id: folder.id,
              kind: "folder" as const,
              name: folder.name,
            };
            return (
              <DriveRow
                href={folderUrl(folder.id)}
                icon={<FolderIcon />}
                key={folder.id}
                menuOpen={openMenuId === folder.id}
                meta={
                  folder.readScope && folder.writeScope ? (
                    <AccessScopeMeta
                      readScope={folder.readScope}
                      writeScope={folder.writeScope}
                    />
                  ) : undefined
                }
                name={folder.name}
                onMenu={
                  readonly ? undefined : (event) => handleRowMenu(event, target)
                }
                onPointerEnter={() => {
                  if (!readonly) {
                    prefetchFolder(folder.id);
                  }
                }}
                readonly={readonly}
              />
            );
          })}
          {items.map((note) => {
            const target = { kind: "note" as const, note };
            return (
              <DriveRow
                href={`/n/${note.id}`}
                icon={<MarkdownIcon />}
                key={note.id}
                menuOpen={openMenuId === note.id}
                meta={
                  <AccessScopeMeta
                    readScope={note.access.effectiveReadScope}
                    writeScope={note.access.effectiveWriteScope}
                  />
                }
                name={note.title}
                onMenu={
                  readonly ? undefined : (event) => handleRowMenu(event, target)
                }
                onPointerEnter={() => {
                  if (!readonly) {
                    prefetchNote(note.id);
                  }
                }}
                readonly={readonly}
              />
            );
          })}
        </DriveList>
      )}
    </div>
  );
}
