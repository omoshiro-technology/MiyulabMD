#!/usr/bin/env node

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  findLicenseViolations,
  flattenLicenseReport,
} from "./check-licenses/policy.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * @returns {Promise<unknown>}
 */
function readPnpmLicenseReport() {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["licenses", "list", "--prod", "--json"], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `pnpm licenses list --prod --json failed (${code})\n${stderr}`,
          ),
        );
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(
          new Error(`failed to parse pnpm license JSON: ${error.message}`),
        );
      }
    });
  });
}

const report = await readPnpmLicenseReport();
const packages = flattenLicenseReport(
  /** @type {Record<string, unknown>} */ (report),
);
const violations = findLicenseViolations(packages);

console.log(
  `checked ${packages.length} production packages against the license allowlist`,
);

if (violations.length === 0) {
  process.exit(0);
}

console.error("license policy violations:");
for (const item of violations) {
  console.error(`- ${item.name}: ${item.license} (${item.reason})`);
}
console.error(
  "review docs/licenses.md before adding a SPDX id to scripts/check-licenses/policy.mjs",
);
process.exit(1);
