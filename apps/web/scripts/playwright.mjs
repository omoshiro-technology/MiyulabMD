import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Use the same worktree-local browsers for installation and test execution.
// Never garbage-collect the user's shared Playwright browser cache.
const webRoot = fileURLToPath(new URL("../", import.meta.url));
const browsersPath = fileURLToPath(
  new URL("../node_modules/.cache/playwright/", import.meta.url),
);
const result = spawnSync(
  process.execPath,
  [
    fileURLToPath(import.meta.resolve("@playwright/test/cli")),
    ...process.argv.slice(2),
  ],
  {
    cwd: webRoot,
    env: {
      ...process.env,
      PLAYWRIGHT_BROWSERS_PATH: browsersPath,
      PLAYWRIGHT_SKIP_BROWSER_GC: "1",
    },
    stdio: "inherit",
  },
);

if (result.error) {
  console.error(result.error.message);
}
process.exitCode = result.status ?? 1;
