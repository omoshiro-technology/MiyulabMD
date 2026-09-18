/**
 * Obsidian-style query DSL, parsed from a single search string:
 *   medallion "exact phrase" -draft path:Knowledge tag:arch layer:gold
 * Text terms are ANDed substring matches (title or body); `"..."` phrases
 * keep spaces; a leading `-` negates a term, phrase, or operator.
 * Operators map to structured filters resolved by the worker.
 */
import { isMedallionLayerKey } from "./medallion.ts";
import { isParaBucketKey, type ParaBucketKey } from "./move.ts";
import { isNamingScheme } from "./schemes.ts";

export const SEARCH_DSL_OPERATORS = [
  "path",
  "tag",
  "layer",
  "scheme",
  "jd",
  "para",
] as const;
export type SearchDslOperator = (typeof SEARCH_DSL_OPERATORS)[number];

export type SearchTerm = {
  /** Lowercased substring (phrases keep their inner spaces). */
  value: string;
  negated: boolean;
};

export type SearchDslFilter = {
  kind: SearchDslOperator;
  value: string;
  negated: boolean;
};

export type SearchQuery = {
  /** ANDed text terms and phrases (title-or-body substring). */
  terms: SearchTerm[];
  filters: SearchDslFilter[];
  /** True when at least one `key:` operator appeared. */
  hasOperators: boolean;
};

function isOperator(value: string): value is SearchDslOperator {
  return (SEARCH_DSL_OPERATORS as readonly string[]).includes(value);
}

/**
 * Split the raw query on whitespace while keeping "..." phrases together.
 * Returns raw tokens (quotes retained on phrases).
 */
export function tokenizeSearchQuery(raw: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inPhrase = false;
  for (const char of raw) {
    if (char === '"') {
      inPhrase = !inPhrase;
      current += char;
      continue;
    }
    if (inPhrase) {
      current += char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

type ParsedToken =
  | { kind: "term"; term: SearchTerm }
  | { kind: "filter"; filter: SearchDslFilter }
  | { kind: "operator-only" } // known operator with empty value → dropped
  | { kind: "empty" };

/** Parse one raw token into a term, a filter, or a dropped operator. */
function parseToken(token: string): ParsedToken {
  const negated = token.startsWith("-") && token.length > 1;
  const body = negated ? token.slice(1) : token;
  if (!body) {
    return { kind: "empty" };
  }
  if (body.startsWith('"') && body.endsWith('"') && body.length > 2) {
    return {
      kind: "term",
      term: { negated, value: body.slice(1, -1).toLowerCase() },
    };
  }
  const colon = body.indexOf(":");
  if (colon > 0) {
    const key = body.slice(0, colon).toLowerCase();
    const value = body.slice(colon + 1);
    if (isOperator(key)) {
      return value
        ? { filter: { kind: key, negated, value }, kind: "filter" }
        : { kind: "operator-only" };
    }
  }
  return { kind: "term", term: { negated, value: body.toLowerCase() } };
}

export function parseSearchQuery(raw: string): SearchQuery {
  const terms: SearchTerm[] = [];
  const filters: SearchDslFilter[] = [];
  let hasOperators = false;

  for (const token of tokenizeSearchQuery(raw)) {
    const parsed = parseToken(token);
    if (parsed.kind === "filter") {
      hasOperators = true;
      filters.push(parsed.filter);
    } else if (parsed.kind === "operator-only") {
      hasOperators = true;
    } else if (parsed.kind === "term") {
      terms.push(parsed.term);
    }
  }
  return { filters, hasOperators, terms };
}

/** `tag:` accepts both `tag:foo` and `tag:#foo`; stored as `#foo`. */
export function tagFilterValue(value: string): string {
  return value.startsWith("#") ? value : `#${value}`;
}

/** `path:` matches the folder itself and its subtree. */
export function pathFilterMatches(folder: string, value: string): boolean {
  const normalized = value.replace(/^\/+|\/+$/g, "");
  if (!normalized) {
    return folder === "";
  }
  return folder === normalized || folder.startsWith(`${normalized}/`);
}

export type LayerFilterValue = {
  /** Layer key inside a medallion set (e.g. `output`). */
  layer: string;
  /**
   * §2.6: optional set-name qualifier (`layer:精緻度.output`). The split is
   * at the LAST dot so set names may contain dots themselves.
   */
  set?: string;
};

/**
 * `layer:output` matches the layer key across every medallion set;
 * `layer:<set>.<key>` pins one set. Effective layers resolve through
 * folder assignment (nearest ancestor wins) on the worker.
 */
export function layerFilterValue(value: string): LayerFilterValue | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const dot = trimmed.lastIndexOf(".");
  if (dot < 0) {
    const layer = trimmed.toLowerCase();
    return isMedallionLayerKey(layer) ? { layer } : null;
  }
  const set = trimmed.slice(0, dot).trim();
  const layer = trimmed.slice(dot + 1).toLowerCase();
  if (!(set && isMedallionLayerKey(layer))) {
    return null;
  }
  return { layer, set };
}

export type ParaFilterValue = {
  bucket: ParaBucketKey;
  /** §2.5: space name qualifier (`para:work.projects`); omitted = all spaces. */
  space?: string;
};

/**
 * `para:projects` targets the bucket across all spaces; `para:work.projects`
 * pins one space. The split is at the LAST dot so space names may contain
 * dots themselves.
 */
export function paraFilterValue(value: string): ParaFilterValue | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const dot = trimmed.lastIndexOf(".");
  if (dot < 0) {
    const bucket = trimmed.toLowerCase();
    return isParaBucketKey(bucket) ? { bucket } : null;
  }
  const space = trimmed.slice(0, dot).trim();
  const bucket = trimmed.slice(dot + 1).toLowerCase();
  if (!(space && isParaBucketKey(bucket))) {
    return null;
  }
  return { bucket, space };
}

/** `scheme:`/`jd:` filter values must look like a scheme ID. */
export function schemeFilterValue(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  // `jd:15.22` arrives as kind "jd"; `scheme:jd:15.22` keeps the prefix.
  if (!trimmed.includes(":")) {
    return trimmed;
  }
  const prefix = trimmed.split(":")[0] ?? "";
  return isNamingScheme(prefix)
    ? trimmed.slice(trimmed.indexOf(":") + 1)
    : trimmed;
}
