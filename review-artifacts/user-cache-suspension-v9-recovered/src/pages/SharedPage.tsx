import type { FolderRecord, NoteSummary } from "@miyulabmd/shared";
import { folderUrl } from "@miyulabmd/shared";
import { type MouseEvent, useEffect, useState } from "react";
import { useNavigate, useOutletContext } from "react-router";
import type { AppShellContext } from "../components/layout/AppShellContext.ts";
import { AccessScopeMeta } from "../components/notes/AccessScopeMeta.tsx";
import {
  ContextMenu,
  type ContextMenuItem,
} from "../components/notes/ContextMenu.tsx";
import { DrivePlaceNav } from "../components/notes/DrivePlaceNav.tsx";
import { DriveList, DriveRow } from "../components/ui/DriveList.tsx";
import { FolderIcon, MarkdownIcon } from "../components/ui/icons.tsx";
import { ErrorText } from "../components/ui/Text.tsx";
import { fetchSharedFolders } from "../lib/api.ts";
import { sharedNotesForUser } from "../lib/drive-items.ts";
import { loadNotes, peekNotes, prefetchFolder } from "../lib/list-cache.ts";
import { prefetchNote } from "../lib/note-cache.ts";

type MenuState = {
  id: string;
  x: number;
  y: number;
  items: ContextMenuItem[];
};

export function SharedPage() {
  const navigate = useNavigate();
  const { user, userLoading, setHeader } = useOutletContext<AppShellContext>();
  const [notes, setNotes] = useState<NoteSummary[]>(() => peekNotes() ?? []);
  const [folders, setFolders] = useState<FolderRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);

  useEffect(() => {
    setHeader({
      actions: user ? <DrivePlaceNav current="shared" /> : null,
      folder: null,
    });
    return () => setHeader(null);
  }, [setHeader, user]);

  useEffect(() => {
    if (userLoading) {
      return;
    }
    if (!user) {
      navigate("/", { replace: true });
      return;
    }

    const controller = new AbortController();
    setPending(true);
    setError(null);
    void Promise.all([
      loadNotes(true),
      fetchSharedFolders({ signal: controller.signal, viewerId: user.id }),
    ]).then(([noteList, folderResult]) => {
      if (controller.signal.aborted) {
        return;
      }
      setPending(false);
      setNotes(noteList);
      if (!folderResult.ok) {
        setError(folderResult.error);
        return;
      }
      setFolders(folderResult.data);
    });

    return () => controller.abort();
  }, [user, userLoading, navigate]);

  if (!user) {
    return null;
  }

  const sharedNotes = sharedNotesForUser(notes, user.id);
  const empty = folders.length === 0 && sharedNotes.length === 0;

  function menuPosition(event: MouseEvent) {
    const target = event.currentTarget;
    if (target instanceof HTMLButtonElement) {
      const rect = target.getBoundingClientRect();
      return {
        x: Math.min(rect.right - 10, window.innerWidth - 180),
        y: rect.bottom + 4,
      };
    }
    return {
      x: Math.min(event.clientX, window.innerWidth - 180),
      y: Math.min(event.clientY, window.innerHeight - 160),
    };
  }

  function openFolderMenu(event: MouseEvent, folder: FolderRecord) {
    event.preventDefault();
    event.stopPropagation();
    const position = menuPosition(event);
    const items: ContextMenuItem[] = [
      { label: "開く", onSelect: () => navigate(folderUrl(folder.id)) },
    ];
    setMenu({ id: folder.id, ...position, items });
  }

  function openNoteMenu(event: MouseEvent, note: NoteSummary) {
    event.preventDefault();
    event.stopPropagation();
    const position = menuPosition(event);
    const items: ContextMenuItem[] = [
      { label: "開く", onSelect: () => navigate(`/n/${note.id}`) },
    ];
    setMenu({ id: note.id, ...position, items });
  }

  return (
    <section>
      {error && <ErrorText>{error}</ErrorText>}
      {empty && !pending ? (
        <p>共有されているアイテムはありません。</p>
      ) : (
        <DriveList
          className={
            pending ? "opacity-60 transition-opacity duration-150" : undefined
          }
        >
          {folders.map((folder) => (
            <DriveRow
              href={folderUrl(folder.id)}
              icon={<FolderIcon />}
              key={folder.id}
              menuOpen={menu?.id === folder.id}
              meta={
                folder.readScope && folder.writeScope ? (
                  <AccessScopeMeta
                    readScope={folder.readScope}
                    writeScope={folder.writeScope}
                  />
                ) : undefined
              }
              name={folder.name}
              onMenu={(event) => openFolderMenu(event, folder)}
              onPointerEnter={() => prefetchFolder(folder.id)}
            />
          ))}
          {sharedNotes.map((note) => (
            <DriveRow
              href={`/n/${note.id}`}
              icon={<MarkdownIcon />}
              key={note.id}
              menuOpen={menu?.id === note.id}
              meta={
                <AccessScopeMeta
                  readScope={note.access.effectiveReadScope}
                  writeScope={note.access.effectiveWriteScope}
                />
              }
              name={note.title}
              onMenu={(event) => openNoteMenu(event, note)}
              onPointerEnter={() => prefetchNote(note.id)}
            />
          ))}
        </DriveList>
      )}
      {menu && (
        <ContextMenu
          items={menu.items}
          onClose={() => setMenu(null)}
          x={menu.x}
          y={menu.y}
        />
      )}
    </section>
  );
}
