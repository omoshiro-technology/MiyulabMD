import type { FolderRecord } from "@miyulabmd/shared";
import { useEffect, useRef, useState } from "react";
import { useOutletContext, useParams } from "react-router";
import type { AppShellContext } from "../components/layout/AppShellContext.ts";
import { NoteTree } from "../components/notes/NoteTree.tsx";
import {
  type CachedDriveView as CachedDriveData,
  readCachedDrive,
} from "../lib/cached-drive-reader.ts";
import {
  readOfflineFolderDenial,
  readOfflineNoteDenial,
  subscribeOfflineCacheFolderDenial,
  subscribeOfflineCacheNoteDenial,
} from "../lib/offline-cache.ts";

const emptyView: CachedDriveData = {
  folder: null,
  folderCachedAt: null,
  folderMissing: true,
  notes: [],
  notesCachedAt: null,
  notesMissing: true,
};

export function CachedDriveView() {
  const { folderId } = useParams();
  const { setHeader, userLoading, viewer, viewing } =
    useOutletContext<AppShellContext>();
  const [view, setView] = useState(emptyView);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadRequest, setReloadRequest] = useState(0);
  const latestReloadRequest = useRef(reloadRequest);
  latestReloadRequest.current = reloadRequest;
  const cacheViewerId = viewer.cacheViewerId;
  const notesRef = useRef(view.notes);
  const viewRef = useRef(view);
  const reloadOwnerRef = useRef(0);

  useEffect(() => {
    setHeader(null);
    const scope = viewing.beginView(viewer);
    const controller = new AbortController();
    const requestOwner = reloadRequest;
    ++reloadOwnerRef.current;
    const isCurrentRequest = () =>
      !controller.signal.aborted &&
      scope.isCurrent() &&
      latestReloadRequest.current === requestOwner;
    setPending(true);
    setError(null);
    notesRef.current = [];
    viewRef.current = emptyView;
    setView(emptyView);
    if (userLoading || viewer.mode !== "cached" || cacheViewerId === null) {
      setPending(false);
      scope.dispose();
      return () => controller.abort();
    }
    void readCachedDrive(
      cacheViewerId,
      folderId ?? null,
      controller.signal,
      scope.isCurrent,
    )
      .then((next) => {
        if (isCurrentRequest()) {
          const published =
            !(next.folderMissing || next.notesMissing) &&
            scope.publish({
              source: "cache",
              viewer,
            });
          if (published || (!next.folderMissing && isCurrentRequest())) {
            notesRef.current = next.notes;
            viewRef.current = next;
            setView(next);
          }
        }
      })
      .catch(() => {
        if (isCurrentRequest()) {
          setError("キャッシュを読み込めませんでした。");
        }
      })
      .finally(() => {
        if (isCurrentRequest()) {
          setPending(false);
        }
      });
    return () => {
      controller.abort();
      scope.dispose();
    };
  }, [
    cacheViewerId,
    folderId,
    reloadRequest,
    setHeader,
    userLoading,
    viewer,
    viewing,
  ]);

  useEffect(() => {
    let active = true;
    const targetUserId = cacheViewerId;
    const unsubscribe = subscribeOfflineCacheFolderDenial((event) => {
      const relationIds = new Set<string | null>([
        folderId ?? null,
        viewRef.current.folder?.id ?? null,
        ...(viewRef.current.folder?.children ?? []).map((child) => child.id),
        ...(viewRef.current.folder?.crumbs ?? []).map((crumb) => crumb.id),
        ...notesRef.current.map((note) => note.folderId),
      ]);
      const relevant = event.resource.aliases.some((id) => relationIds.has(id));
      if (active && event.userId === targetUserId && relevant) {
        void readOfflineFolderDenial(event).then((denied) => {
          if (active && denied !== null) {
            setReloadRequest((value) => value + 1);
          } else if (active) {
            setError("キャッシュの状態を確認できませんでした。");
          }
        });
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [cacheViewerId, folderId]);

  useEffect(() => {
    if (cacheViewerId === null || viewer.mode !== "cached") {
      return;
    }
    let active = true;
    const unsubscribe = subscribeOfflineCacheNoteDenial((event) => {
      const receiptOwner = reloadOwnerRef.current;
      if (event.userId !== cacheViewerId || !active) {
        return;
      }
      const identities = event.resource.aliases.filter((alias) =>
        notesRef.current.some(
          (note) => note.id === alias || note.shortId === alias,
        ),
      );
      if (identities.length === 0) {
        return;
      }
      void readOfflineNoteDenial(event, identities).then((denied) => {
        if (
          denied !== false &&
          active &&
          receiptOwner === reloadOwnerRef.current &&
          cacheViewerId === event.userId
        ) {
          setReloadRequest((value) => value + 1);
        }
      });
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [cacheViewerId, viewer.mode]);

  const folder = view.folder;
  const children = (folder?.children ?? []) as FolderRecord[];
  const unavailable =
    !userLoading && (viewer.mode !== "cached" || viewer.cacheViewerId === null);
  return (
    <section>
      {error && <p>{error}</p>}
      {unavailable || (view.folderMissing && !pending) ? (
        <p>
          このフォルダはキャッシュに保存されていません。オンラインで開いてください。
        </p>
      ) : (
        <NoteTree
          childrenFolders={children}
          crumbs={folder?.crumbs ?? []}
          currentFolderId={folder?.id ?? null}
          isDriveRoot={!folderId || folder?.locked === true}
          listingIncomplete={view.notesMissing}
          notes={view.notes}
          onItemMenu={() => undefined}
          parentId={folder?.parentId ?? null}
          pending={pending}
          placeholder={pending}
          readonly={true}
          rootHref="/"
          showRootCrumb={true}
        />
      )}
      {!pending && view.notesMissing && !view.folderMissing && (
        <p>ノート一覧はキャッシュに保存されていません。</p>
      )}
    </section>
  );
}
