import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.WORKER_ACCEPTANCE_URL;
if (!(baseURL && /^http:\/\/127\.0\.0\.1:\d+$/.test(baseURL))) {
  throw new Error("Run through node apps/web/scripts/test-worker.mjs");
}

// The runner owns the Worker lifecycle; never reuse a developer's server.
export default defineConfig({
  forbidOnly: true,
  fullyParallel: false,
  projects: [{ name: "chromium-real-worker", use: devices["Desktop Chrome"] }],
  reporter: "list",
  retries: 0,
  testDir: "./tests/worker",
  timeout: 60_000,
  use: {
    baseURL,
    screenshot: "off",
    serviceWorkers: "block",
    // Auth responses contain ephemeral session tokens; don't retain them.
    trace: "off",
    video: "off",
  },
  workers: 1,
});
