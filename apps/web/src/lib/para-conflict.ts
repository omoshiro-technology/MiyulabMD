import {
  PARA_BUCKETS,
  type ParaBucketResolution,
  type ParaPlan,
  type ParaPlanBucket,
  type ParaResolutionKey,
} from "@miyulabmd/shared";

/**
 * §2.4/§2.5 競合モーダルの純粋な状態遷移。衝突項目（スペースルート +
 * バケツ）ごとに rename（既存を改名して新設）/ adopt（既存を割当）/ skip
 * を選ぶ。キャンセルは副作用なし（呼び出し側が閉じるだけ）。
 */

export type ParaResolutionChoice = "rename" | "adopt" | "skip";

export type ParaConflictItem = {
  /** "space" = the space root row; otherwise a bucket key. */
  key: ParaResolutionKey;
  kind: "space" | "bucket";
  /** Default folder name the entry wants (e.g. "Projects" or the space name). */
  defaultName: string;
  /** The unassigned folder currently occupying the default name. */
  existingId: string;
  existingName: string;
  choice: ParaResolutionChoice;
  /** New name for the existing folder when choice === "rename". */
  newName: string;
};

/** Buckets whose default name is taken by an unassigned folder. */
export function paraPlanConflicts(plan: ParaPlan): ParaPlanBucket[] {
  return plan.buckets.filter((bucket) => bucket.status === "collision");
}

/** Any unresolved row — space root or bucket — that needs the modal. */
export function paraPlanHasConflicts(plan: ParaPlan): boolean {
  return (
    plan.space.status === "collision" || paraPlanConflicts(plan).length > 0
  );
}

/** Initial modal state: space-root row first (if colliding), then buckets. */
export function initParaConflicts(plan: ParaPlan): ParaConflictItem[] {
  const items: ParaConflictItem[] = [];
  if (plan.space.status === "collision") {
    const existingName = plan.space.existing?.name ?? "";
    items.push({
      choice: "rename",
      defaultName: plan.space.name ?? existingName,
      existingId: plan.space.existing?.id ?? "",
      existingName,
      key: "space",
      kind: "space",
      newName: existingName ? `${existingName} (old)` : "",
    });
  }
  for (const bucket of paraPlanConflicts(plan)) {
    const existingName = bucket.existing?.name ?? "";
    items.push({
      choice: "rename",
      defaultName:
        PARA_BUCKETS.find((def) => def.key === bucket.bucket)?.name ??
        bucket.bucket,
      existingId: bucket.existing?.id ?? "",
      existingName,
      key: bucket.bucket,
      kind: "bucket",
      newName: existingName ? `${existingName} (old)` : "",
    });
  }
  return items;
}

export function setParaConflictChoice(
  items: ParaConflictItem[],
  key: ParaResolutionKey,
  choice: ParaResolutionChoice,
): ParaConflictItem[] {
  return items.map((item) => (item.key === key ? { ...item, choice } : item));
}

export function setParaConflictNewName(
  items: ParaConflictItem[],
  key: ParaResolutionKey,
  newName: string,
): ParaConflictItem[] {
  return items.map((item) => (item.key === key ? { ...item, newName } : item));
}

/** Every row has a usable resolution (rename requires a non-empty new name). */
export function paraConflictsReady(items: ParaConflictItem[]): boolean {
  return items.every(
    (item) => item.choice !== "rename" || item.newName.trim().length > 0,
  );
}

/** Build the `resolutions` map for POST /api/para/enable. */
export function paraConflictResolutions(
  items: ParaConflictItem[],
): Partial<Record<ParaResolutionKey, ParaBucketResolution>> {
  const out: Partial<Record<ParaResolutionKey, ParaBucketResolution>> = {};
  for (const item of items) {
    switch (item.choice) {
      case "rename":
        out[item.key] = {
          action: "rename",
          folderId: item.existingId,
          newName: item.newName.trim(),
        };
        break;
      case "adopt":
        out[item.key] = { action: "adopt", folderId: item.existingId };
        break;
      case "skip":
        out[item.key] = { action: "skip" };
        break;
    }
  }
  return out;
}
