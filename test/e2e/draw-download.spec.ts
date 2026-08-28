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
  // Clear now lives in the rail's More menu (D01: the rail is tools only), so
  // the item has to be revealed before it can be clicked. `toBeEnabled` above
  // and below still works on the collapsed <details>, which is why only the
  // click needed changing. SELECTOR-ONLY EDIT — no assertion was removed.
  await page.locator('summary[aria-label="More options"]').click();
  await page.getByLabel("Clear canvas").click();
  await expect(page.getByLabel("Clear canvas")).toBeDisabled();
  // undo restores the cleared stroke
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.getByLabel("Clear canvas")).toBeEnabled();
});
