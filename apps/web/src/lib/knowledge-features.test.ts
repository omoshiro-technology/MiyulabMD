import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionUser } from "@miyulabmd/shared";
import {
  clearKnowledgeMirror,
  KNOWLEDGE_FEATURE_LIST,
  KNOWLEDGE_FEATURES,
  KNOWLEDGE_MIRROR_SESSION_KEY,
  type KnowledgeMirrorStorages,
  knowledgeMirrorHintKey,
  readKnowledgeMirror,
  resolveKnowledgeSettings,
  type StorageLike,
  writeKnowledgeMirror,
} from "./knowledge-features.ts";

class MemoryStorage implements StorageLike {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

function storages(): Required<KnowledgeMirrorStorages> & {
  session: MemoryStorage;
  hint: MemoryStorage;
} {
  return { hint: new MemoryStorage(), session: new MemoryStorage() };
}

function userWith(knowledge: unknown): SessionUser {
  return {
    displayName: null,
    email: "a@example.com",
    id: "user-a",
    settings: { knowledge: knowledge as never },
  };
}

test("registry has one entry per feature key with expected defaults", () => {
  assert.deepEqual(
    KNOWLEDGE_FEATURE_LIST.map((feature) => feature.key).sort(),
    ["layers", "para", "schemes"],
  );
  // opt-in 原則: 新規フレームワークは OFF、既存の常時 ON 機能は ON のまま。
  assert.equal(KNOWLEDGE_FEATURES.para.defaultEnabled, false);
  assert.equal(KNOWLEDGE_FEATURES.schemes.defaultEnabled, true);
  assert.equal(KNOWLEDGE_FEATURES.layers.defaultEnabled, true);
  for (const feature of KNOWLEDGE_FEATURE_LIST) {
    assert.ok(feature.label.length > 0);
    assert.ok(feature.description.length > 0);
  }
});

test("resolveKnowledgeSettings prefers the server value", () => {
  const store = storages();
  const user = userWith({ para: true });
  assert.deepEqual(resolveKnowledgeSettings(user, store), {
    layers: true,
    para: true,
    schemes: true,
  });
});

test("server value is mirrored for both session and first-paint hint", () => {
  const store = storages();
  const user = userWith({ para: true, schemes: false });
  resolveKnowledgeSettings(user, store);
  const payload = JSON.parse(
    store.session.getItem(KNOWLEDGE_MIRROR_SESSION_KEY) ?? "{}",
  ) as { userId?: string; knowledge?: { para?: boolean } };
  assert.equal(payload.userId, "user-a");
  assert.equal(payload.knowledge?.para, true);
  assert.equal(
    store.hint.getItem(knowledgeMirrorHintKey("user-a")) !== null,
    true,
  );
});

test("mirror userId mismatch is discarded (shared-PC guard)", () => {
  const store = storages();
  writeKnowledgeMirror(
    "user-b",
    { layers: false, para: true, schemes: false },
    store,
  );
  // Different user must not see user-b's flags.
  assert.equal(readKnowledgeMirror("user-a", store), null);
  const other = { ...userWith(null), id: "user-b" };
  assert.equal(resolveKnowledgeSettings(other, store).para, true);
  assert.equal(resolveKnowledgeSettings(userWith(null), store).para, false);
});

test("session mirror wins over the persisted hint", () => {
  const store = storages();
  store.hint.setItem(
    knowledgeMirrorHintKey("user-a"),
    JSON.stringify({
      knowledge: { layers: true, para: false, schemes: true },
      userId: "user-a",
    }),
  );
  writeKnowledgeMirror(
    "user-a",
    { layers: true, para: true, schemes: true },
    store,
  );
  // writeKnowledgeMirror updates both; make the hint diverge to prove order.
  store.hint.setItem(
    knowledgeMirrorHintKey("user-a"),
    JSON.stringify({
      knowledge: { layers: true, para: false, schemes: true },
      userId: "user-a",
    }),
  );
  const resolved = resolveKnowledgeSettings(userWith(null), store);
  assert.equal(resolved.para, true);
});

test("hint is used when the session mirror is empty", () => {
  const store = storages();
  store.hint.setItem(
    knowledgeMirrorHintKey("user-a"),
    JSON.stringify({
      knowledge: { layers: true, para: true, schemes: true },
      userId: "user-a",
    }),
  );
  assert.equal(resolveKnowledgeSettings(userWith(null), store).para, true);
});

test("resolveKnowledgeSettings falls back to defaults for guests and no mirror", () => {
  const store = storages();
  assert.deepEqual(resolveKnowledgeSettings(null, store), {
    layers: true,
    para: false,
    schemes: true,
  });
  assert.equal(resolveKnowledgeSettings(userWith(null), store).para, false);
});

test("clearKnowledgeMirror removes session mirror and per-user hint", () => {
  const store = storages();
  writeKnowledgeMirror(
    "user-a",
    { layers: true, para: true, schemes: true },
    store,
  );
  clearKnowledgeMirror("user-a", store);
  assert.equal(readKnowledgeMirror("user-a", store), null);
});
