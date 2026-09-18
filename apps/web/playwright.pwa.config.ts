import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  forbidOnly: Boolean(process.env.CI),
  fullyParallel: false,
  projects: [
    {
      name: "chromium-pwa",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  reporter: "list",
  retries: 0,
  testDir: "./tests/pwa",
  timeout: 45_000,
  use: {
    baseURL: "http://127.0.0.1:4175",
    serviceWorkers: "allow",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node scripts/serve-pwa-test.mjs",
    reuseExistingServer: false,
    url: "http://127.0.0.1:4175",
  },
  workers: 1,
});
