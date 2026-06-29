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

  // Dock popovers must paint ABOVE the canvas (regression: the opaque canvas,
  // later in DOM, hid the upward-opening panel). toBeVisible() can't catch this
  // — hit-test that the panel's control is the topmost element at its position.
  const brushSummary = page.locator('.dock summary[aria-label="Brush settings"]');
  await brushSummary.click();
  const sizeInput = page.locator('.dock details[open] .menu-panel input[aria-label="Brush size"]');
  await expect(sizeInput).toBeVisible();
  const onTop = await sizeInput.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
    return !!hit && (el === hit || el.contains(hit) || hit.contains(el));
  });
  expect(onTop).toBe(true);
  await brushSummary.click(); // close before drawing

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
