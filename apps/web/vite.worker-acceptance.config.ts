import { defineConfig, mergeConfig } from "vite";
import production from "./vite.config";

const runtime = process.env.WORKER_ACCEPTANCE_RUNTIME;
if (!runtime) {
  throw new Error("Use scripts/test-worker.mjs to build acceptance assets");
}

// Keep production plugins/options, but never read a developer's .env files.
export default mergeConfig(
  production,
  defineConfig({ build: { outDir: `${runtime}/dist` }, envDir: runtime }),
);
