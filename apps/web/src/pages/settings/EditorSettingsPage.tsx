import { useEffect, useState } from "react";
import { useOutletContext } from "react-router";
import type { AppShellContext } from "../../components/layout/AppShellContext.ts";
import { Field } from "../../components/ui/Field.tsx";
import { Select } from "../../components/ui/Select.tsx";
import { MutedText } from "../../components/ui/Text.tsx";
import {
  clearEditCache,
  isEditCacheOptedOut,
  listEditCacheDocs,
  setEditCacheOptOut,
} from "../../lib/edit-cache.ts";
import {
  INDENT_UNIT_LABELS,
  INDENT_UNITS,
  type IndentUnit,
  readIndentUnit,
  readTabKeyMode,
  TAB_KEY_LABELS,
  TAB_KEY_MODES,
  type TabKeyMode,
  writeIndentUnit,
  writeTabKeyMode,
} from "../../lib/editor-tab.ts";

export function EditorSettingsPage() {
  const { user } = useOutletContext<AppShellContext>();
  const userId = user?.id ?? null;
  const [tabKey, setTabKey] = useState<TabKeyMode>(() => readTabKeyMode());
  const [indentUnit, setIndentUnit] = useState<IndentUnit>(() =>
    readIndentUnit(),
  );
  const [offlineEdit, setOfflineEdit] = useState(
    () => userId !== null && !isEditCacheOptedOut(userId),
  );

  useEffect(() => {
    setOfflineEdit(userId !== null && !isEditCacheOptedOut(userId));
  }, [userId]);

  const onOfflineEditChange = (enabled: boolean) => {
    if (userId === null) {
      return;
    }
    setEditCacheOptOut(userId, !enabled);
    setOfflineEdit(enabled);
    if (!enabled) {
      const docs = listEditCacheDocs(userId);
      if (
        docs.length > 0 &&
        window.confirm(
          `この端末に保存されたオフライン編集データ（${docs.length} 件）を削除しますか？未送信の編集は失われます。`,
        )
      ) {
        void clearEditCache(userId);
      }
    }
  };

  return (
    <section>
      <h2 className="m-0 text-[1.5em] font-bold">エディタ設定</h2>
      <p>
        この端末のエディタ操作を設定します。開いているノートは次回表示から反映されます。
      </p>

      <Field htmlFor="tab-key-mode" label="Tab キーの動作">
        <Select
          aria-label="Tab キーの動作"
          className="mt-[0.35rem] rounded-lg px-3 py-2"
          id="tab-key-mode"
          onChange={(event) => {
            const next = event.target.value as TabKeyMode;
            setTabKey(next);
            writeTabKeyMode(next);
          }}
          value={tabKey}
        >
          {TAB_KEY_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {TAB_KEY_LABELS[mode]}
            </option>
          ))}
        </Select>
      </Field>

      {tabKey === "indent" && (
        <>
          <Field className="mt-4" htmlFor="indent-unit" label="インデント幅">
            <Select
              aria-label="インデント幅"
              className="mt-[0.35rem] rounded-lg px-3 py-2"
              id="indent-unit"
              onChange={(event) => {
                const next = event.target.value as IndentUnit;
                setIndentUnit(next);
                writeIndentUnit(next);
              }}
              value={indentUnit}
            >
              {INDENT_UNITS.map((unit) => (
                <option key={unit} value={unit}>
                  {INDENT_UNIT_LABELS[unit]}
                </option>
              ))}
            </Select>
          </Field>
          <MutedText className="mt-3">
            フォーカスを外す: Esc → Tab、または
            Ctrl-M。テキストとリッチの両方の編集画面で使えます。
          </MutedText>
        </>
      )}
      {tabKey === "focus" && (
        <MutedText className="mt-3">
          Tab キーはブラウザ標準どおり次の要素へフォーカスを移動します。
        </MutedText>
      )}

      {userId !== null && (
        <Field className="mt-6" label="オフライン編集（この端末）">
          <span className="flex items-center gap-[0.45rem]">
            <input
              aria-label="この端末でオフライン編集を使う"
              checked={offlineEdit}
              onChange={(event) => onOfflineEditChange(event.target.checked)}
              type="checkbox"
            />
            この端末でオフライン編集を使う
          </span>
          <MutedText>
            自分だけが編集できるノートの本文をこの端末に保存し、オフラインでも編集できます。
            オフにするとオンライン編集のみに戻ります。
          </MutedText>
        </Field>
      )}
    </section>
  );
}
