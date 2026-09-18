import type { Note } from "@miyulabmd/shared";
import { clearDocument, IndexeddbPersistence, storeState } from "y-indexeddb";
import type * as Y from "yjs";

/**
 * 編集キャッシュ（オフライン編集層）— specs/offline-mode.html §4.3。
 *
 * 表示キャッシュ（offline-cache.ts）とは完全分離。対象は「オフライン編集資格」
 * を持つノートだけ: 所有者本人 && effectiveWriteScope === "self" && 編集ロックなし。
 * 永続化は y-indexeddb（ノートごとに 1 つの IndexedDB DB）に任せる。
 */

const EDIT_CACHE_COMPACT_THRESHOLD = 500;

const OPT_OUT_PREFIX = "miyulabmd:offline-edit-enabled:";
const SYNCED_PREFIX = "miyulabmd:yjs-synced:";
const DOC_REGISTRY_PREFIX = "miyulabmd:edit-docs:";

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // localStorage が使えない環境では設定を永続化しない（デフォルト ON に縮退）。
  }
}

function storageRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Best-effort cleanup.
  }
}

/** y-indexeddb の IndexedDB データベース名（ユーザー毎に分離）。 */
export function editCacheDocName(userId: string, noteId: string): string {
  return `miyulabmd-edit:${userId}:${noteId}`;
}

/**
 * 資格判定に必要なノート情報だけを持つ構造型。
 * `Note` はこの型を満たす。
 */
export type EditCacheNote = Pick<Note, "ownerId" | "access" | "editLocked">;

/**
 * §2.6 編集ロック: `editLocked` = サーバーの永続的なロックフラグ。
 * ロック中は本文・メタ・移動・削除すべてが拒否される（解除のみ可）。
 */
function isNoteEditLocked(note: EditCacheNote): boolean {
  return note.editLocked === true;
}

/**
 * オフライン編集資格: 所有者本人 && 実効書き込みスコープが「自分のみ」 &&
 * 編集ロックなし && この端末で opt-out されていない。
 * 直近メタデータで判定し、stale は許容する（再接続時の Yjs マージが吸収）。
 */
export function isEditCacheEligible(
  note: EditCacheNote,
  userId: string,
): boolean {
  return (
    userId.length > 0 &&
    note.ownerId === userId &&
    note.access.effectiveWriteScope === "self" &&
    !isNoteEditLocked(note) &&
    !isEditCacheOptedOut(userId)
  );
}

function optOutKey(userId: string): string {
  return `${OPT_OUT_PREFIX}${userId}`;
}

/** 端末ローカルの opt-out。デフォルトは ON（オフライン編集を使う）。 */
export function isEditCacheOptedOut(userId: string): boolean {
  return storageGet(optOutKey(userId)) === "0";
}

export function setEditCacheOptOut(userId: string, optedOut: boolean): void {
  storageSet(optOutKey(userId), optedOut ? "0" : "1");
}

function syncedKey(userId: string, noteId: string): string {
  return `${SYNCED_PREFIX}${userId}:${noteId}`;
}

/**
 * provider の初回 sync 完了後に呼ぶ。マーカーがないノートはローカルに
 * サーバー共有履歴のない Y.Doc ができる恐れがあるため、オフライン編集は
 * 閲覧のみとする判定材料になる。
 */
export function markYjsSynced(userId: string, noteId: string): void {
  storageSet(syncedKey(userId, noteId), "1");
}

export function hasSyncedOnce(userId: string, noteId: string): boolean {
  return storageGet(syncedKey(userId, noteId)) === "1";
}

function registryKey(userId: string): string {
  return `${DOC_REGISTRY_PREFIX}${userId}`;
}

function readDocRegistry(userId: string): string[] {
  const raw = storageGet(registryKey(userId));
  if (!raw) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

function writeDocRegistry(userId: string, noteIds: string[]): void {
  storageSet(registryKey(userId), JSON.stringify(noteIds));
}

/**
 * doc レジストリ。`indexedDB.databases()` は Firefox/Safari 非対応のため、
 * purge ・ opt-out 削除用に永続化済み doc の一覧を localStorage に持つ。
 */
export function registerEditCacheDoc(userId: string, noteId: string): void {
  const noteIds = readDocRegistry(userId);
  if (!noteIds.includes(noteId)) {
    noteIds.push(noteId);
    writeDocRegistry(userId, noteIds);
  }
}

function unregisterEditCacheDoc(userId: string, noteId: string): void {
  writeDocRegistry(
    userId,
    readDocRegistry(userId).filter((id) => id !== noteId),
  );
}

/** このユーザーの編集キャッシュに永続化された doc 名を列挙する。 */
export function listEditCacheDocs(userId: string): string[] {
  return readDocRegistry(userId).map((noteId) =>
    editCacheDocName(userId, noteId),
  );
}

/** 永続化済み doc の noteId 一覧（purge ガードが対象ノートを表示する用）。 */
export function listEditCacheNoteIds(userId: string): string[] {
  return readDocRegistry(userId);
}

async function deleteEditCacheDatabase(name: string): Promise<void> {
  if (typeof indexedDB === "undefined") {
    return;
  }
  try {
    await clearDocument(name);
  } catch {
    // 削除失敗時もレジストリ整合を優先。残った DB は次回 purge で再試行される。
  }
}

/**
 * 編集キャッシュ doc の削除（opt-out 削除・purge ガード用）。
 * `noteId` 省略時はそのユーザーの登録済み doc を全て消す。
 * 未送信 update を含む doc の削除判断は呼び出し側（purge ガード）の責務。
 */
export async function clearEditCache(
  userId: string,
  noteId?: string,
): Promise<void> {
  if (noteId !== undefined) {
    await deleteEditCacheDatabase(editCacheDocName(userId, noteId));
    unregisterEditCacheDoc(userId, noteId);
    storageRemove(syncedKey(userId, noteId));
    unsentNotes.delete(noteId);
    return;
  }
  for (const id of readDocRegistry(userId)) {
    await deleteEditCacheDatabase(editCacheDocName(userId, id));
    storageRemove(syncedKey(userId, id));
    unsentNotes.delete(id);
  }
  writeDocRegistry(userId, []);
}

/** ロード時 compaction: update エントリ数が閾値（目安 500）を超えたらマージ済み 1 エントリにする。 */
export function needsCompaction(updateCount: number): boolean {
  return updateCount > EDIT_CACHE_COMPACT_THRESHOLD;
}

/**
 * `persistence.whenSynced`（初回ロード）後に呼び、update ログの肥大化を
 * 潰す。`storeState` が `Y.encodeStateAsUpdate(doc)` のマージ済みエントリを
 * 書き、古い per-update エントリを削除する。
 */
export async function compactEditCache(
  persistence: Pick<IndexeddbPersistence, "_dbsize">,
  store: (persistence: IndexeddbPersistence) => Promise<unknown> = storeState,
): Promise<boolean> {
  if (!needsCompaction(persistence._dbsize)) {
    return false;
  }
  await store(persistence as IndexeddbPersistence);
  return true;
}

/**
 * 編集キャッシュを Y.Doc に接続する。doc 名は userId で名前空間化し、
 * 別アカウントへ見せない。呼び出し側で `isEditCacheEligible` を確認すること。
 */
export function attachEditCache(
  ydoc: Y.Doc,
  noteId: string,
  userId: string,
): IndexeddbPersistence {
  const persistence = new IndexeddbPersistence(
    editCacheDocName(userId, noteId),
    ydoc,
  );
  registerEditCacheDoc(userId, noteId);
  void persistence.whenSynced.then(
    () => compactEditCache(persistence),
    () => {
      // IDB が開けない環境では永続化なしでオンライン編集に縮退する。
    },
  );
  return persistence;
}

/** y-websocket provider のうち未送信判定に必要な最小インターフェース。 */
export type SyncProviderLike = {
  synced: boolean;
  on(event: "sync", listener: (synced: boolean) => void): unknown;
  off(event: "sync", listener: (synced: boolean) => void): unknown;
};

const unsentNotes = new Map<string, boolean>();
const unsentListeners = new Map<string, Set<() => void>>();

/** この端末のセッションで未送信のローカル編集が残っているか。バッジ・purge ガード用。 */
export function hasUnsentEdits(noteId: string): boolean {
  return unsentNotes.get(noteId) === true;
}

export function subscribeUnsentEdits(
  noteId: string,
  listener: () => void,
): () => void {
  let listeners = unsentListeners.get(noteId);
  if (!listeners) {
    listeners = new Set();
    unsentListeners.set(noteId, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      unsentListeners.delete(noteId);
    }
  };
}

function setUnsent(noteId: string, unsent: boolean): void {
  if (unsentNotes.get(noteId) === unsent) {
    return;
  }
  unsentNotes.set(noteId, unsent);
  for (const listener of unsentListeners.get(noteId) ?? []) {
    try {
      listener();
    } catch (error) {
      console.error("Unsent-edits listener failed", error);
    }
  }
}

/**
 * 未送信編集フラグの追跡。ローカル起源（provider・persistence 以外の origin）
 * の update が provider 未同期の間に来たらフラグを立て、次の
 * `provider.synced === true` で下ろす。同期済みの間の編集は provider が
 * 即座に broadcast するためフラグを立てない。
 * 戻り値はリスナー解除関数。
 */
export function trackUnsentEdits(input: {
  noteId: string;
  doc: Pick<Y.Doc, "on" | "off">;
  provider: SyncProviderLike;
  persistence?: unknown;
  /** persistence が遅延アタッチされる場合の動的 origin 判定。 */
  isPersistenceOrigin?: (origin: unknown) => boolean;
}): () => void {
  const onUpdate = (_update: Uint8Array, origin: unknown) => {
    if (origin === input.provider) {
      return;
    }
    if (input.persistence !== undefined && origin === input.persistence) {
      return;
    }
    if (input.isPersistenceOrigin?.(origin) === true) {
      return;
    }
    if (!input.provider.synced) {
      setUnsent(input.noteId, true);
    }
  };
  const onSync = (synced: boolean) => {
    if (synced) {
      setUnsent(input.noteId, false);
    }
  };
  input.doc.on("update", onUpdate);
  input.provider.on("sync", onSync);
  return () => {
    input.doc.off("update", onUpdate);
    input.provider.off("sync", onSync);
  };
}
