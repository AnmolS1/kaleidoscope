import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { drawOnCanvas, submitSavePiece } from "./helpers";

// WCAG 2.1 A + AA. axe runs in-page against the live dev server (vite + workerd),
// asserting zero violations on every primary surface and overlay.
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

async function scan(page: Page, opts: { exclude?: string } = {}) {
  let builder = new AxeBuilder({ page }).withTags(WCAG_TAGS);
  // The Turnstile embed is a third-party cross-origin iframe we don't control;
  // exclude it so the assertion stays about our own markup.
  if (opts.exclude) builder = builder.exclude(opts.exclude);
  const results = await builder.analyze();
  const summary = results.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length }));
  expect(summary, JSON.stringify(summary, null, 2)).toEqual([]);
}

test("studio (/) has no axe violations", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("toolbar", { name: "Drawing tools" })).toBeVisible();
  await scan(page);
});

test("studio with the help overlay open has no axe violations", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Keyboard shortcuts & help").click();
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  await scan(page);
});

test("gallery has no axe violations", async ({ page }) => {
  await page.goto("/gallery");
  // Wait until the list settled (either cards or the empty state).
  await expect(page.locator(".masonry, .empty").first()).toBeVisible();
  await scan(page);
});

test("save dialog has no axe violations", async ({ page }) => {
  await page.goto("/");
  const res = await page.request.post("/api/auth/test-login", { data: { name: "A11y User" } });
  expect(res.ok()).toBeTruthy();
  await page.reload();
  await expect(page.locator(".avatar-btn")).toBeVisible();

  await drawOnCanvas(page);
  await page.getByLabel("Save to gallery").click();
  await expect(page.getByRole("dialog", { name: "Save to gallery" })).toBeVisible();
  await scan(page, { exclude: ".ts-widget" });
});

test("artwork permalink has no axe violations", async ({ page }) => {
  await page.goto("/");
  const res = await page.request.post("/api/auth/test-login", { data: { name: "A11y User" } });
  expect(res.ok()).toBeTruthy();
  await page.reload();
  await expect(page.locator(".avatar-btn")).toBeVisible();

  await drawOnCanvas(page);
  await page.getByLabel("Save to gallery").click();
  await expect(page.getByRole("dialog", { name: "Save to gallery" })).toBeVisible();
  await page.getByLabel("Title").fill("A11y Mandala");
  await submitSavePiece(page);

  await expect(page.locator(".artwork-frame img")).toBeVisible();
  await scan(page);
});
