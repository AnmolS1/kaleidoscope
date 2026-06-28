import { defineConfig, devices } from "@playwright/test";

// e2e runs against the local dev server (vite + worker in workerd), which loads
// .dev.vars (ALLOW_TEST_LOGIN=true) so the auth flow can be exercised without
// real Google.
export default defineConfig({
  testDir: "./test/e2e",
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
