import { expect, type Page } from "@playwright/test";

/**
 * Submit the Save dialog and wait for the permalink redirect.
 *
 * The Turnstile test widget issues its token asynchronously (~2.4s), and it
 * populates the hidden input slightly before our `callback` sets React state —
 * so a fixed `waitForTimeout` before clicking is a race. Retry the click until
 * navigation happens: a click with no token just re-shows the inline message
 * (a no-op), and the next click once the token has landed navigates.
 */
export async function submitSavePiece(page: Page): Promise<void> {
  await expect(async () => {
    await page.getByRole("button", { name: "Save piece" }).click();
    await page.waitForURL(/\/p\/[A-Za-z0-9]+/, { timeout: 2500 });
  }).toPass({ timeout: 20_000 });
}

/** Draw a stroke across the live canvas with the mouse (commits one stroke). */
export async function drawOnCanvas(page: Page): Promise<void> {
  const canvas = page.locator(".canvas-host canvas").last();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("canvas not found");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy - 90);
  await page.mouse.down();
  for (let i = 1; i <= 24; i++) {
    await page.mouse.move(cx + Math.sin(i / 3) * 70, cy - 90 + i * 7);
  }
  await page.mouse.up();
}
