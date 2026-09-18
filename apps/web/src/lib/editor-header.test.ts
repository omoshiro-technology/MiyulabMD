import assert from "node:assert/strict";
import { test } from "node:test";
import {
  folderMenuContext,
  headerBarItems,
  headerTierForWidth,
  lockMenuContext,
  menuItemTierClass,
  overflowMenuItems,
} from "./editor-header.ts";

test("headerTierForWidth uses the existing 900px / 640px breakpoints", () => {
  assert.equal(headerTierForWidth(1280), "full");
  assert.equal(headerTierForWidth(900), "full");
  assert.equal(headerTierForWidth(899), "compact");
  assert.equal(headerTierForWidth(640), "compact");
  assert.equal(headerTierForWidth(639), "minimal");
  assert.equal(headerTierForWidth(0), "minimal");
});

test("headerTierForWidth treats non-finite widths as full", () => {
  assert.equal(headerTierForWidth(Number.NaN), "full");
  assert.equal(headerTierForWidth(Number.POSITIVE_INFINITY), "full");
});

test("headerBarItems keeps the primary nav on every tier", () => {
  for (const tier of ["full", "compact", "minimal"] as const) {
    const items = headerBarItems(tier);
    assert.ok(items.includes("overflow"));
    assert.ok(items.includes("share"));
    assert.equal(items.at(-1), "account");
  }
});

test("headerBarItems shows conditional items only when flagged", () => {
  assert.deepEqual(headerBarItems("full"), [
    "search",
    "folder",
    "overflow",
    "share",
    "account",
  ]);
  assert.deepEqual(
    headerBarItems("full", { hasPeers: true, hasSiteSource: true }),
    [
      "search",
      "siteUpdate",
      "presence",
      "folder",
      "overflow",
      "share",
      "account",
    ],
  );
});

test("headerBarItems retreats siteUpdate into the menu below 900px", () => {
  const compact = headerBarItems("compact", {
    hasPeers: true,
    hasSiteSource: true,
  });
  assert.ok(!compact.includes("siteUpdate"));
  assert.ok(compact.includes("presence"));
  assert.ok(compact.includes("search"));
});

test("headerBarItems is minimal below 640px", () => {
  assert.deepEqual(
    headerBarItems("minimal", { hasPeers: true, hasSiteSource: true }),
    ["overflow", "share", "account"],
  );
});

test("overflowMenuItems collects secondary items at every tier", () => {
  assert.deepEqual(overflowMenuItems("full"), [
    "folder",
    "links",
    "history",
    "lock",
  ]);
  assert.deepEqual(overflowMenuItems("compact"), [
    "folder",
    "links",
    "history",
    "lock",
  ]);
});

test("overflowMenuItems adds siteUpdate below 900px when a source matches", () => {
  assert.deepEqual(overflowMenuItems("compact", { hasSiteSource: true }), [
    "folder",
    "links",
    "history",
    "lock",
    "siteUpdate",
  ]);
  // ボタンが見えている ≥900px ではメニューに出さない。
  assert.ok(
    !overflowMenuItems("full", { hasSiteSource: true }).includes("siteUpdate"),
  );
});

test("overflowMenuItems puts search first and presence last below 640px", () => {
  assert.deepEqual(
    overflowMenuItems("minimal", { hasPeers: true, hasSiteSource: true }),
    ["search", "folder", "links", "history", "lock", "siteUpdate", "presence"],
  );
  assert.deepEqual(overflowMenuItems("minimal"), [
    "search",
    "folder",
    "links",
    "history",
    "lock",
  ]);
});

test("menuItemTierClass hides items outside their tiers", () => {
  assert.equal(menuItemTierClass("search"), "min-[640px]:hidden");
  assert.equal(menuItemTierClass("presence"), "min-[640px]:hidden");
  assert.equal(menuItemTierClass("siteUpdate"), "min-[900px]:hidden");
  assert.equal(menuItemTierClass("folder"), "");
  assert.equal(menuItemTierClass("links"), "");
  assert.equal(menuItemTierClass("history"), "");
  assert.equal(menuItemTierClass("lock"), "");
});

test("folderMenuContext shows the current folder or なし", () => {
  assert.equal(folderMenuContext("knowledge/メモ"), "knowledge/メモ");
  assert.equal(folderMenuContext(""), "なし");
  assert.equal(folderMenuContext("  "), "なし");
});

test("lockMenuContext reports the edit-lock state and medallion label", () => {
  assert.equal(lockMenuContext({ editLocked: true }), "ロック中");
  assert.equal(lockMenuContext({ editLocked: false }), "未ロック");
  assert.equal(
    lockMenuContext(
      { editLocked: false },
      {
        assignedPath: "knowledge",
        layerIndex: 1,
        layerKey: "knowledge",
        layerLabel: "知識",
        setId: "set-1",
        setName: "精緻度",
      },
    ),
    "知識",
  );
});
