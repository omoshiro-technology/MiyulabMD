import assert from "node:assert/strict";
import { test } from "node:test";
import {
  indentTabSize,
  indentUnitText,
  isIndentUnit,
  isTabKeyMode,
  readIndentUnit,
  readTabHintDismissed,
  readTabKeyMode,
  writeIndentUnit,
  writeTabHintDismissed,
  writeTabKeyMode,
} from "./editor-tab.ts";

type Store = {
  getItem(key: string): string | null;
  setItem(k: string, v: string): void;
};

function withStorage(run: () => void) {
  const data = new Map<string, string>();
  const previous = (globalThis as { localStorage?: Store }).localStorage;
  (globalThis as { localStorage?: Store }).localStorage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
  try {
    run();
  } finally {
    if (previous === undefined) {
      (globalThis as { localStorage?: Store }).localStorage = undefined;
    } else {
      (globalThis as { localStorage?: Store }).localStorage = previous;
    }
  }
}

test("isTabKeyMode and isIndentUnit validate stored values", () => {
  assert.equal(isTabKeyMode("indent"), true);
  assert.equal(isTabKeyMode("focus"), true);
  assert.equal(isTabKeyMode("other"), false);
  assert.equal(isIndentUnit("2"), true);
  assert.equal(isIndentUnit("4"), true);
  assert.equal(isIndentUnit("tab"), true);
  assert.equal(isIndentUnit("8"), false);
});

test("Tab key mode defaults to indent and round-trips", () =>
  withStorage(() => {
    assert.equal(readTabKeyMode(), "indent");
    writeTabKeyMode("focus");
    assert.equal(readTabKeyMode(), "focus");
    writeTabKeyMode("indent");
    assert.equal(readTabKeyMode(), "indent");
  }));

test("invalid stored values fall back to defaults", () =>
  withStorage(() => {
    (globalThis as { localStorage: Store }).localStorage.setItem(
      "miyulabmd:editor-tab-key",
      "bogus",
    );
    (globalThis as { localStorage: Store }).localStorage.setItem(
      "miyulabmd:editor-indent-unit",
      "7",
    );
    assert.equal(readTabKeyMode(), "indent");
    assert.equal(readIndentUnit(), "2");
  }));

test("indent unit round-trips and maps to inserted text", () =>
  withStorage(() => {
    assert.equal(readIndentUnit(), "2");
    writeIndentUnit("tab");
    assert.equal(readIndentUnit(), "tab");
    assert.equal(indentUnitText("tab"), "\t");
    assert.equal(indentUnitText("2"), "  ");
    assert.equal(indentUnitText("4"), "    ");
    assert.equal(indentTabSize("2"), 2);
    assert.equal(indentTabSize("4"), 4);
    assert.equal(indentTabSize("tab"), 4);
  }));

test("first-use hint dismissal persists", () =>
  withStorage(() => {
    assert.equal(readTabHintDismissed(), false);
    writeTabHintDismissed();
    assert.equal(readTabHintDismissed(), true);
  }));

test("readers fall back when localStorage throws", () => {
  const previous = (globalThis as { localStorage?: unknown }).localStorage;
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem() {
      throw new Error("denied");
    },
    setItem() {
      throw new Error("denied");
    },
  };
  try {
    assert.equal(readTabKeyMode(), "indent");
    assert.equal(readIndentUnit(), "2");
    assert.equal(readTabHintDismissed(), false);
  } finally {
    if (previous === undefined) {
      (globalThis as { localStorage?: unknown }).localStorage = undefined;
    } else {
      (globalThis as { localStorage?: unknown }).localStorage = previous;
    }
  }
});
