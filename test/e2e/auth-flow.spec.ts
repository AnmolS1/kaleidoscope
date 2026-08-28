import { test, expect } from "@playwright/test";
import { drawOnCanvas, submitSavePiece, testLogin, uniqueSub } from "./helpers";

test("save → permalink → gallery → remix → delete", async ({ page }) => {
  await page.goto("/");

  // dev-only session bypass (shares the page's cookie jar)
  await testLogin(page, uniqueSub("auth-flow"));

  // draw + open save
  await drawOnCanvas(page, 1);
  await page.getByLabel("Save to gallery").click();
  await expect(page.getByRole("dialog", { name: "Save to gallery" })).toBeVisible();
  await page.getByLabel("Title").fill("E2E Mandala");

  // Turnstile test key auto-issues a token; save once it's ready (robust to timing).
  await submitSavePiece(page);
  const id = page.url().split("/p/")[1];
  await expect(page).toHaveTitle(/E2E Mandala — Kaleidoscope/);
  await expect(page.locator(".artwork-frame img")).toBeVisible();

  // appears in the gallery
  await page.goto("/gallery");
  await expect(page.locator(".art-card").first()).toBeVisible();

  // remix loads it back into the studio
  await page.goto(`/p/${id}`);
  await page.getByRole("button", { name: "Remix" }).click();
  // Match on the PATH, not an absolute URL: the dev-server port is overridable
  // (KALEIDO_E2E_PORT) so that parallel worktrees do not share one, and a
  // hardcoded origin turns that into a mystery timeout.
  await page.waitForURL((u) => u.pathname === "/");
  await expect(page.getByLabel("Clear canvas")).toBeEnabled();

  // delete from My pieces
  page.on("dialog", (d) => d.accept());
  await page.goto("/me");
  await expect(page.locator(".art-card").first()).toBeVisible();
  // delete every card
  for (let i = 0; i < 10; i++) {
    const del = page.locator(".art-card .link-danger").first();
    if ((await del.count()) === 0) break;
    await del.click();
    await page.waitForTimeout(400);
  }
  await expect(page.locator(".art-card")).toHaveCount(0);
});
