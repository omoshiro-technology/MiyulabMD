import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer as createPortProbe } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, normalizePath } from "vite";

// Candidate files are authoritative. Nothing in this runner writes to src or
// copies generated files back into the candidate directory.
const webRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = path.resolve(webRoot, "../..");
const candidateRoot = path.resolve(process.argv[2] ?? "");
const mode = process.argv[3] ?? "all";
const relative = path.relative(repoRoot, candidateRoot);
if (
  !process.argv[2] ||
  relative.startsWith("..") ||
  path.isAbsolute(relative) ||
  !["all", "browser", "typecheck", "lint"].includes(mode)
) {
  throw new Error(
    "Usage: node check-offline-candidate.mjs <worktree-candidate-dir> [all|browser|typecheck|lint] [specs...]",
  );
}
if (candidateRoot === path.join(webRoot, "src/lib")) {
  throw new Error("Use a candidate directory, not the live source directory");
}

const candidatePaths = new Map();
async function collectCandidates(directory = "") {
  const entries = await readdir(path.join(candidateRoot, directory), {
    withFileTypes: true,
  });
  for (const entry of entries) {
    const relativePath = normalizePath(path.join(directory, entry.name));
    if (entry.isDirectory()) {
      await collectCandidates(relativePath);
      continue;
    }
    if (!(entry.isFile() && /\.tsx?$/.test(entry.name))) {
      continue;
    }
    if (directory && !relativePath.startsWith("src/")) {
      throw new Error(`Nested candidates must be under src/: ${relativePath}`);
    }
    const sourcePath = directory ? relativePath : `src/lib/${entry.name}`;
    if (candidatePaths.has(sourcePath)) {
      throw new Error(`Duplicate candidate for ${sourcePath}`);
    }
    candidatePaths.set(sourcePath, path.join(candidateRoot, relativePath));
  }
}
await collectCandidates();
const files = [...candidatePaths.keys()];
for (const required of [
  "src/lib/offline-cache.ts",
  "src/lib/note-read-session.ts",
]) {
  if (!candidatePaths.has(required)) {
    throw new Error(`Missing candidate: ${required}`);
  }
}
const contents = new Map();
for (const name of files) {
  contents.set(name, await readFile(candidatePaths.get(name), "utf8"));
}
const digest = (text) => createHash("sha256").update(text).digest("hex");
const sources = new Map(
  [...contents].map(([name, text]) => [
    normalizePath(path.join(webRoot, name)),
    text,
  ]),
);
const liveBefore = new Map();
async function readLive(name) {
  try {
    return await readFile(path.join(webRoot, name), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
for (const name of files) {
  liveBefore.set(name, await readLive(name));
}

const cacheRoot = path.join(webRoot, "node_modules/.cache/offline-candidate");
await mkdir(cacheRoot, { recursive: true });
const runRoot = await mkdtemp(path.join(cacheRoot, "run-"));

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

async function packageBin(packageName, command) {
  const manifestPath = fileURLToPath(
    import.meta.resolve(`${packageName}/package.json`),
  );
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  return path.resolve(path.dirname(manifestPath), manifest.bin[command]);
}

async function typecheck() {
  // TypeScript 7 uses a native CLI rather than the old compiler-host API.
  // A disposable tree preserves relative module resolution without touching
  // either live sources or canonical candidates.
  await cp(path.join(webRoot, "src"), path.join(runRoot, "src"), {
    recursive: true,
  });
  for (const [name, text] of contents) {
    const destination = path.join(runRoot, name);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, text);
  }
  const config = path.join(runRoot, "tsconfig.json");
  await writeFile(
    config,
    JSON.stringify({
      exclude: ["src/**/*.test.ts"],
      extends: path.join(webRoot, "tsconfig.json"),
      include: ["src"],
    }),
  );
  await runNode([
    await packageBin("typescript", "tsc"),
    "--project",
    config,
    "--noEmit",
  ]);
}

async function lint() {
  await runNode([
    await packageBin("@biomejs/biome", "biome"),
    "check",
    ...candidatePaths.values(),
  ]);
}

async function unusedPort() {
  const probe = createPortProbe();
  try {
    await new Promise((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", resolve);
    });
    const address = probe.address();
    if (!address || typeof address === "string") {
      throw new Error("Could not select a local test port");
    }
    return address.port;
  } finally {
    if (probe.listening) {
      await new Promise((resolve, reject) => {
        probe.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    }
  }
}

async function browser() {
  const selectedPort = await unusedPort();
  const loaded = new Set();
  const server = await createServer({
    plugins: [
      {
        enforce: "pre",
        load(id) {
          const key = normalizePath(id.split("?")[0]);
          if (!sources.has(key)) {
            return null;
          }
          loaded.add(key);
          return sources.get(key);
        },
        name: "offline-candidate",
        resolveId(source, importer) {
          let resolved = source;
          if (source.startsWith("/src/")) {
            resolved = path.join(webRoot, source.slice(1));
          } else if (source.startsWith(".") && importer) {
            resolved = path.resolve(
              path.dirname(importer.split("?")[0]),
              source,
            );
          }
          const key = normalizePath(resolved);
          return sources.has(key) ? key : null;
        },
      },
    ],
    root: webRoot,
    server: { host: "127.0.0.1", port: selectedPort, strictPort: true },
  });
  try {
    await server.listen();
    const port = server.httpServer.address().port;
    if (port !== selectedPort) {
      throw new Error("Candidate server did not use the selected port");
    }
    const config = path.join(runRoot, "playwright.config.mjs");
    await writeFile(
      config,
      `export default ${JSON.stringify({
        forbidOnly: true,
        outputDir: path.join(runRoot, "results"),
        projects: [{ name: "chromium", use: { browserName: "chromium" } }],
        reporter: "list",
        retries: 0,
        testDir: path.join(webRoot, "tests/browser"),
        use: { baseURL: `http://127.0.0.1:${port}` },
        workers: 1,
      })};`,
    );
    const specs = process.argv.slice(4);
    await runNode([
      path.join(webRoot, "scripts/playwright.mjs"),
      "test",
      "--config",
      config,
      // Playwright's testDir is the single source of suite membership. With
      // no positional filters, include new specs automatically, with or without
      // CLI options such as --workers. Focused runs pass their filters unchanged.
      ...specs,
    ]);
    if (loaded.size === 0) {
      throw new Error("The selected tests did not load any candidate module");
    }
    const required = specs.length
      ? []
      : ["offline-cache.ts", "note-read-session.ts"];
    for (const name of required) {
      if (!loaded.has(normalizePath(path.join(webRoot, "src/lib", name)))) {
        throw new Error(`Candidate was not loaded: ${name}`);
      }
    }
  } finally {
    await server.close();
  }
}

async function verifyUnchanged() {
  for (const [name, text] of contents) {
    if ((await readFile(candidatePaths.get(name), "utf8")) !== text) {
      throw new Error(`Candidate changed during validation: ${name}`);
    }
    if ((await readLive(name)) !== liveBefore.get(name)) {
      throw new Error(`Live source changed during validation: ${name}`);
    }
  }
}

try {
  for (const [name, text] of contents) {
    console.log(`Candidate SHA256 ${digest(text)} ${name}`);
  }
  if (mode === "all" || mode === "typecheck") {
    await typecheck();
  }
  if (mode === "all" || mode === "lint") {
    await lint();
  }
  if (mode === "all" || mode === "browser") {
    await browser();
  }
} finally {
  // Always check the authoritative files, including after a failed test.
  try {
    await verifyUnchanged();
  } finally {
    await rm(runRoot, { force: true, recursive: true });
  }
}
