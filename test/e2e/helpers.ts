import type { Page } from "@playwright/test";

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
