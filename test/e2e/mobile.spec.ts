import { test, expect } from "@playwright/test";
import { drawOnCanvas, submitSavePiece } from "./helpers";

test.use({ viewport: { width: 390, height: 844 } });

test("mobile: docked toolbar, bottom-sheet save, gallery 2-col + brand, initials fallback", async ({ page }) => {
  await page.goto("/");
  const res = await page.request.post("/api/auth/test-login", { data: { name: "Mobile User" } });
  expect(res.ok()).toBeTruthy();
  await page.reload();

  // Phone toolbar splits into a slim top bar + a bottom dock — not a wrapped block.
  await expect(page.locator(".toolbar-phone-top")).toBeVisible();
  await expect(page.locator(".dock")).toBeVisible();

  // No horizontal scroll on a phone-width viewport.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);

  // Draw, then open Save — it docks as a bottom sheet with the action in view
  // (the bug this fixes pushed Save/Cancel off-screen).
  await drawOnCanvas(page);
  await page.getByLabel("Save to gallery").click();
  await expect(page.getByRole("dialog", { name: "Save to gallery" })).toBeVisible();
  await page.getByLabel("Title").fill("Mobile Mandala");
  await expect(page.getByRole("button", { name: "Save piece" })).toBeInViewport();

  // Turnstile test key auto-issues a token; save once it's ready, land on the permalink.
  await submitSavePiece(page);

  // Gallery: brand/home link survives on mobile, masonry is 2 columns.
  await page.goto("/gallery");
  await expect(page.locator(".page-nav .tb-brand")).toBeVisible();
  await expect(page.locator(".art-card").first()).toBeVisible();
  const cols = await page.locator(".masonry").evaluate((el) => getComputedStyle(el).columnCount);
  expect(cols).toBe("2");

  // The test-login user has no picture → author avatar falls back to initials,
  // never a broken <img> (confirms the same-origin 404 path).
  await expect(page.locator(".art-card .art-author .avatar-fallback").first()).toBeVisible();
  expect(await page.locator(".art-card .art-author img").count()).toBe(0);
});
