import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("license CLI runs from Node, including Windows pnpm.cmd", async () => {
  const script = fileURLToPath(
    new URL("../check-licenses.mjs", import.meta.url),
  );
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
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
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

  assert.equal(result.code, 0, result.stderr);
  assert.match(
    result.stdout,
    /checked [1-9]\d* production packages against the license allowlist/,
  );
});
