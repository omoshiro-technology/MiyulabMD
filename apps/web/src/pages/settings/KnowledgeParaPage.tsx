import type {
  ParaBucketKey,
  ParaBucketResolution,
  ParaPlan,
  ParaResolutionKey,
  ParaSpaceSelector,
  ParaSpaceSummary,
} from "@miyulabmd/shared";
import { PARA_BUCKETS } from "@miyulabmd/shared";
import { useCallback, useEffect, useState } from "react";
import { ParaConflictModal } from "../../components/notes/ParaConflictModal.tsx";
import { Button } from "../../components/ui/Button.tsx";
import { CheckLabel } from "../../components/ui/Field.tsx";
import { Input } from "../../components/ui/Input.tsx";
import { ErrorText, MutedText } from "../../components/ui/Text.tsx";
import {
  deleteParaSpace,
  enablePara,
  fetchPara,
  fetchParaPlan,
  renameParaSpace,
} from "../../lib/api.ts";
import {
  KNOWLEDGE_FEATURES,
  useKnowledgeFeatureToggle,
} from "../../lib/knowledge-features.ts";
import { paraPlanHasConflicts } from "../../lib/para-conflict.ts";

const feature = KNOWLEDGE_FEATURES.para;

const BUCKET_LABELS: Record<ParaBucketKey, string> = {
  archives: "Archives",
  areas: "Areas",
  projects: "Projects",
  resources: "Resources",
};

/** Selector for plan/enable calls targeting a listed space. */
function spaceSelectorOf(space: ParaSpaceSummary): ParaSpaceSelector {
  return space.isDefault ? "default" : { id: space.id };
}

/** plan/enable API が受け取るスペース指定を文字列キーに正規化する。 */
function spaceSelectorKey(
  space: ParaSpaceSelector | undefined | null,
): string | undefined {
  if (space === undefined || space === null || space === "default") {
    return space === "default" ? "default" : undefined;
  }
  if (typeof space === "string") {
    return space;
  }
  return "id" in space ? space.id : space.name;
}

function SpaceRow({
  space,
  busy,
  onSetup,
  onRename,
  onDelete,
}: {
  space: ParaSpaceSummary;
  busy: boolean;
  onSetup: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(space.name);
  const missing = PARA_BUCKETS.filter(
    (def) => !space.buckets.some((bucket) => bucket.key === def.key),
  );
  const label = space.isDefault ? "PARA（デフォルト）" : space.name;
  return (
    <li className="border-b border-border py-2 last:border-b-0">
      <div className="flex flex-wrap items-baseline gap-2">
        {renaming ? (
          <>
            <Input
              className="w-40 px-1 py-0.5 text-[0.9rem]"
              disabled={busy}
              onChange={(event) => setDraft(event.target.value)}
              type="text"
              value={draft}
            />
            <Button
              disabled={busy || !draft.trim()}
              onClick={() => {
                onRename(draft.trim());
                setRenaming(false);
              }}
              variant="outline"
            >
              保存
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                setDraft(space.name);
                setRenaming(false);
              }}
              variant="ghost"
            >
              キャンセル
            </Button>
          </>
        ) : (
          <>
            <span className="font-semibold">{label}</span>
            <MutedText className="text-[0.8rem]">
              {space.isDefault ? "ルート直下" : space.rootPath}・
              {space.buckets.length}/4 バケツ
              {missing.length > 0 &&
                `（未作成: ${missing.map((def) => BUCKET_LABELS[def.key]).join(", ")}）`}
            </MutedText>
          </>
        )}
      </div>
      {!renaming && (
        <div className="mt-1 flex flex-wrap gap-2">
          {missing.length > 0 && (
            <Button disabled={busy} onClick={onSetup} variant="outline">
              不足バケツをセットアップ
            </Button>
          )}
          <Button
            disabled={busy}
            onClick={() => setRenaming(true)}
            variant="ghost"
          >
            改名
          </Button>
          <Button
            disabled={busy}
            onClick={() => {
              if (
                window.confirm(
                  `スペース「${space.name}」の割当を解除します。フォルダ自体は残ります。`,
                )
              ) {
                onDelete();
              }
            }}
            variant="ghost"
          >
            解除
          </Button>
        </div>
      )}
    </li>
  );
}

export function KnowledgeParaPage() {
  const { enabled, error, saving, setEnabled } =
    useKnowledgeFeatureToggle("para");
  const [spaces, setSpaces] = useState<ParaSpaceSummary[]>([]);
  const [conflictPlan, setConflictPlan] = useState<ParaPlan | null>(null);
  const [conflictSpace, setConflictSpace] = useState<
    ParaSpaceSelector | undefined
  >(undefined);
  const [setupBusy, setSetupBusy] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [addName, setAddName] = useState("");

  const refreshSpaces = useCallback(async () => {
    const result = await fetchPara();
    if (result.ok) {
      setSpaces(result.data.spaces);
    }
  }, []);

  // スペース一覧は有効時のみ表示。ミラーではなくサーバーの実在を見る。
  useEffect(() => {
    if (enabled) {
      void refreshSpaces();
    } else {
      setSpaces([]);
    }
  }, [enabled, refreshSpaces]);

  /**
   * POST /api/para/enable。残り衝突があればモーダルを開き直してループ。
   * スペースルートと全バケツが assigned か skip 済みになったら true。
   */
  const runEnable = useCallback(
    async (
      space: ParaSpaceSelector | undefined,
      resolutions?: Partial<Record<ParaResolutionKey, ParaBucketResolution>>,
    ): Promise<boolean> => {
      setSetupBusy(true);
      setSetupError(null);
      const result = await enablePara({ resolutions, space });
      setSetupBusy(false);
      if (!result.ok) {
        setSetupError(result.error);
        return false;
      }
      if (result.data.pending.length > 0) {
        setConflictSpace(space);
        setConflictPlan(result.data.plan);
        void refreshSpaces();
        return false;
      }
      setConflictPlan(null);
      void refreshSpaces();
      return true;
    },
    [refreshSpaces],
  );

  /**
   * plan → 衝突があればモーダル、なければ enable まで一気に進める。
   * スペース追加と「不足バケツをセットアップ」の両方から使う。
   */
  const runSetup = useCallback(
    async (space: ParaSpaceSelector | undefined): Promise<boolean> => {
      setSetupBusy(true);
      setSetupError(null);
      const planResult = await fetchParaPlan({
        space: spaceSelectorKey(space),
      });
      setSetupBusy(false);
      if (!planResult.ok) {
        setSetupError(planResult.error);
        return false;
      }
      if (paraPlanHasConflicts(planResult.data)) {
        setConflictSpace(space);
        setConflictPlan(planResult.data);
        return false;
      }
      return runEnable(space);
    },
    [runEnable],
  );

  const onToggle = useCallback(
    async (next: boolean) => {
      setSetupError(null);
      if (!next) {
        await setEnabled(false);
        return;
      }
      // ON: まず副作用のない plan で default スペースの衝突を検査する。
      if ((await runSetup(undefined)) === true) {
        await setEnabled(true);
      }
    },
    [runSetup, setEnabled],
  );

  const onAddSpace = useCallback(async () => {
    const name = addName.trim();
    if (!name) {
      return;
    }
    if (await runSetup({ name })) {
      setAddName("");
    }
  }, [addName, runSetup]);

  const busy = saving || setupBusy;

  return (
    <section>
      <h2 className="m-0 text-[1.5em] font-bold">{feature.label}</h2>
      <p>{feature.description}</p>
      <CheckLabel>
        <input
          checked={enabled}
          disabled={busy}
          onChange={(event) => void onToggle(event.target.checked)}
          type="checkbox"
        />
        {feature.label}を有効にする
      </CheckLabel>
      {(error || setupError) && <ErrorText>{error ?? setupError}</ErrorText>}
      {busy && <MutedText className="mt-1">処理中…</MutedText>}

      {enabled && (
        <>
          <h3 className="mt-6 text-[1.1em] font-bold">スペース</h3>
          {spaces.length > 0 ? (
            <ul className="m-0 list-none p-0">
              {spaces.map((space) => (
                <SpaceRow
                  busy={busy}
                  key={space.id}
                  onDelete={() => {
                    void deleteParaSpace(space.id).then((result) => {
                      if (!result.ok) {
                        setSetupError(result.error);
                      }
                      void refreshSpaces();
                    });
                  }}
                  onRename={(name) => {
                    void renameParaSpace(space.id, name).then((result) => {
                      if (!result.ok) {
                        setSetupError(result.error);
                      }
                      void refreshSpaces();
                    });
                  }}
                  onSetup={() => void runSetup(spaceSelectorOf(space))}
                  space={space}
                />
              ))}
            </ul>
          ) : (
            <MutedText>スペースはまだありません。</MutedText>
          )}

          <h3 className="mt-6 text-[1.1em] font-bold">スペースを追加</h3>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="w-56"
              disabled={busy}
              onChange={(event) => setAddName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void onAddSpace();
                }
              }}
              placeholder="スペース名（例: 仕事）"
              type="text"
              value={addName}
            />
            <Button
              disabled={busy || !addName.trim()}
              onClick={() => void onAddSpace()}
              variant="outline"
            >
              検査して作成
            </Button>
          </div>
          <MutedText className="mt-2">
            同名のトップレベルフォルダをスペースルートとして作成します。
            名前が衝突した場合は rename / adopt / skip を選べます。
          </MutedText>

          <MutedText className="mt-4">
            無効化してもフォルダや割当は残り、ホームの PARA
            セクションとアーカイブメニューが隠れるだけです。
          </MutedText>
        </>
      )}

      {conflictPlan && (
        <ParaConflictModal
          busy={setupBusy || saving}
          error={setupError}
          onClose={() => setConflictPlan(null)}
          onSubmit={(resolutions) => {
            void (async () => {
              if (
                (await runEnable(conflictSpace, resolutions)) &&
                conflictSpace === undefined
              ) {
                await setEnabled(true);
              }
            })();
          }}
          plan={conflictPlan}
        />
      )}
    </section>
  );
}
