import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findLicenseViolations,
  flattenLicenseReport,
  isAllowedLicenseExpression,
  isForbiddenPackage,
  splitTopLevel,
} from "./policy.mjs";

test("allowlist accepts MIT and dual MIT OR Apache-2.0", () => {
  assert.equal(isAllowedLicenseExpression("MIT"), true);
  assert.equal(isAllowedLicenseExpression("MIT OR Apache-2.0"), true);
  assert.equal(isAllowedLicenseExpression("(MIT OR Apache-2.0)"), true);
  assert.equal(isAllowedLicenseExpression("Apache-2.0 AND MIT"), true);
});

test("unknown and copyleft licenses fail until reviewed", () => {
  assert.equal(isAllowedLicenseExpression(""), false);
  assert.equal(isAllowedLicenseExpression("UNKNOWN"), false);
  assert.equal(isAllowedLicenseExpression("GPL-3.0-only"), false);
  assert.equal(isAllowedLicenseExpression("LGPL-3.0-or-later"), false);
  assert.equal(isAllowedLicenseExpression("MIT AND GPL-3.0-only"), false);
});

test("commercial and source-available terms are denied", () => {
  assert.equal(isAllowedLicenseExpression("BUSL-1.1"), false);
  assert.equal(isAllowedLicenseExpression("SSPL-1.0"), false);
  assert.equal(isAllowedLicenseExpression("MIT AND Commons Clause"), false);
  assert.equal(isAllowedLicenseExpression("UNLICENSED"), false);
});

test("own AGPL and current production outliers are allowed", () => {
  assert.equal(isAllowedLicenseExpression("AGPL-3.0-or-later"), true);
  assert.equal(isAllowedLicenseExpression("CC-BY-4.0"), true);
  assert.equal(isAllowedLicenseExpression("BSD-3-Clause"), true);
});

test("tiptap pro packages are forbidden", () => {
  assert.equal(isForbiddenPackage("@tiptap-pro/extension-ai"), true);
  assert.equal(isForbiddenPackage("@tiptap/extension-drag-handle"), false);
});

test("splitTopLevel keeps nested parentheses", () => {
  assert.deepEqual(splitTopLevel("MIT OR (BSD-3-Clause AND ISC)", "OR"), [
    "MIT",
    "(BSD-3-Clause AND ISC)",
  ]);
});

test("flattenLicenseReport reads pnpm grouped objects", () => {
  const packages = flattenLicenseReport({
    MIT: [{ name: "yjs", license: "MIT" }],
    "Apache-2.0": {
      "fast-diff@1.3.0": { name: "fast-diff", license: "Apache-2.0" },
    },
  });
  assert.deepEqual(
    packages.map((pkg) => pkg.name),
    ["fast-diff", "yjs"],
  );
});

test("findLicenseViolations reports name and license", () => {
  const violations = findLicenseViolations([
    { name: "yjs", license: "MIT" },
    { name: "@tiptap-pro/foo", license: "MIT" },
    { name: "secret-lib", license: "BUSL-1.1" },
  ]);
  assert.deepEqual(
    violations.map((item) => item.name),
    ["@tiptap-pro/foo", "secret-lib"],
  );
});
