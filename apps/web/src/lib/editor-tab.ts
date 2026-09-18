export const TAB_KEY_MODES = ["indent", "focus"] as const;
export type TabKeyMode = (typeof TAB_KEY_MODES)[number];

export const INDENT_UNITS = ["2", "4", "tab"] as const;
export type IndentUnit = (typeof INDENT_UNITS)[number];

export const TAB_KEY_LABELS: Record<TabKeyMode, string> = {
  focus: "フォーカスを移動",
  indent: "インデントを挿入",
};

export const INDENT_UNIT_LABELS: Record<IndentUnit, string> = {
  "2": "スペース 2つ",
  "4": "スペース 4つ",
  tab: "タブ文字",
};

const TAB_KEY_STORAGE = "miyulabmd:editor-tab-key";
const INDENT_UNIT_STORAGE = "miyulabmd:editor-indent-unit";
const HINT_STORAGE = "miyulabmd:editor-tab-hint-dismissed";

export function isTabKeyMode(value: string): value is TabKeyMode {
  return (TAB_KEY_MODES as readonly string[]).includes(value);
}

export function isIndentUnit(value: string): value is IndentUnit {
  return (INDENT_UNITS as readonly string[]).includes(value);
}

export function readTabKeyMode(): TabKeyMode {
  try {
    const stored = localStorage.getItem(TAB_KEY_STORAGE) ?? "";
    return isTabKeyMode(stored) ? stored : "indent";
  } catch {
    return "indent";
  }
}

export function writeTabKeyMode(mode: TabKeyMode): void {
  try {
    localStorage.setItem(TAB_KEY_STORAGE, mode);
  } catch {
    // ignore
  }
}

export function readIndentUnit(): IndentUnit {
  try {
    const stored = localStorage.getItem(INDENT_UNIT_STORAGE) ?? "";
    return isIndentUnit(stored) ? stored : "2";
  } catch {
    return "2";
  }
}

export function writeIndentUnit(unit: IndentUnit): void {
  try {
    localStorage.setItem(INDENT_UNIT_STORAGE, unit);
  } catch {
    // ignore
  }
}

/** Text inserted for one indent level; also drives CodeMirror's indentUnit. */
export function indentUnitText(unit: IndentUnit): string {
  return unit === "tab" ? "\t" : " ".repeat(Number(unit));
}

/** CodeMirror tabSize matching the unit (controls display width of \t). */
export function indentTabSize(unit: IndentUnit): number {
  return unit === "2" ? 2 : 4;
}

export function readTabHintDismissed(): boolean {
  try {
    return localStorage.getItem(HINT_STORAGE) === "1";
  } catch {
    return false;
  }
}

export function writeTabHintDismissed(): void {
  try {
    localStorage.setItem(HINT_STORAGE, "1");
  } catch {
    // ignore
  }
}
