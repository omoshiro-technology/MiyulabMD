import {
  type FolderAccess,
  type FolderChildrenResult,
  formatJdArea,
  formatJdId,
  formatSchemeFolderName,
  isNamingScheme,
  isZettelId,
  JD_GROUP_MAX,
  JD_ID_MAX,
  JD_RESERVED_MAX,
  type JdLevel,
  jdChildLevel,
  jdLevelOf,
  NAMING_SCHEME_LABELS,
  type NamingScheme,
  parseJdArea,
  parseJdCategory,
  parseJdId,
  type SchemeRootEntry,
  type SchemeSuggestion,
  type SchemeValidateResult,
  type SchemeValidationIssue,
  type SessionUser,
  zettelStamp,
} from "@miyulabmd/shared";

import { db } from "../db/client.ts";
import {
  type FolderRow,
  folderName,
  getFolderById,
  getFolderByPath,
  listFolderChildren,
  parentFolderPath,
  resolveFolderAccess,
} from "./access.ts";

export type SchemeError =
  | { kind: "denied"; status: 401 | 403; error: string }
  | { kind: "not_found"; error: string }
  | { kind: "invalid"; status: number; error: string };

export type SchemeOutcome<T> = { kind: "ok"; result: T } | SchemeError;

const UNTITLED = "無題";
const MAX_SCHEME_RETRIES = 3;

function denied(status: 401 | 403, error: string): SchemeError {
  return { error, kind: "denied", status };
}

function invalid(status: number, error: string): SchemeError {
  return { error, kind: "invalid", status };
}

function notFound(error: string): SchemeError {
  return { error, kind: "not_found" };
}

async function counterPeek(
  env_: Env,
  ownerId: string,
  scope: string,
  startAt: number,
): Promise<number> {
  const row = await db(env_)
    .prepare(
      "SELECT next_value FROM id_counters WHERE owner_id = ? AND scope = ?",
    )
    .bind(ownerId, scope)
    .first<{ next_value: number }>();
  return Math.max(row?.next_value ?? startAt, startAt);
}

/**
 * owner+scope 単位の採番カウンタを 1 進めて払い出し値を返す。
 * UPSERT により D1 上で直列化され、返す値は常に startAt 以上。
 */
async function counterAllocate(
  env_: Env,
  ownerId: string,
  scope: string,
  startAt: number,
): Promise<number> {
  const row = await db(env_)
    .prepare(
      `INSERT INTO id_counters (owner_id, scope, next_value) VALUES (?, ?, ?)
       ON CONFLICT (owner_id, scope)
       DO UPDATE SET next_value = MAX(next_value, ?) + 1
       RETURNING next_value`,
    )
    .bind(ownerId, scope, startAt + 1, startAt)
    .first<{ next_value: number }>();
  return (row?.next_value ?? startAt + 1) - 1;
}

type JdCandidate = { level: JdLevel; schemeId: string };

/**
 * 採番スコープのルート = 規則を宣言したフォルダの ID。JD のエリア/カテゴリ
 * （scheme が jd の採番ノード）は宣言ルートのスコープを継続し、それ以外の
 * フォルダは自身が宣言ルートとなる。scheme_root 未設定の旧データや孤立
 * ノードは祖先を辿り、最も近い規則宣言フォルダをスコープとみなす。
 */
async function schemeRootId(env_: Env, folder: FolderRow): Promise<string> {
  if (!(folder.scheme === "jd" && folder.scheme_id)) {
    return folder.id;
  }
  if (folder.scheme_root) {
    return folder.scheme_root;
  }
  let path = parentFolderPath(folder.folder);
  for (;;) {
    const row = await getFolderByPath(env_, folder.owner_id, path);
    if (row?.scheme && !row.scheme_id) {
      return row.id;
    }
    if (!path) {
      return folder.id;
    }
    path = parentFolderPath(path);
  }
}

function jdCandidateError(level: JdLevel | null): SchemeError {
  if (level === null) {
    return invalid(
      400,
      "このフォルダ配下には採番できません（Johnny.Decimal は3階層までです）",
    );
  }
  return invalid(500, "unexpected");
}

/**
 * 親フォルダの JD 階層に応じた次の ID を求める。
 * consume=false なら採番せず次の候補を読むだけ（作成ダイアログのヒント用）。
 */
async function jdNextCandidate(
  env_: Env,
  ownerId: string,
  parent: FolderRow,
  consume: boolean,
): Promise<JdCandidate | SchemeError> {
  const level = jdChildLevel(parent.scheme_id ?? null);
  if (level === null) {
    return jdCandidateError(level);
  }
  const next = consume
    ? (scope: string, startAt: number) =>
        counterAllocate(env_, ownerId, scope, startAt)
    : (scope: string, startAt: number) =>
        counterPeek(env_, ownerId, scope, startAt);
  // 採番カウンタは設定したディレクトリ（規則宣言フォルダ）単位で独立。
  const scope = await schemeRootId(env_, parent);

  if (level === "area") {
    const index = await next(`jd:area:${scope}`, 1);
    // エリア番号は 10-19..90-99 の最大9件（index 10 は 3 桁になる）。
    if (index >= JD_GROUP_MAX) {
      return invalid(
        409,
        `エリアは最大${JD_GROUP_MAX}件までです（Johnny.Decimal 制限）`,
      );
    }
    return { level, schemeId: formatJdArea(index * 10) };
  }
  if (level === "category") {
    const area = parseJdArea(parent.scheme_id ?? "");
    const base = area?.start ?? 0;
    const value = await next(`jd:cat:${scope}:${base}`, base);
    if (value > base + JD_GROUP_MAX - 1) {
      return invalid(
        409,
        `カテゴリはエリアあたり最大${JD_GROUP_MAX}件までです（Johnny.Decimal 制限）`,
      );
    }
    return { level, schemeId: String(value) };
  }
  const category = parseJdCategory(parent.scheme_id ?? "");
  if (category === null) {
    return invalid(400, "カテゴリフォルダの ID が不正です");
  }
  const value = await next(`jd:id:${scope}:${category}`, JD_RESERVED_MAX + 1);
  if (value > JD_ID_MAX) {
    return invalid(
      409,
      `カテゴリ ${category} の ID は ${JD_ID_MAX} 件で上限です（Johnny.Decimal 制限）`,
    );
  }
  return { level, schemeId: formatJdId(category, value) };
}

function jdExplicitArea(schemeId: string): JdCandidate | SchemeError {
  return parseJdArea(schemeId)
    ? { level: "area", schemeId }
    : invalid(400, "エリア ID は `10-19` 形式で指定してください");
}

function jdExplicitCategory(
  parent: FolderRow,
  schemeId: string,
): JdCandidate | SchemeError {
  const category = parseJdCategory(schemeId);
  const area = parseJdArea(parent.scheme_id ?? "");
  if (category === null) {
    return invalid(
      400,
      "カテゴリ ID は `15` のような2桁の数字で指定してください",
    );
  }
  if (area && (category < area.start || category > area.end)) {
    return invalid(
      400,
      `カテゴリ ${category} はエリア ${parent.scheme_id} の範囲外です`,
    );
  }
  return { level: "category", schemeId };
}

function jdExplicitId(
  parent: FolderRow,
  schemeId: string,
): JdCandidate | SchemeError {
  const parsed = parseJdId(schemeId);
  const category = parseJdCategory(parent.scheme_id ?? "");
  if (!parsed) {
    return invalid(400, "ID は `15.22` 形式で指定してください");
  }
  if (category !== null && parsed.category !== category) {
    return invalid(
      400,
      `ID ${schemeId} はカテゴリ ${category} に属していません`,
    );
  }
  return { level: "id", schemeId };
}

function jdExplicitCandidate(
  parent: FolderRow,
  schemeId: string,
): JdCandidate | SchemeError {
  const level = jdChildLevel(parent.scheme_id ?? null);
  if (level === "area") {
    return jdExplicitArea(schemeId);
  }
  if (level === "category") {
    return jdExplicitCategory(parent, schemeId);
  }
  if (level === "id") {
    return jdExplicitId(parent, schemeId);
  }
  return jdCandidateError(level);
}

async function insertSchemeFolder(
  env_: Env,
  ownerId: string,
  path: string,
  scheme: NamingScheme | null,
  schemeId: string,
  schemeTitle: string,
  schemeRoot: string,
): Promise<string | null> {
  const id = crypto.randomUUID();
  try {
    await db(env_)
      .prepare(
        `INSERT INTO folders (id, owner_id, folder, scheme, scheme_id, scheme_title, scheme_root, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        ownerId,
        path,
        scheme,
        schemeId,
        schemeTitle,
        schemeRoot,
        Date.now(),
      )
      .run();
    return id;
  } catch {
    return null;
  }
}

async function allocateCandidate(
  env_: Env,
  ownerId: string,
  parent: FolderRow,
  schemeId: string | undefined,
): Promise<
  { candidate: JdCandidate; childScheme: NamingScheme | null } | SchemeError
> {
  if (parent.scheme === "jd") {
    const candidate = schemeId
      ? jdExplicitCandidate(parent, schemeId)
      : await jdNextCandidate(env_, ownerId, parent, true);
    if ("kind" in candidate) {
      return candidate;
    }
    // 採番されたノードがさらにコンテナになるのはエリア/カテゴリのみ。
    return {
      candidate,
      childScheme: candidate.level === "id" ? null : "jd",
    };
  }
  if (parent.scheme === "zettel") {
    const id = schemeId ?? zettelStamp(Date.now());
    if (!isZettelId(id)) {
      return invalid(
        400,
        "Zettelkasten ID は `YYYYMMDDHHmm` 形式で指定してください",
      );
    }
    return { candidate: { level: "id", schemeId: id }, childScheme: null };
  }
  return invalid(400, "このフォルダには命名規則が設定されていません");
}

async function ownedSchemeFolder(
  env_: Env,
  folderId: string,
  user: SessionUser | undefined,
): Promise<{ row: FolderRow } | SchemeError> {
  if (!user) {
    return denied(401, "Unauthorized");
  }
  const row = await getFolderById(env_, folderId);
  if (!row) {
    return notFound("Not found");
  }
  if (row.owner_id !== user.id) {
    return denied(403, "Forbidden");
  }
  return { row };
}

export type SetFolderSchemeResult = {
  folder: string;
  id: string;
  scheme: NamingScheme | null;
};

export async function setFolderScheme(
  env_: Env,
  folderId: string,
  scheme: string | null,
  user: SessionUser | undefined,
): Promise<SchemeOutcome<SetFolderSchemeResult>> {
  const owned = await ownedSchemeFolder(env_, folderId, user);
  if ("kind" in owned) {
    return owned;
  }
  if (scheme !== null && !isNamingScheme(scheme)) {
    return invalid(
      400,
      `scheme は ${Object.keys(NAMING_SCHEME_LABELS).join("/")} または null で指定してください`,
    );
  }
  await db(env_)
    .prepare("UPDATE folders SET scheme = ? WHERE id = ?")
    .bind(scheme, owned.row.id)
    .run();
  return {
    kind: "ok",
    result: {
      folder: owned.row.folder,
      id: owned.row.id,
      scheme: scheme as NamingScheme | null,
    },
  };
}

export type CreateSchemeChildInput = {
  schemeId?: string;
  title?: string;
};

export type CreateSchemeChildResult = {
  folder: FolderAccess;
  name: string;
  schemeId: string;
  schemeTitle: string;
};

/** 採番→挿入の1回分。一意制約違反なら "retry" を返す（明示指定時は 409）。 */
async function tryCreateSchemeChild(
  env_: Env,
  parent: FolderRow,
  input: CreateSchemeChildInput,
  title: string,
  user: SessionUser | undefined,
): Promise<
  { kind: "ok"; result: CreateSchemeChildResult } | SchemeError | "retry"
> {
  const allocated = await allocateCandidate(
    env_,
    parent.owner_id,
    parent,
    input.schemeId,
  );
  if ("kind" in allocated) {
    return allocated;
  }
  const { candidate, childScheme } = allocated;
  const name = formatSchemeFolderName(candidate.schemeId, title);
  const path = parent.folder ? `${parent.folder}/${name}` : name;
  const inserted = await insertSchemeFolder(
    env_,
    parent.owner_id,
    path,
    childScheme,
    candidate.schemeId,
    title,
    await schemeRootId(env_, parent),
  );
  if (!inserted) {
    if (input.schemeId) {
      return invalid(
        409,
        `ID ${candidate.schemeId} または同名フォルダがすでに存在します`,
      );
    }
    return "retry";
  }
  const folder = await resolveFolderAccess(
    env_,
    parent.owner_id,
    path,
    user ?? { displayName: null, email: "", id: parent.owner_id },
  );
  return {
    kind: "ok",
    result: {
      folder,
      name,
      schemeId: candidate.schemeId,
      schemeTitle: title,
    },
  };
}

export async function createSchemeChild(
  env_: Env,
  parentId: string,
  input: CreateSchemeChildInput,
  user: SessionUser | undefined,
): Promise<SchemeOutcome<CreateSchemeChildResult>> {
  const owned = await ownedSchemeFolder(env_, parentId, user);
  if ("kind" in owned) {
    return owned;
  }
  const parent = owned.row;
  const title = input.title?.trim() || UNTITLED;
  let attempt = input;

  for (let index = 0; index < MAX_SCHEME_RETRIES; index += 1) {
    const result = await tryCreateSchemeChild(
      env_,
      parent,
      attempt,
      title,
      user,
    );
    if (result !== "retry") {
      return result;
    }
    // 一意制約違反: 自動採番はカウンタが既に進むのでそのまま再試行。
    // zettel は同分衝突するため 1 分進めてリトライする。
    if (parent.scheme === "zettel") {
      attempt = {
        ...attempt,
        schemeId: zettelStamp(Date.now() + (index + 1) * 60_000),
      };
    }
  }
  return invalid(409, "ID の採番に失敗しました。もう一度試してください");
}

/**
 * 作成ダイアログ向けの「次の番号」ヒント。採番はしない。
 */
export type SchemeSuggestResult = {
  suggestion: SchemeSuggestion | null;
};

function suggestionFor(
  parent: FolderRow,
  level: JdLevel | "zettel",
  scheme: NamingScheme,
  schemeId: string,
): SchemeSuggestion {
  const name = formatSchemeFolderName(schemeId, UNTITLED);
  return {
    level,
    name,
    path: parent.folder ? `${parent.folder}/${name}` : name,
    scheme,
    schemeId,
    title: UNTITLED,
  };
}

export async function suggestSchemeChild(
  env_: Env,
  folderId: string,
  user: SessionUser | undefined,
): Promise<SchemeOutcome<SchemeSuggestResult>> {
  const owned = await ownedSchemeFolder(env_, folderId, user);
  if ("kind" in owned) {
    return owned;
  }
  const parent = owned.row;
  if (!parent.scheme) {
    return { kind: "ok", result: { suggestion: null } };
  }
  if (parent.scheme === "zettel") {
    return {
      kind: "ok",
      result: {
        suggestion: suggestionFor(
          parent,
          "zettel",
          "zettel",
          zettelStamp(Date.now()),
        ),
      },
    };
  }
  const candidate = await jdNextCandidate(env_, parent.owner_id, parent, false);
  if ("kind" in candidate) {
    return candidate;
  }
  return {
    kind: "ok",
    result: {
      suggestion: suggestionFor(
        parent,
        candidate.level,
        "jd",
        candidate.schemeId,
      ),
    },
  };
}

/**
 * MCP `jd_allocate_id`: ID だけを消費的に採番する。フォルダは作らない。
 */
export async function jdAllocateId(
  env_: Env,
  folderId: string,
  user: SessionUser | undefined,
): Promise<SchemeOutcome<SchemeSuggestion>> {
  const owned = await ownedSchemeFolder(env_, folderId, user);
  if ("kind" in owned) {
    return owned;
  }
  const parent = owned.row;
  if (parent.scheme !== "jd") {
    return invalid(
      400,
      "このフォルダには Johnny.Decimal 規則が設定されていません",
    );
  }
  const candidate = await jdNextCandidate(env_, parent.owner_id, parent, true);
  if ("kind" in candidate) {
    return candidate;
  }
  return {
    kind: "ok",
    result: suggestionFor(parent, candidate.level, "jd", candidate.schemeId),
  };
}

export type SchemeGetResult = {
  children: FolderChildrenResult;
  folder: {
    folder: string;
    id: string;
    name: string;
    scheme: string | null;
    schemeId: string;
    schemeTitle: string | null;
  };
};

/**
 * スキーム ID（`15.22` / `202609171230` など）からフォルダを引く汎用解決。
 */
export async function schemeGet(
  env_: Env,
  schemeId: string,
  user: SessionUser | undefined,
): Promise<SchemeOutcome<SchemeGetResult>> {
  if (!user) {
    return denied(401, "Unauthorized");
  }
  const id = schemeId.trim();
  if (!id) {
    return invalid(400, "ID を指定してください");
  }
  const rows = await db(env_)
    .prepare(
      `SELECT id, owner_id, folder, scheme, scheme_id, scheme_title, scheme_root, created_at
         FROM folders WHERE owner_id = ? AND scheme_id = ? ORDER BY folder`,
    )
    .bind(user.id, id)
    .all<FolderRow>();
  const matches = rows.results ?? [];
  if (matches.length === 0) {
    return notFound("Not found");
  }
  if (matches.length > 1) {
    return invalid(409, `ID ${id} に一致するフォルダが複数あります`);
  }
  const row = matches[0];
  if (!row) {
    return notFound("Not found");
  }
  const children = await listFolderChildren(
    env_,
    row.owner_id,
    row.folder,
    row.id,
    user,
  );
  return {
    kind: "ok",
    result: {
      children,
      folder: {
        folder: row.folder,
        id: row.id,
        name: folderName(row.folder),
        scheme: row.scheme ?? null,
        schemeId: row.scheme_id ?? id,
        schemeTitle: row.scheme_title ?? null,
      },
    },
  };
}

/**
 * 規則を宣言したフォルダ（採番スコープのルート）の一覧。JD のエリア/
 * カテゴリは親スコープを継続するコンテナなのでルートには含めない。
 * 各エントリに採番済みフォルダ数と次番号プレビュー（採番しない）を付ける。
 */
export async function listSchemeRoots(
  env_: Env,
  user: SessionUser | undefined,
): Promise<SchemeOutcome<{ schemes: SchemeRootEntry[] }>> {
  if (!user) {
    return denied(401, "Unauthorized");
  }
  const rows = await db(env_)
    .prepare(
      `SELECT f.id, f.owner_id, f.folder, f.scheme, f.scheme_id, f.scheme_title,
              f.scheme_root, f.created_at,
              (SELECT COUNT(*) FROM folders m
                WHERE m.owner_id = f.owner_id AND m.scheme_root = f.id)
                AS minted_count
         FROM folders AS f
        WHERE f.owner_id = ? AND f.scheme IS NOT NULL
          AND (f.scheme_id IS NULL OR f.scheme <> 'jd')
        ORDER BY f.folder`,
    )
    .bind(user.id)
    .all<FolderRow & { minted_count: number }>();

  const schemes: SchemeRootEntry[] = [];
  for (const row of rows.results ?? []) {
    let next: SchemeRootEntry["next"] = null;
    if (row.scheme === "jd") {
      const candidate = await jdNextCandidate(env_, row.owner_id, row, false);
      next = "kind" in candidate ? null : candidate;
    } else if (row.scheme === "zettel") {
      next = { level: "zettel", schemeId: zettelStamp(Date.now()) };
    }
    schemes.push({
      folder: row.folder,
      id: row.id,
      mintedCount: row.minted_count,
      name: folderName(row.folder),
      next,
      scheme: row.scheme ?? "",
    });
  }
  return { kind: "ok", result: { schemes } };
}

/**
 * owner 配下で scheme_id に一致するフォルダの UUID を全件返す（検索フィルタ
 * 用）。同一 ID が別スキームツリーに存在し得るため複数件になりうる。
 */
export async function folderIdsForSchemeId(
  env_: Env,
  ownerId: string,
  schemeId: string,
): Promise<string[]> {
  const id = schemeId.trim();
  if (!id) {
    return [];
  }
  const rows = await db(env_)
    .prepare("SELECT id FROM folders WHERE owner_id = ? AND scheme_id = ?")
    .bind(ownerId, id)
    .all<{ id: string }>();
  return (rows.results ?? []).map((row) => row.id);
}

export type JdListEntry = {
  folder: string;
  id: string;
  name: string;
  schemeId: string;
  schemeTitle: string | null;
};

export type JdListCategoryResult = {
  entries: JdListEntry[];
  folder: { folder: string; id: string; schemeId: string | null };
  level: JdLevel;
};

function jdEntrySortValue(level: JdLevel, schemeId: string): number {
  if (level === "area") {
    return parseJdArea(schemeId)?.start ?? Number.MAX_SAFE_INTEGER;
  }
  if (level === "category") {
    return parseJdCategory(schemeId) ?? Number.MAX_SAFE_INTEGER;
  }
  return parseJdId(schemeId)?.id ?? Number.MAX_SAFE_INTEGER;
}

/**
 * JD コンテナ（ルート/エリア/カテゴリ）直下の採番済み子を数値順で返す。
 */
export async function jdListCategory(
  env_: Env,
  folderId: string,
  user: SessionUser | undefined,
): Promise<SchemeOutcome<JdListCategoryResult>> {
  const owned = await ownedSchemeFolder(env_, folderId, user);
  if ("kind" in owned) {
    return owned;
  }
  const parent = owned.row;
  if (parent.scheme !== "jd") {
    return invalid(
      400,
      "このフォルダには Johnny.Decimal 規則が設定されていません",
    );
  }
  const level = jdChildLevel(parent.scheme_id ?? null);
  if (level === null) {
    return invalid(400, "ID フォルダの配下に採番対象はありません");
  }
  const prefix = parent.folder ? `${parent.folder}/` : "";
  const rows = await db(env_)
    .prepare(
      `SELECT id, owner_id, folder, scheme, scheme_id, scheme_title, scheme_root, created_at
         FROM folders
        WHERE owner_id = ? AND folder LIKE ? ESCAPE '\\' AND scheme_id IS NOT NULL`,
    )
    .bind(parent.owner_id, `${prefix.replace(/[%_\\]/g, (c) => `\\${c}`)}%`)
    .all<FolderRow>();

  const entries = (rows.results ?? [])
    .filter(
      (row) =>
        parentFolderPath(row.folder) === parent.folder &&
        row.scheme_id !== null,
    )
    .sort(
      (a, b) =>
        jdEntrySortValue(level, a.scheme_id ?? "") -
        jdEntrySortValue(level, b.scheme_id ?? ""),
    )
    .map((row) => ({
      folder: row.folder,
      id: row.id,
      name: folderName(row.folder),
      schemeId: row.scheme_id ?? "",
      schemeTitle: row.scheme_title ?? null,
    }));

  return {
    kind: "ok",
    result: {
      entries,
      folder: {
        folder: parent.folder,
        id: parent.id,
        schemeId: parent.scheme_id ?? null,
      },
      level,
    },
  };
}

/** スコープルートが判明しているノードは、親の属するツリーのルートと一致する。 */
function jdSameTree(row: FolderRow, parent: FolderRow): boolean {
  const expectedRoot = parent.scheme_id ? parent.scheme_root : parent.id;
  return !(row.scheme_root && expectedRoot) || row.scheme_root === expectedRoot;
}

/** scheme_id 持ちノードが JD 構造上の正しい親の下にあるか。 */
function jdExpectedParent(
  row: FolderRow,
  byPath: Map<string, FolderRow>,
): boolean {
  const level = jdLevelOf(row.scheme_id ?? null);
  if (level === null || level === "root") {
    return false;
  }
  const parent = byPath.get(parentFolderPath(row.folder));
  if (!(parent && jdSameTree(row, parent))) {
    return false;
  }
  if (level === "area") {
    return parent.scheme === "jd" && !parent.scheme_id;
  }
  if (level === "category") {
    const category = parseJdCategory(row.scheme_id ?? "");
    const area = parent.scheme_id ? parseJdArea(parent.scheme_id) : null;
    return (
      parent.scheme === "jd" &&
      category !== null &&
      area !== null &&
      category >= area.start &&
      category <= area.end
    );
  }
  const parsed = parseJdId(row.scheme_id ?? "");
  const parentCategory = parent.scheme_id
    ? parseJdCategory(parent.scheme_id)
    : null;
  return parsed !== null && parentCategory === parsed.category;
}

function issue(
  code: SchemeValidationIssue["code"],
  row: FolderRow,
  message: string,
): SchemeValidationIssue {
  return { code, folderId: row.id, message, path: row.folder };
}

function validateJdName(row: FolderRow): SchemeValidationIssue | null {
  const expected = formatSchemeFolderName(
    row.scheme_id ?? "",
    row.scheme_title ?? "",
  );
  if (folderName(row.folder) !== expected) {
    return issue(
      "name_mismatch",
      row,
      `フォルダ名 \`${folderName(row.folder)}\` が規則 \`${expected}\` と一致しません`,
    );
  }
  return null;
}

function checkJdChildCounts(
  root: FolderRow,
  level: JdLevel | null,
  numbered: FolderRow[],
  issues: SchemeValidationIssue[],
): void {
  if (level === "area" && numbered.length > JD_GROUP_MAX) {
    issues.push(
      issue(
        "area_count",
        root,
        `エリアが${JD_GROUP_MAX}件を超えています（${numbered.length}件）`,
      ),
    );
  }
  if (level === "category" && numbered.length > JD_GROUP_MAX) {
    issues.push(
      issue(
        "category_count",
        root,
        `カテゴリが${JD_GROUP_MAX}件を超えています（${numbered.length}件）`,
      ),
    );
  }
  if (level === "id" && numbered.length > JD_ID_MAX + 1) {
    issues.push(
      issue(
        "id_range",
        root,
        `ID が${JD_ID_MAX + 1}件を超えています（${numbered.length}件）`,
      ),
    );
  }
}

function checkJdChild(
  child: FolderRow,
  byPath: Map<string, FolderRow>,
  issues: SchemeValidationIssue[],
): void {
  if (!jdExpectedParent(child, byPath)) {
    issues.push(
      issue(
        "wrong_parent",
        child,
        `\`${child.scheme_id}\` が想定外の親フォルダ配下にあります`,
      ),
    );
  }
  const nameIssue = validateJdName(child);
  if (nameIssue) {
    issues.push(nameIssue);
  }
  const parsed = parseJdId(child.scheme_id ?? "");
  if (parsed && parsed.id <= JD_RESERVED_MAX) {
    issues.push(
      issue(
        "reserved",
        child,
        `\`${child.scheme_id}\` は予約範囲（.00–.${String(JD_RESERVED_MAX).padStart(2, "0")}）です`,
      ),
    );
  }
}

function validateJdSubtree(
  root: FolderRow,
  byPath: Map<string, FolderRow>,
  all: FolderRow[],
  issues: SchemeValidationIssue[],
  checked: Set<string>,
): void {
  const numbered = all.filter(
    (row) =>
      parentFolderPath(row.folder) === root.folder && row.scheme_id !== null,
  );
  checkJdChildCounts(
    root,
    jdChildLevel(root.scheme_id ?? null),
    numbered,
    issues,
  );
  for (const child of numbered) {
    if (checked.has(child.id)) {
      continue;
    }
    checked.add(child.id);
    checkJdChild(child, byPath, issues);
    if (jdLevelOf(child.scheme_id ?? null) !== "id") {
      validateJdSubtree(child, byPath, all, issues, checked);
    }
  }
}

/** 規則キー妥当性と scheme_id 重複（同一採番スコープ内）の検査。 */
function collectSchemeAndDupIssues(
  all: FolderRow[],
  issues: SchemeValidationIssue[],
): void {
  const seenIds = new Map<string, FolderRow>();
  for (const row of all) {
    if (row.scheme && !isNamingScheme(row.scheme)) {
      issues.push(
        issue(
          "invalid_scheme",
          row,
          `不明な命名規則 \`${row.scheme}\` が設定されています`,
        ),
      );
    }
    if (!row.scheme_id) {
      continue;
    }
    // scheme_root 未設定の孤立ノードは共通バケットで重複判定する。
    const scopeKey = `${row.scheme_root ?? ""}${row.scheme_id}`;
    const prior = seenIds.get(scopeKey);
    if (prior) {
      issues.push(
        issue(
          "duplicate_id",
          row,
          `ID \`${row.scheme_id}\` が同じ採番スコープ内で \`${prior.folder}\` と重複しています`,
        ),
      );
    } else {
      seenIds.set(scopeKey, row);
    }
  }
}

/** JD ルートから辿れない孤立 scheme_id ノード（移動で切り離された等）の検査。 */
function collectOrphanIssues(
  all: FolderRow[],
  byPath: Map<string, FolderRow>,
  checked: Set<string>,
  issues: SchemeValidationIssue[],
): void {
  for (const row of all) {
    if (!row.scheme_id || checked.has(row.id) || isZettelId(row.scheme_id)) {
      continue;
    }
    if (jdLevelOf(row.scheme_id) === null) {
      issues.push(
        issue(
          "id_range",
          row,
          `ID \`${row.scheme_id}\` の形式を判定できません`,
        ),
      );
    } else if (!jdExpectedParent(row, byPath)) {
      issues.push(
        issue(
          "wrong_parent",
          row,
          `\`${row.scheme_id}\` が想定外の親フォルダ配下にあります`,
        ),
      );
    }
    const nameIssue = validateJdName(row);
    if (nameIssue) {
      issues.push(nameIssue);
    }
  }
}

export async function validateSchemeTree(
  env_: Env,
  user: SessionUser | undefined,
): Promise<SchemeOutcome<SchemeValidateResult>> {
  if (!user) {
    return denied(401, "Unauthorized");
  }
  const rows = await db(env_)
    .prepare(
      `SELECT id, owner_id, folder, scheme, scheme_id, scheme_title, scheme_root, created_at
         FROM folders WHERE owner_id = ? ORDER BY folder`,
    )
    .bind(user.id)
    .all<FolderRow>();
  const all = rows.results ?? [];
  const byPath = new Map(all.map((row) => [row.folder, row]));
  const issues: SchemeValidationIssue[] = [];

  collectSchemeAndDupIssues(all, issues);

  const checked = new Set<string>();
  for (const row of all) {
    // エリア/カテゴリは JD ルートからの再帰で検証済みなので、ルートのみ起点にする。
    if (row.scheme === "jd" && !row.scheme_id) {
      validateJdSubtree(row, byPath, all, issues, checked);
    }
  }
  collectOrphanIssues(all, byPath, checked, issues);

  return { kind: "ok", result: { folders: all.length, issues } };
}

/**
 * create_note フック: フォルダの命名規則が zettel なら
 * `YYYYMMDDHHmm ` プレフィックスをタイトルに付ける。
 */
export async function schemeNoteTitlePrefix(
  env_: Env,
  ownerId: string,
  folder: string,
  now: number,
): Promise<string | null> {
  const row = await getFolderByPath(env_, ownerId, folder);
  if (row?.scheme !== "zettel") {
    return null;
  }
  return `${zettelStamp(now)} `;
}
