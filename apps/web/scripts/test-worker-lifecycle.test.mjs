import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { createConnection } from "node:net";
import test from "node:test";
import { fileURLToPath } from "node:url";

function portIsClosed(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(true));
    socket.setTimeout(2000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

test("a failing browser selection propagates failure and removes owned state/listeners", {
  timeout: 330_000,
}, async () => {
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("./test-worker.mjs", import.meta.url)),
      "--grep",
      "__intentional_no_matching_test__",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(text);
    });
  }
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(code, 1);
  assert.match(output, /No tests found/);
  assert.match(output, /owned children stopped; runtime removed/);
  const runtime = /^Local Worker acceptance runtime: (.+)$/m
    .exec(output)?.[1]
    ?.trim();
  assert.ok(runtime, "runner identifies its own ephemeral directory");
  await assert.rejects(access(runtime), { code: "ENOENT" });
  const ports = [
    ...output.matchAll(/Ready on http:\/\/127\.0\.0\.1:(\d+)/g),
  ].map((match) => Number(match[1]));
  assert.ok(ports.length >= 2, "both real local Workers started");
  for (const port of new Set(ports)) {
    assert.equal(
      await portIsClosed(port),
      true,
      `owned port ${port} is closed`,
    );
  }
});
