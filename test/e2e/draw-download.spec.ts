import { test, expect } from "@playwright/test";
import { drawOnCanvas } from "./helpers";

test("draw and download a PNG without logging in", async ({ page }) => {
  await page.goto("/");
  await drawOnCanvas(page);

  // a committed stroke enables Clear
  await expect(page.getByLabel("Clear canvas")).toBeEnabled();

  // open the download menu and grab a PNG
  await page.locator("#download-menu summary").click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("menuitem", { name: "PNG · 1×" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.png$/);
});

test("undo and clear work", async ({ page }) => {
  await page.goto("/");
  await drawOnCanvas(page);
  await expect(page.getByLabel("Clear canvas")).toBeEnabled();
  await page.getByLabel("Clear canvas").click();
  await expect(page.getByLabel("Clear canvas")).toBeDisabled();
  // undo restores the cleared stroke
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.getByLabel("Clear canvas")).toBeEnabled();
});
