import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const web = fileURLToPath(new URL("../", import.meta.url));
const worker = path.resolve(web, "../worker");
const workerRequire = createRequire(path.join(worker, "package.json"));
const wrangler = workerRequire.resolve("wrangler");
const vite = fileURLToPath(
  new URL("../node_modules/vite/bin/vite.js", import.meta.url),
);
const children = new Set();
let stopping = false;
const stopPromises = new WeakMap();
const testArgs = process.argv.slice(2);
if (testArgs.length && !(testArgs.length === 2 && testArgs[0] === "--grep")) {
  throw new Error(
    "Usage: node apps/web/scripts/test-worker.mjs [--grep pattern]",
  );
}

// Do not pass cloud credentials, NODE_OPTIONS, proxies, or project secrets on.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) =>
    /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|LANG|LC_ALL)$/i.test(
      key,
    ),
  ),
);
Object.assign(env, {
  BROWSER: "none",
  CI: "1",
  PLAYWRIGHT_BROWSERS_PATH: path.join(web, "node_modules/.cache/playwright"),
  PLAYWRIGHT_SKIP_BROWSER_GC: "1",
  WRANGLER_DISABLE_AUTO_UPDATE: "true",
  WRANGLER_SEND_METRICS: "false",
});

function start(args, cwd, extraEnv = {}) {
  if (stopping) {
    throw new Error("Acceptance run interrupted");
  }
  const child = spawn(process.execPath, args, {
    cwd,
    detached: process.platform !== "win32",
    env: { ...env, ...extraEnv },
    stdio: ["ignore", "inherit", "inherit"],
  });
  children.add(child);
  child.done = new Promise((resolve, reject) => {
    child.once("error", (error) => {
      children.delete(child);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      children.delete(child);
      resolve({ code, signal });
    });
  });
  return child;
}

async function run(args, cwd, extraEnv) {
  const { code, signal } = await start(args, cwd, extraEnv).done;
  if (code !== 0) {
    throw new Error(
      `Command failed (${code ?? signal}): ${path.basename(args[0])} ${args[1]}`,
    );
  }
}

function stop(child) {
  if (stopPromises.has(child)) {
    return stopPromises.get(child);
  }
  const promise = stopTree(child);
  stopPromises.set(child, promise);
  return promise;
}

async function stopTree(child) {
  if (!children.has(child)) {
    return;
  }
  if (process.platform === "win32") {
    // Kill only this owned PID tree, including workerd/Chromium grandchildren.
    await new Promise((resolve, reject) => {
      const killer = spawn(
        "taskkill",
        ["/pid", String(child.pid), "/T", "/F"],
        {
          stdio: "ignore",
        },
      );
      killer.once("error", reject);
      killer.once("exit", resolve);
    });
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") {
        throw error;
      }
    }
    await Promise.race([child.done, delay(3000)]);
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") {
        throw error;
      }
    }
  }
  await child.done;
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function interrupt(code) {
  stopping = true;
  process.exitCode = code;
  void Promise.all([...children].map(stop)).catch((error) => {
    console.error(`Child cleanup failed: ${error.message}`);
  });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => interrupt(signal === "SIGINT" ? 130 : 143));
}
const deadline = setTimeout(() => {
  console.error("Local Worker acceptance exceeded its five-minute deadline");
  interrupt(1);
}, 300_000);

let runtime;
try {
  // Keep SQLite paths short on Windows (DO state includes a long object ID).
  const cache = path.resolve(web, "../../.wrangler/acceptance");
  await mkdir(cache, { recursive: true });
  runtime = await mkdtemp(path.join(cache, "run-"));
  console.log(`Local Worker acceptance runtime: ${runtime}`);
  env.WORKER_ACCEPTANCE_RUNTIME = runtime;
  env.WRANGLER_LOG_PATH = path.join(runtime, "wrangler.log");
  env.WRANGLER_REGISTRY_PATH = path.join(runtime, "registry");
  env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = "true";
  const emptyEnv = path.join(runtime, "empty.env");
  await writeFile(emptyEnv, "");

  // Wrangler's pinned parser preserves the production routing/binding contract.
  const { experimental_readRawConfig } = workerRequire("wrangler");
  const { rawConfig } = experimental_readRawConfig({
    config: path.join(worker, "wrangler.toml"),
  });
  const config = {
    ...rawConfig,
    assets: { ...rawConfig.assets, directory: path.join(runtime, "dist") },
    d1_databases: rawConfig.d1_databases.map((db) => ({
      ...db,
      database_id: "00000000-0000-4000-8000-000000000000",
      migrations_dir: path.resolve(worker, db.migrations_dir),
      remote: false,
    })),
    main: path.resolve(worker, rawConfig.main),
    name: `acceptance-${path.basename(runtime).toLowerCase()}`,
    r2_buckets: rawConfig.r2_buckets.map((bucket) => ({
      ...bucket,
      remote: false,
    })),
    secrets: { required: ["SESSION_SECRET"] },
    services: rawConfig.services.map((service) => ({
      ...service,
      service: `acceptance-og-${path.basename(runtime).toLowerCase()}`,
    })),
    tsconfig: path.join(worker, "tsconfig.json"),
    vars: {
      ...rawConfig.vars,
      ACCESS_TEAM_DOMAIN: "",
      ALLOW_ANONYMOUS: "false",
      DEV_AUTH: "true",
    },
  };
  const configPath = path.join(runtime, "wrangler.json");
  await writeFile(configPath, JSON.stringify(config, null, 2));
  const { rawConfig: og } = experimental_readRawConfig({
    config: path.join(worker, "wrangler.og-fetch.toml"),
  });
  const ogPath = path.join(runtime, "wrangler.og-fetch.json");
  await writeFile(
    ogPath,
    JSON.stringify(
      {
        ...og,
        main: path.resolve(worker, og.main),
        name: config.services[0].service,
      },
      null,
      2,
    ),
  );
  await run(
    [vite, "build", "--config", "vite.worker-acceptance.config.ts"],
    web,
  );
  const state = path.join(runtime, "state");
  const common = ["--config", configPath, "--env-file", emptyEnv];
  await run(
    [
      wrangler,
      "d1",
      "migrations",
      "apply",
      "DB",
      "--local",
      "--persist-to",
      state,
      ...common,
    ],
    runtime,
  );
  start(
    [
      wrangler,
      "dev",
      "--config",
      ogPath,
      "--env-file",
      emptyEnv,
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(await freePort()),
      "--inspector-port",
      "0",
      "--persist-to",
      state,
      "--no-show-interactive-dev-session",
    ],
    runtime,
  );
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const server = start(
    [
      wrangler,
      "dev",
      ...common,
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--inspector-port",
      "0",
      "--persist-to",
      state,
      "--no-show-interactive-dev-session",
    ],
    runtime,
    {
      // Runtime-only random key: no key in arguments, config, or committed files.
      SESSION_SECRET: randomBytes(48).toString("hex"),
    },
  );
  let ready = false;
  for (let attempt = 0; attempt < 180; attempt++) {
    if (!children.has(server)) {
      throw new Error("Local Worker exited before readiness");
    }
    try {
      const response = await fetch(`${url}/api/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok && (await response.json()).ok === true) {
        ready = true;
        break;
      }
    } catch {
      // Connection refusal is expected while workerd starts and bundles.
    }
    await delay(500);
  }
  if (!ready) {
    throw new Error("Local Worker readiness timed out");
  }
  await run(
    [
      fileURLToPath(import.meta.resolve("@playwright/test/cli")),
      "test",
      "--config",
      "playwright.worker.config.ts",
      "--output",
      path.join(runtime, "test-results"),
      ...testArgs,
    ],
    web,
    { WORKER_ACCEPTANCE_URL: url },
  );
} catch (error) {
  console.error(error.message);
  process.exitCode ||= 1;
} finally {
  clearTimeout(deadline);
  stopping = true;
  await Promise.all([...children].map(stop));
  if (runtime) {
    await rm(runtime, {
      force: true,
      maxRetries: 5,
      recursive: true,
      retryDelay: 500,
    });
    console.log(
      "Local Worker acceptance: owned children stopped; runtime removed.",
    );
  }
}
