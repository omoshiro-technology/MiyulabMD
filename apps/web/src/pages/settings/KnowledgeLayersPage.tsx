import type {
  MedallionAssignment,
  MedallionLayer,
  MedallionSet,
} from "@miyulabmd/shared";
import {
  folderUrl,
  isMedallionLayerKey,
  medalForLayerIndex,
} from "@miyulabmd/shared";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { Button } from "../../components/ui/Button.tsx";
import { CheckLabel, Field, Row } from "../../components/ui/Field.tsx";
import { Input } from "../../components/ui/Input.tsx";
import { ErrorText, MutedText } from "../../components/ui/Text.tsx";
import {
  createMedallionSet,
  deleteMedallionSet,
  fetchMedallionAssignments,
  fetchMedallionSets,
  updateMedallionSet,
} from "../../lib/api.ts";
import {
  KNOWLEDGE_FEATURES,
  useKnowledgeFeatureToggle,
} from "../../lib/knowledge-features.ts";

const feature = KNOWLEDGE_FEATURES.layers;

type SetDraft = {
  name: string;
  layers: MedallionLayer[];
};

function draftFromSet(set: MedallionSet): SetDraft {
  return { layers: set.layers.map((layer) => ({ ...layer })), name: set.name };
}

/**
 * 1つの層セットの編集カード。キーは不変なので編集対象はラベルと並び順だけ
 * （キーの追加・削除はサーバーが拒否する — §2.6）。
 */
function MedallionSetCard({
  assignedFolders,
  onChanged,
  onDeleted,
  set,
}: {
  assignedFolders: number;
  onChanged: (set: MedallionSet) => void;
  onDeleted: (id: string) => void;
  set: MedallionSet;
}) {
  const [draft, setDraft] = useState<SetDraft>(() => draftFromSet(set));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    setDraft(draftFromSet(set));
  }, [set]);

  function moveLayer(index: number, delta: -1 | 1) {
    setDraft((current) => {
      const layers = [...current.layers];
      const target = index + delta;
      const top = layers[index];
      const bottom = layers[target];
      if (!(top && bottom)) {
        return current;
      }
      layers[index] = bottom;
      layers[target] = top;
      return { ...current, layers };
    });
  }

  async function save() {
    setBusy(true);
    setError(null);
    const result = await updateMedallionSet(set.id, {
      layers: draft.layers,
      name: draft.name,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onChanged(result.data.set);
  }

  async function remove() {
    setDeleting(true);
    setError(null);
    const first = await deleteMedallionSet(set.id, false);
    if (first.ok) {
      onDeleted(set.id);
      return;
    }
    if (first.error === "confirm_required") {
      const confirmed = window.confirm(
        `${first.assignedFolders ?? 0} 件のフォルダ割当を解除して、この層セットを削除します。よろしいですか？`,
      );
      if (confirmed) {
        const second = await deleteMedallionSet(set.id, true);
        if (second.ok) {
          onDeleted(set.id);
          return;
        }
        setError(second.error);
      }
    } else {
      setError(first.error);
    }
    setDeleting(false);
  }

  return (
    <section className="grid gap-3 rounded-xl border border-border p-4">
      <Field label="セット名">
        <Input
          aria-label="セット名"
          disabled={busy || deleting}
          onChange={(event) =>
            setDraft((current) => ({ ...current, name: event.target.value }))
          }
          value={draft.name}
        />
      </Field>
      <ul className="m-0 grid list-none gap-1 p-0">
        {draft.layers.map((layer, index) => (
          <li className="flex items-center gap-2" key={layer.key}>
            <span aria-hidden={true}>{medalForLayerIndex(index)}</span>
            <code className="rounded bg-surface px-1 text-[0.75rem] text-muted">
              {layer.key}
            </code>
            <Input
              aria-label={`${layer.key} のラベル`}
              className="flex-1"
              disabled={busy || deleting}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  layers: current.layers.map((entry, i) =>
                    i === index
                      ? { ...entry, label: event.target.value }
                      : entry,
                  ),
                }))
              }
              value={layer.label}
            />
            <Button
              aria-label="上へ"
              disabled={busy || deleting || index === 0}
              onClick={() => moveLayer(index, -1)}
              type="button"
              variant="ghost"
            >
              ↑
            </Button>
            <Button
              aria-label="下へ"
              disabled={busy || deleting || index === draft.layers.length - 1}
              onClick={() => moveLayer(index, 1)}
              type="button"
              variant="ghost"
            >
              ↓
            </Button>
          </li>
        ))}
      </ul>
      {assignedFolders > 0 && (
        <MutedText className="text-xs">
          {assignedFolders} 件のフォルダに割り当て中
        </MutedText>
      )}
      {error && <ErrorText>{error}</ErrorText>}
      <Row>
        <Button
          disabled={busy || deleting || !draft.name.trim()}
          onClick={() => void save()}
          type="button"
          variant="accent"
        >
          {busy ? "保存中…" : "保存"}
        </Button>
        <Button
          disabled={busy || deleting}
          onClick={() => void remove()}
          type="button"
          variant="danger"
        >
          {deleting ? "削除中…" : "削除"}
        </Button>
      </Row>
    </section>
  );
}

function parseLayerLines(raw: string): MedallionLayer[] | null {
  const layers: MedallionLayer[] = [];
  const seen = new Set<string>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    const key = (eq < 0 ? trimmed : trimmed.slice(0, eq)).trim();
    const label = eq < 0 ? key : trimmed.slice(eq + 1).trim();
    if (!isMedallionLayerKey(key) || seen.has(key)) {
      return null;
    }
    seen.add(key);
    layers.push({ key, label: label || key });
  }
  return layers;
}

/** 新規セット作成フォーム。キーは作成時のみ指定でき、後から変えられない。 */
function MedallionSetCreate({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [layersRaw, setLayersRaw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const layers = layersRaw.trim() ? parseLayerLines(layersRaw) : undefined;
    if (layers === null) {
      setError(
        "層キーが不正です。1行に1つ、key または key=label の形式で入力してください。",
      );
      return;
    }
    setBusy(true);
    setError(null);
    const result = await createMedallionSet({
      layers: layers?.length ? layers : undefined,
      name: name.trim(),
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setName("");
    setLayersRaw("");
    onCreated();
  }

  return (
    <section className="grid gap-3 rounded-xl border border-dashed border-border p-4">
      <Field label="新しい層セット名">
        <Input
          aria-label="新しい層セット名"
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
          placeholder="例: レビュー状態"
          value={name}
        />
      </Field>
      <Field label="層キー（任意・1行に1つ、key または key=label）">
        <textarea
          aria-label="層キー"
          className="min-h-16 w-full rounded-md border border-border bg-canvas px-2 py-1.5 font-inherit text-inherit"
          disabled={busy}
          onChange={(event) => setLayersRaw(event.target.value)}
          placeholder={"draft=下書き\nreview=レビュー中\nfinal=完成"}
          value={layersRaw}
        />
      </Field>
      <MutedText className="text-xs">
        空欄なら raw / knowledge / output の 3
        層で作成します。層キーは作成後に変更できません（ラベルと並び順は後で編集できます）。
      </MutedText>
      {error && <ErrorText>{error}</ErrorText>}
      <Row>
        <Button
          disabled={busy || !name.trim()}
          onClick={() => void submit()}
          type="button"
        >
          {busy ? "作成中…" : "セットを作成"}
        </Button>
      </Row>
    </section>
  );
}

export function KnowledgeLayersPage() {
  const { enabled, error, saving, setEnabled } =
    useKnowledgeFeatureToggle("layers");
  const [sets, setSets] = useState<MedallionSet[]>([]);
  const [assignments, setAssignments] = useState<MedallionAssignment[]>([]);
  const [listError, setListError] = useState<string | null>(null);

  const reload = useCallback(() => {
    void fetchMedallionSets().then((result) => {
      if (result.ok) {
        setSets(result.data.sets);
      } else {
        setListError(result.error);
      }
    });
    void fetchMedallionAssignments().then((result) => {
      if (result.ok) {
        setAssignments(result.data.assignments);
      }
    });
  }, []);

  useEffect(() => {
    if (enabled) {
      setListError(null);
      reload();
    } else {
      setSets([]);
      setAssignments([]);
    }
  }, [enabled, reload]);

  const assignedCount = useCallback(
    (setId: string) =>
      assignments.filter((assignment) => assignment.setId === setId).length,
    [assignments],
  );

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
      {error && <ErrorText>{error}</ErrorText>}
      {saving && <MutedText className="mt-1">保存中…</MutedText>}
      <MutedText className="mt-3">
        無効化してもノート単位の編集ロックは残ります（層は表示ラベルのみで、ロックは別機能です）。
      </MutedText>

      {enabled && (
        <div className="mt-5 grid gap-4">
          <h3 className="m-0 text-[1.05rem] font-semibold">層セット</h3>
          {listError && <ErrorText>{listError}</ErrorText>}
          {sets.map((set) => (
            <MedallionSetCard
              assignedFolders={assignedCount(set.id)}
              key={set.id}
              onChanged={(next) =>
                setSets((current) =>
                  current.map((entry) => (entry.id === next.id ? next : entry)),
                )
              }
              onDeleted={(id) => {
                setSets((current) =>
                  current.filter((entry) => entry.id !== id),
                );
                reload();
              }}
              set={set}
            />
          ))}
          <MedallionSetCreate onCreated={reload} />

          {assignments.length > 0 && (
            <>
              <h3 className="m-0 text-[1.05rem] font-semibold">
                割り当て済みフォルダ
              </h3>
              <ul className="m-0 list-none p-0">
                {assignments.map((assignment) => (
                  <li className="py-1" key={assignment.folderId}>
                    <Link
                      className="text-accent no-underline"
                      to={folderUrl(assignment.folderId)}
                    >
                      {assignment.path}
                    </Link>
                    <span className="ml-2 text-muted">
                      {assignment.setName} — {assignment.layerLabel}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </section>
  );
}
