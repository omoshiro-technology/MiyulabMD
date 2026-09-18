import { titleFromMarkdown } from "@miyulabmd/shared";
import { useEffect, useLayoutEffect, useState } from "react";
import { Link, useOutletContext, useParams } from "react-router";
import { PreviewWithToc } from "../components/editor/PreviewWithToc.tsx";
import type { AppShellContext } from "../components/layout/AppShellContext.ts";
import { ErrorText } from "../components/ui/Text.tsx";
import { loadOgCards } from "../lib/markdown.ts";
import {
  dismissStaleSsrPreview,
  removeSsrPreview,
} from "../lib/note-bootstrap.ts";
import {
  createNoteReadSession,
  type NoteReadResult,
  noteDenialMessage,
  OfflineNoteUnavailableError,
} from "../lib/note-read-session.ts";
import type { ViewerContext } from "../lib/viewer-context.ts";

type ReadState = {
  id: string;
  viewer: ViewerContext;
} & (
  | { result: NoteReadResult; error?: never }
  | { result?: never; error: string }
);

function ShareDeniedView({ denied }: { denied: 401 | 403 }) {
  if (denied === 401) {
    return (
      <section className="flex flex-col">
        <h1 className="m-0 text-2xl font-bold">ログインが必要です</h1>
        <p>このノートを閲覧するにはサインインしてください。</p>
        <p>
          <a href="/auth/login?email=dev@example.com">ログイン</a>
        </p>
      </section>
    );
  }
  return (
    <section className="flex flex-col">
      <h1 className="m-0 text-2xl font-bold">閲覧できません</h1>
      <p>このノートを閲覧する権限がありません。</p>
      <p>
        <Link to="/">ホームに戻る</Link>
        {" · "}
        <a href="/auth/login?email=dev@example.com">別アカウントでログイン</a>
      </p>
    </section>
  );
}

function ShareResult({ state }: { state: ReadState | null }) {
  if (!state) {
    return <p>読み込み中…</p>;
  }
  const result = state.result;
  if (
    result &&
    !result.ok &&
    (result.status === 401 || result.status === 403)
  ) {
    return (
      <>
        <ShareDeniedView denied={result.status} />
        {result.cacheWarning && <ErrorText>{result.cacheWarning}</ErrorText>}
      </>
    );
  }
  if (!result?.ok) {
    const error =
      state.error ??
      (result?.status === 404 ? "ノートが見つかりません。" : result?.error);
    return (
      <>
        <ErrorText>{error}</ErrorText>
        {result?.cacheWarning && <ErrorText>{result.cacheWarning}</ErrorText>}
        <p>
          <Link to="/">ホームに戻る</Link>
        </p>
      </>
    );
  }
  return (
    <>
      {result.source === "cache" && (
        <p role="status">
          キャッシュを表示しています（読み取り専用）。
          {result.cachedAt !== null && (
            <> 保存日時: {new Date(result.cachedAt).toLocaleString()}</>
          )}
        </p>
      )}
      <PreviewWithToc
        documentScroll={true}
        imageContext={{ source: result.source, viewer: result.viewer }}
        markdown={result.data.markdown}
      />
    </>
  );
}

export function SharePage() {
  const { id = "" } = useParams();
  const { viewer, userLoading, viewing } = useOutletContext<AppShellContext>();
  const [state, setState] = useState<ReadState | null>(null);
  // Hide old data during the render that changes ownership, before cleanup.
  const current =
    !userLoading && state?.id === id && state.viewer === viewer ? state : null;

  useEffect(() => {
    setState(null);
    if (userLoading) {
      return;
    }
    const scope = viewing.beginView(viewer);
    if (viewer.mode === "unavailable") {
      setState({
        error: "閲覧情報を確認できません。しばらくしてから再度お試しください。",
        id,
        viewer,
      });
      return () => scope.dispose();
    }
    let cancelled = false;
    let settled = false;
    const session = createNoteReadSession(viewer, {
      onDenied: (event) => {
        if (cancelled || !scope.isCurrent()) {
          return;
        }
        if (settled) {
          scope.dispose();
        }
        setState({
          error: noteDenialMessage(event),
          id,
          viewer,
        });
      },
    });
    void session.read(id).then(
      (result) => {
        settled = true;
        if (
          cancelled ||
          !scope.publish({
            source: result.ok ? result.source : "pending",
            viewer: result.viewer,
          })
        ) {
          return;
        }
        setState({ id, result, viewer });
      },
      (error: unknown) => {
        settled = true;
        if (cancelled || !scope.isCurrent()) {
          return;
        }
        let message = "ノートを読み込めませんでした。";
        if (error instanceof OfflineNoteUnavailableError) {
          message = "このノートはオフラインキャッシュに保存されていません。";
        } else if (error instanceof Error) {
          message = error.message;
        }
        setState({
          error: message,
          id,
          viewer,
        });
      },
    );
    return () => {
      cancelled = true;
      session.dispose();
      scope.dispose();
    };
  }, [id, userLoading, viewer, viewing]);

  useLayoutEffect(() => {
    dismissStaleSsrPreview(id);
    if (current || viewer.mode === "cached" || viewer.mode === "unavailable") {
      removeSsrPreview();
    }
  }, [id, current, viewer]);

  useEffect(() => {
    const previous = document.title;
    if (current?.result?.ok) {
      const { markdown } = current.result.data;
      document.title = `${titleFromMarkdown(markdown)} · MiyulabMD`;
      if (current.result.source === "network") {
        void loadOgCards(markdown);
      }
    } else {
      document.title = "共有ノート · MiyulabMD";
    }
    return () => {
      document.title = previous;
    };
  }, [current]);

  return (
    <section className="flex flex-col">
      <ShareResult state={current} />
    </section>
  );
}
