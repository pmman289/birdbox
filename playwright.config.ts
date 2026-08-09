import { defineConfig, devices } from "@playwright/test";

const port = 31_000;

export default defineConfig({
  testDir: "./test/e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: "tsx test/e2e/server.ts",
    url: `http://127.0.0.1:${port}/api/health`,
    timeout: 60_000,
    reuseExistingServer: false,
  },
});
