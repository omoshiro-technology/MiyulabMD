import assert from "node:assert/strict";
import { test } from "node:test";
import {
  layerFilterValue,
  paraFilterValue,
  parseSearchQuery,
  pathFilterMatches,
  schemeFilterValue,
  tagFilterValue,
  tokenizeSearchQuery,
} from "./search-dsl.ts";

test("parseSearchQuery treats plain words as ANDed terms", () => {
  const parsed = parseSearchQuery("medallion design");
  assert.deepEqual(parsed.terms, [
    { negated: false, value: "medallion" },
    { negated: false, value: "design" },
  ]);
  assert.deepEqual(parsed.filters, []);
  assert.equal(parsed.hasOperators, false);
});

test("parseSearchQuery keeps quoted phrases together", () => {
  const parsed = parseSearchQuery('"exact phrase" tail');
  assert.deepEqual(parsed.terms, [
    { negated: false, value: "exact phrase" },
    { negated: false, value: "tail" },
  ]);
});

test("parseSearchQuery lowercases terms but keeps negation", () => {
  const parsed = parseSearchQuery('Draft -ARCHIVE -"old stuff"');
  assert.deepEqual(parsed.terms, [
    { negated: false, value: "draft" },
    { negated: true, value: "archive" },
    { negated: true, value: "old stuff" },
  ]);
});

test("parseSearchQuery parses all supported operators", () => {
  const parsed = parseSearchQuery(
    "path:Knowledge tag:arch layer:output scheme:15.22 jd:10.05 para:projects -path:Archives term",
  );
  assert.equal(parsed.hasOperators, true);
  assert.deepEqual(parsed.filters, [
    { kind: "path", negated: false, value: "Knowledge" },
    { kind: "tag", negated: false, value: "arch" },
    { kind: "layer", negated: false, value: "output" },
    { kind: "scheme", negated: false, value: "15.22" },
    { kind: "jd", negated: false, value: "10.05" },
    { kind: "para", negated: false, value: "projects" },
    { kind: "path", negated: true, value: "Archives" },
  ]);
  assert.deepEqual(parsed.terms, [{ negated: false, value: "term" }]);
});

test("parseSearchQuery keeps unknown operators as terms and drops empty values", () => {
  const parsed = parseSearchQuery("foo:bar path: -");
  // `foo` is not a known operator → term. `path:` is known but empty → dropped.
  assert.equal(parsed.hasOperators, true);
  assert.deepEqual(parsed.filters, []);
  assert.deepEqual(
    parsed.terms.map((t) => t.value),
    // a lone `-` is not negation — it stays a literal term
    ["foo:bar", "-"],
  );
});

test("parseSearchQuery treats a lone colon-less token with operator name as term", () => {
  const parsed = parseSearchQuery("layer");
  assert.deepEqual(parsed.terms, [{ negated: false, value: "layer" }]);
  assert.equal(parsed.hasOperators, false);
});

test("tokenizeSearchQuery keeps quotes inside phrases and drops empty tokens", () => {
  assert.deepEqual(tokenizeSearchQuery('  a  "b c"  d '), ["a", '"b c"', "d"]);
});

test("pathFilterMatches covers the folder itself and subtrees", () => {
  assert.equal(pathFilterMatches("Knowledge", "Knowledge"), true);
  assert.equal(pathFilterMatches("Knowledge/Sub", "Knowledge"), true);
  assert.equal(pathFilterMatches("KnowledgeBase", "Knowledge"), false);
  assert.equal(pathFilterMatches("", "/"), true);
  assert.equal(pathFilterMatches("Knowledge", "/Knowledge/"), true);
});

test("tagFilterValue normalizes the leading #", () => {
  assert.equal(tagFilterValue("arch"), "#arch");
  assert.equal(tagFilterValue("#arch"), "#arch");
});

test("layerFilterValue accepts layer keys and set-qualified keys", () => {
  assert.deepEqual(layerFilterValue("OUTPUT"), { layer: "output" });
  assert.deepEqual(layerFilterValue("精緻度.output"), {
    layer: "output",
    set: "精緻度",
  });
  // set names may contain dots — split at the LAST dot
  assert.deepEqual(layerFilterValue("my.set.knowledge"), {
    layer: "knowledge",
    set: "my.set",
  });
  assert.equal(layerFilterValue(""), null);
  assert.equal(layerFilterValue("set."), null);
  assert.equal(layerFilterValue(".key"), null);
  assert.equal(layerFilterValue("bad key!"), null);
});

test("paraFilterValue validates against PARA bucket keys", () => {
  assert.deepEqual(paraFilterValue("Projects"), { bucket: "projects" });
  assert.equal(paraFilterValue("random"), null);
});

test("paraFilterValue splits a space qualifier at the last dot", () => {
  assert.deepEqual(paraFilterValue("work.projects"), {
    bucket: "projects",
    space: "work",
  });
  // Space names may contain dots — the bucket is always the last segment.
  assert.deepEqual(paraFilterValue("my.work.Resources"), {
    bucket: "resources",
    space: "my.work",
  });
  // Dotted value without a valid bucket tail is not a para filter.
  assert.equal(paraFilterValue("work.random"), null);
  assert.equal(paraFilterValue(".projects"), null);
});

test("schemeFilterValue strips an explicit scheme prefix", () => {
  assert.equal(schemeFilterValue("15.22"), "15.22");
  assert.equal(schemeFilterValue("jd:15.22"), "15.22");
  assert.equal(schemeFilterValue("unknown:15.22"), "unknown:15.22");
  assert.equal(schemeFilterValue("  "), null);
});
