import { defineConfig, devices } from "@playwright/test";

// e2e runs against the local dev server (vite + worker in workerd), which loads
// .dev.vars (ALLOW_TEST_LOGIN=true) so the auth flow can be exercised without
// real Google.
//
// THE PORT IS OVERRIDABLE, AND THAT MATTERS MORE THAN IT LOOKS.
//
// `reuseExistingServer` attaches to whatever is already listening, without
// checking that it is serving THIS working tree. With several git worktrees in
// play — which is how the 1.2 waves are built — a run started in one tree
// silently tested another tree's code and reported its failures as your own.
// That is a very expensive kind of wrong: the suite is red, the diff looks
// innocent, and nothing in the output says which source it loaded.
//
// So: give each worktree its own port via KALEIDO_E2E_PORT, and pass
// --strictPort so vite REFUSES a taken port instead of quietly moving to the
// next one (which would leave Playwright waiting on a URL nobody serves, or
// worse, attaching to a neighbour).
//
// If a test ever asserts on an absolute URL, note that PUBLIC_BASE_URL in
// .dev.vars still names 5173; set it to match when overriding the port.
const PORT = Number(process.env.KALEIDO_E2E_PORT ?? 5173);
const ORIGIN = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./test/e2e",
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  // A stray `test.only` shrinks the suite to one test and still reports success
  // — CI goes green having run almost nothing. Locally it stays allowed, since
  // focusing a test is exactly what you do while writing one.
  forbidOnly: !!process.env.CI,
  use: {
    baseURL: ORIGIN,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: ORIGIN,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
