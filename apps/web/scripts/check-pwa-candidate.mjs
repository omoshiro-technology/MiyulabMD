import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, preview } from "vite";
import { pwaHttpFixture } from "./pwa-http-fixture.mjs";

const webRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = path.resolve(webRoot, "../..");
const candidateRoot = path.resolve(process.argv[2] ?? "");
const relative = path.relative(repoRoot, candidateRoot);
if (
  !process.argv[2] ||
  relative.startsWith("..") ||
  path.isAbsolute(relative) ||
  candidateRoot === webRoot
) {
  throw new Error(
    "Usage: check-pwa-candidate.mjs <candidate-directory> [specs...]",
  );
}

const rootFiles = new Set([
  "index.html",
  "package.json",
  "tsconfig.json",
  "tsconfig.sw.json",
  "vite.config.ts",
]);
const sourceDirectories = ["src", "public", "service-worker"];
const allowedTarget = (name) =>
  typeof name === "string" &&
  !name.includes("\\") &&
  !name.endsWith("/") &&
  path.posix.normalize(name) === name &&
  !path.isAbsolute(name) &&
  (rootFiles.has(name) ||
    ["src/", "public/", "service-worker/", "scripts/"].some((prefix) =>
      name.startsWith(prefix),
    ));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function collect(directory, optional = false, prefix = "") {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (optional && error.code === "ENOENT") {
      return new Map();
    }
    throw error;
  }
  const result = new Map();
  for (const entry of entries) {
    const name = `${prefix}${entry.name}`;
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Symlink input is not supported: ${file}`);
    }
    if (entry.isDirectory()) {
      for (const [key, value] of await collect(file, false, `${name}/`)) {
        result.set(key, value);
      }
    } else if (entry.isFile()) {
      result.set(name, await readFile(file));
    }
  }
  return result;
}

async function liveInputs() {
  const result = new Map();
  for (const name of rootFiles) {
    try {
      result.set(name, await readFile(path.join(webRoot, name)));
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }
  for (const directory of [...sourceDirectories, "scripts"]) {
    for (const [name, bytes] of await collect(
      path.join(webRoot, directory),
      true,
      `${directory}/`,
    )) {
      result.set(name, bytes);
    }
  }
  return result;
}

function assertUnchanged(before, after, label) {
  if (before.size !== after.size) {
    throw new Error(`${label} file set changed during validation`);
  }
  for (const [name, bytes] of before) {
    if (!after.get(name)?.equals(bytes)) {
      throw new Error(`${label} changed during validation: ${name}`);
    }
  }
}

async function packageBin(packageName, command) {
  const manifestPath = fileURLToPath(
    import.meta.resolve(`${packageName}/package.json`),
  );
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  return path.resolve(path.dirname(manifestPath), manifest.bin[command]);
}

async function runNode(args) {
  const child = spawn(process.execPath, args, {
    cwd: webRoot,
    stdio: "inherit",
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (code !== 0) {
    throw new Error(`Validation exited ${code}: ${args.join(" ")}`);
  }
}

async function unusedPort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  await new Promise((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  if (!address || typeof address === "string") {
    throw new Error("Could not select a preview port");
  }
  return address.port;
}

const originalCandidates = await collect(candidateRoot);
const candidates = new Map();
const deletedFiles = JSON.parse(
  originalCandidates.get("deleted-files.json")?.toString() ?? "[]",
);
if (
  !Array.isArray(deletedFiles) ||
  deletedFiles.some((name) => !allowedTarget(name))
) {
  throw new Error(
    "deleted-files.json must contain normalized Web-relative file paths",
  );
}
for (const [name, bytes] of originalCandidates) {
  if (name.endsWith(".md") || name === "deleted-files.json") {
    continue;
  }
  if (!allowedTarget(name)) {
    throw new Error(`Unsupported PWA candidate target: ${name}`);
  }
  candidates.set(name, bytes);
  console.log(`PWA candidate SHA256 ${hash(bytes)} ${name}`);
}
for (const name of deletedFiles) {
  if (candidates.has(name)) {
    throw new Error(`Candidate both replaces and deletes ${name}`);
  }
  console.log(`PWA candidate removes ${name}`);
}
const originals = await liveInputs();
if (candidates.has("package.json")) {
  const proposed = JSON.parse(candidates.get("package.json").toString());
  const installed = JSON.parse(originals.get("package.json").toString());
  for (const group of ["dependencies", "devDependencies"]) {
    const names = new Set([
      ...Object.keys(proposed[group] ?? {}),
      ...Object.keys(installed[group] ?? {}),
    ]);
    for (const name of names) {
      if (installed[group]?.[name] !== proposed[group]?.[name]) {
        throw new Error(
          `Install the declared test dependency before validation: ${name}`,
        );
      }
    }
  }
}

const cacheRoot = path.join(webRoot, "node_modules/.cache/pwa-candidate");
await mkdir(cacheRoot, { recursive: true });
const runRoot = await mkdtemp(path.join(cacheRoot, "run-"));
let server;
try {
  const inputs = new Map([...originals, ...candidates]);
  for (const name of deletedFiles) {
    inputs.delete(name);
  }
  for (const [name, bytes] of inputs) {
    const destination = path.join(runRoot, name);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
  }
  // Keep external tsconfig inheritance rooted in the actual repository.
  for (const name of ["tsconfig.json", "tsconfig.sw.json"]) {
    const configPath = path.join(runRoot, name);
    let config;
    try {
      config = JSON.parse(await readFile(configPath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    if (typeof config.extends === "string") {
      const resolved = path.resolve(webRoot, config.extends);
      if (path.relative(webRoot, resolved).startsWith("..")) {
        config.extends = resolved;
        await writeFile(configPath, JSON.stringify(config));
      }
    }
    await runNode([
      await packageBin("typescript", "tsc"),
      "--project",
      configPath,
      "--noEmit",
    ]);
  }
  const lintFiles = [...candidates.keys()]
    .filter((name) => /\.(?:[cm]?js|jsx|ts|tsx|json|jsonc)$/.test(name))
    .map((name) => path.join(candidateRoot, name));
  if (lintFiles.length) {
    await runNode([
      await packageBin("@biomejs/biome", "biome"),
      "check",
      ...lintFiles,
    ]);
  }
  await build({
    build: { emptyOutDir: true, outDir: path.join(runRoot, "dist") },
    configFile: path.join(runRoot, "vite.config.ts"),
    root: runRoot,
  });
  const port = await unusedPort();
  server = await preview({
    configFile: path.join(runRoot, "vite.config.ts"),
    plugins: [pwaHttpFixture(runRoot)],
    preview: { host: "127.0.0.1", port, proxy: {}, strictPort: true },
    root: runRoot,
  });
  const address = server.httpServer.address();
  if (!address || typeof address === "string" || address.port !== port) {
    throw new Error("Preview server did not use the allocated port");
  }
  const configFile = path.join(runRoot, "playwright.config.mjs");
  await writeFile(
    configFile,
    `import base from ${JSON.stringify(new URL("../playwright.pwa.config.ts", import.meta.url).href)};
export default {
  ...base,
  testDir: ${JSON.stringify(path.join(webRoot, "tests/pwa"))},
  outputDir: ${JSON.stringify(path.join(runRoot, "results"))},
  webServer: undefined,
  use: { ...base.use, baseURL: ${JSON.stringify(`http://127.0.0.1:${port}`)} },
};`,
  );
  await runNode([
    path.join(webRoot, "scripts/playwright.mjs"),
    "test",
    "--config",
    configFile,
    ...process.argv.slice(3),
  ]);
} finally {
  try {
    if (server) {
      await new Promise((resolve, reject) =>
        server.httpServer.close((error) => (error ? reject(error) : resolve())),
      );
    }
    assertUnchanged(originals, await liveInputs(), "Live PWA input");
    assertUnchanged(
      originalCandidates,
      await collect(candidateRoot),
      "PWA candidate",
    );
    console.log("Live PWA inputs and candidate bytes are unchanged");
  } finally {
    await rm(runRoot, { force: true, recursive: true });
  }
}
