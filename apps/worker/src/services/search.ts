import type { GrepMatch, GrepResult } from "@miyulabmd/shared";

export const GREP_DEFAULTS = {
  contextAfter: 1,
  contextBefore: 1,
  maxMatchesPerNote: 10,
  maxNotes: 50,
} as const;

export const GREP_LIMITS = {
  /** Abort the scan after this wall-clock budget. */
  deadlineMs: 1500,
  maxContext: 5,
  maxMatchesPerNote: 50,
  maxNotes: 200,
  maxPatternLength: 500,
  /** Deterministic bounds so huge drives stop before the CPU budget does. */
  maxScanChars: 2_000_000,
  maxScanNotes: 500,
} as const;

export type GrepRow = {
  id: string;
  title: string;
  markdown_snapshot: string | null;
  snapshot_updated_at: number | null;
};

export type LineMatcher = {
  /** First match inside a single line, or null. Index is 0-based. */
  match(line: string): { index: number; length: number } | null;
};

export function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

export function createLineMatcher(
  pattern: string,
  options: { caseSensitive?: boolean; fixedString?: boolean } = {},
):
  | { kind: "ok"; matcher: LineMatcher }
  | { kind: "bad_request"; error: string } {
  if (!pattern) {
    return { error: "pattern is required", kind: "bad_request" };
  }
  if (pattern.length > GREP_LIMITS.maxPatternLength) {
    return {
      error: `pattern must be at most ${GREP_LIMITS.maxPatternLength} characters`,
      kind: "bad_request",
    };
  }

  const caseSensitive = options.caseSensitive ?? false;
  if (options.fixedString ?? true) {
    const needle = caseSensitive ? pattern : pattern.toLowerCase();
    return {
      kind: "ok",
      matcher: {
        match(line) {
          const haystack = caseSensitive ? line : line.toLowerCase();
          const index = haystack.indexOf(needle);
          return index === -1 ? null : { index, length: needle.length };
        },
      },
    };
  }

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, caseSensitive ? "" : "i");
  } catch {
    return { error: "invalid regular expression", kind: "bad_request" };
  }
  return {
    kind: "ok",
    matcher: {
      match(line) {
        const hit = regex.exec(line);
        return hit ? { index: hit.index, length: hit[0].length } : null;
      },
    },
  };
}

function clampInt(
  value: number | undefined,
  fallback: number,
  max: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  return Math.max(0, Math.min(Math.trunc(value), max));
}

export type GrepScanOptions = {
  globTitle?: string;
  maxMatchesPerNote?: number;
  maxNotes?: number;
  contextBefore?: number;
  contextAfter?: number;
  deadlineMs?: number;
};

type GrepScanConfig = {
  maxMatchesPerNote: number;
  maxNotes: number;
  contextBefore: number;
  contextAfter: number;
  deadline: number;
  titleFilter: RegExp | null;
};

function resolveScanConfig(options: GrepScanOptions): GrepScanConfig {
  return {
    contextAfter: clampInt(
      options.contextAfter,
      GREP_DEFAULTS.contextAfter,
      GREP_LIMITS.maxContext,
    ),
    contextBefore: clampInt(
      options.contextBefore,
      GREP_DEFAULTS.contextBefore,
      GREP_LIMITS.maxContext,
    ),
    deadline: Date.now() + (options.deadlineMs ?? GREP_LIMITS.deadlineMs),
    maxMatchesPerNote: clampInt(
      options.maxMatchesPerNote,
      GREP_DEFAULTS.maxMatchesPerNote,
      GREP_LIMITS.maxMatchesPerNote,
    ),
    maxNotes: Math.max(
      1,
      Math.min(
        Math.trunc(options.maxNotes ?? GREP_DEFAULTS.maxNotes),
        GREP_LIMITS.maxNotes,
      ),
    ),
    titleFilter: options.globTitle ? globToRegExp(options.globTitle) : null,
  };
}

function scanNoteLines(
  row: GrepRow,
  lines: readonly string[],
  matcher: LineMatcher,
  config: GrepScanConfig,
): { matches: GrepMatch[]; truncated: boolean } {
  const matches: GrepMatch[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (matches.length >= config.maxMatchesPerNote) {
      return { matches, truncated: true };
    }
    const text = lines[index] ?? "";
    const hit = matcher.match(text);
    if (!hit) {
      continue;
    }
    matches.push({
      after: lines.slice(index + 1, index + 1 + config.contextAfter),
      before: lines.slice(Math.max(0, index - config.contextBefore), index),
      column: hit.index + 1,
      line: index + 1,
      noteId: row.id,
      snapshotUpdatedAt: row.snapshot_updated_at,
      text,
      title: row.title,
    });
  }
  return { matches, truncated: false };
}

/**
 * Line-scan already permission-filtered rows. Callers must pass only rows the
 * user may view; this function never widens visibility.
 */
export function grepRows(
  rows: readonly GrepRow[],
  matcher: LineMatcher,
  options: GrepScanOptions = {},
): GrepResult {
  const config = resolveScanConfig(options);
  const matches: GrepMatch[] = [];
  let scannedNotes = 0;
  let scannedChars = 0;
  let matchedNotes = 0;
  let truncated = false;

  for (const row of rows) {
    if (
      matchedNotes >= config.maxNotes ||
      scannedNotes >= GREP_LIMITS.maxScanNotes ||
      Date.now() > config.deadline
    ) {
      truncated = true;
      break;
    }
    if (config.titleFilter && !config.titleFilter.test(row.title)) {
      continue;
    }

    const snapshot = row.markdown_snapshot ?? "";
    scannedNotes += 1;
    scannedChars += snapshot.length;
    if (scannedChars > GREP_LIMITS.maxScanChars) {
      truncated = true;
      break;
    }

    const scanned = scanNoteLines(row, snapshot.split("\n"), matcher, config);
    matches.push(...scanned.matches);
    if (scanned.truncated) {
      truncated = true;
    }
    if (scanned.matches.length > 0) {
      matchedNotes += 1;
    }
  }

  return { matches, scannedNotes, truncated };
}
