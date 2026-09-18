import {
  folderUrl,
  isNamingScheme,
  MY_DRIVE_NAME,
  NAMING_SCHEME_LABELS,
  type SchemeRootEntry,
} from "@miyulabmd/shared";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { CheckLabel } from "../../components/ui/Field.tsx";
import { ErrorText, MutedText } from "../../components/ui/Text.tsx";
import { fetchSchemeRoots } from "../../lib/api.ts";
import {
  KNOWLEDGE_FEATURES,
  useKnowledgeFeatureToggle,
} from "../../lib/knowledge-features.ts";

const feature = KNOWLEDGE_FEATURES.schemes;

function schemeLabel(scheme: string): string {
  return isNamingScheme(scheme) ? NAMING_SCHEME_LABELS[scheme] : scheme;
}

function SchemeRootRow({ entry }: { entry: SchemeRootEntry }) {
  return (
    <li className="border-b border-border py-2 last:border-b-0">
      <div className="flex flex-wrap items-baseline gap-2">
        <Link className="font-semibold" to={folderUrl(entry.id)}>
          {entry.folder === "" ? MY_DRIVE_NAME : entry.folder}
        </Link>
        <MutedText className="text-[0.8rem]">
          {schemeLabel(entry.scheme)}
        </MutedText>
      </div>
      <MutedText className="mt-0.5 text-[0.8rem]">
        {entry.next && `次番号: ${entry.next.schemeId} → 作成時に自動提案。`}
        採番スコープ内 {entry.mintedCount} フォルダ
      </MutedText>
    </li>
  );
}

export function KnowledgeSchemesPage() {
  const { enabled, error, saving, setEnabled } =
    useKnowledgeFeatureToggle("schemes");
  const [roots, setRoots] = useState<SchemeRootEntry[]>([]);
  const [rootsError, setRootsError] = useState<string | null>(null);

  // 設定済みルート一覧は有効時のみ表示。サーバーの実在を見る。
  useEffect(() => {
    if (!enabled) {
      setRoots([]);
      setRootsError(null);
      return;
    }
    const controller = new AbortController();
    void fetchSchemeRoots({ signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) {
        return;
      }
      if (result.ok) {
        setRoots(result.data.schemes);
        setRootsError(null);
      } else {
        setRootsError(result.error);
      }
    });
    return () => controller.abort();
  }, [enabled]);

  return (
    <section>
      <h2 className="m-0 text-[1.5em] font-bold">{feature.label}</h2>
      <p>{feature.description}</p>
      <CheckLabel>
        <input
          checked={enabled}
          disabled={saving}
          onChange={(event) => void setEnabled(event.target.checked)}
          type="checkbox"
        />
        {feature.label}を有効にする
      </CheckLabel>
      {(error || rootsError) && <ErrorText>{error ?? rootsError}</ErrorText>}
      {saving && <MutedText className="mt-1">保存中…</MutedText>}

      {enabled && (
        <>
          <h3 className="mt-6 text-[1.1em] font-bold">設定済みの命名規則</h3>
          {roots.length > 0 ? (
            <ul className="m-0 list-none p-0">
              {roots.map((entry) => (
                <SchemeRootRow entry={entry} key={entry.id} />
              ))}
            </ul>
          ) : (
            <MutedText>設定済みの命名規則はありません。</MutedText>
          )}
        </>
      )}

      <MutedText className="mt-3">
        命名規則の設定・解除はフォルダのコンテキストメニュー「命名規則…」から行います。
      </MutedText>
    </section>
  );
}
