import { test, expect } from "@playwright/test";
import { drawOnCanvas } from "./helpers";

test("save → permalink → gallery → remix → delete", async ({ page }) => {
  await page.goto("/");

  // dev-only session bypass (shares the page's cookie jar)
  const res = await page.request.post("/api/auth/test-login", { data: { name: "E2E User" } });
  expect(res.ok()).toBeTruthy();
  await page.reload();
  await expect(page.locator(".avatar-btn")).toBeVisible();

  // draw + open save
  await drawOnCanvas(page);
  await page.getByLabel("Save to gallery").click();
  await expect(page.getByRole("dialog", { name: "Save to gallery" })).toBeVisible();
  await page.getByLabel("Title").fill("E2E Mandala");

  // Turnstile test key auto-issues a token; give it a moment, then save
  await page.waitForTimeout(2500);
  await page.getByRole("button", { name: "Save piece" }).click();

  await page.waitForURL(/\/p\/[A-Za-z0-9]+/);
  const id = page.url().split("/p/")[1];
  await expect(page).toHaveTitle(/E2E Mandala — Kaleidoscope/);
  await expect(page.locator(".artwork-frame img")).toBeVisible();

  // appears in the gallery
  await page.goto("/gallery");
  await expect(page.locator(".art-card").first()).toBeVisible();

  // remix loads it back into the studio
  await page.goto(`/p/${id}`);
  await page.getByRole("button", { name: "Remix" }).click();
  await page.waitForURL("http://localhost:5173/");
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
