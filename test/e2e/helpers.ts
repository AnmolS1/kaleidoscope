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

/**
 * Draw a stroke across the live canvas with the mouse (commits one stroke).
 *
 * `seed` perturbs the path so two calls produce drawings with DIFFERENT content
 * hashes. Dedupe and the remix block are both keyed on that hash, so a test that
 * needs "the same piece again" and one that needs "a changed piece" differ only
 * by this argument. Seed 0 is the original path, byte for byte, so the specs
 * that predate the perturbation are unaffected.
 */
export async function drawOnCanvas(page: Page, seed = 0): Promise<void> {
  const canvas = page.locator(".canvas-host canvas").last();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("canvas not found");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  // A whole number of pixels: the engine drops sub-pixel moves, so a fractional
  // offset could perturb the path without changing a single stored point.
  const dx = seed * 11;
  await page.mouse.move(cx + dx, cy - 90);
  await page.mouse.down();
  for (let i = 1; i <= 24; i++) {
    await page.mouse.move(cx + dx + Math.sin(i / 3) * 70, cy - 90 + i * 7);
  }
  await page.mouse.up();
}

/**
 * A distinct signed-in user, sharing the page's cookie jar.
 *
 * `/api/auth/test-login` (dev only) keys the account on `sub`, so passing a
 * different one is genuinely a different user — which is what the cross-user
 * remix block needs to be tested against. Calling it again replaces the session
 * cookie, so a spec switches users by calling it and reloading.
 */
export async function testLogin(
  page: Page,
  user: { sub?: string; name?: string; email?: string } = {},
): Promise<string> {
  const sub = user.sub ?? "test-sub-1";
  const res = await page.request.post("/api/auth/test-login", {
    data: {
      sub,
      name: user.name ?? "E2E User",
      email: user.email ?? `${sub}@example.com`,
    },
  });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { userId: string };
  await page.reload();
  await expect(page.locator(".avatar-btn")).toBeVisible();
  return body.userId;
}

/** The second test account — a different person from `testLogin`'s default. */
export function secondUser(): { sub: string; name: string; email: string } {
  return { sub: "test-sub-2", name: "E2E Other", email: "other@example.com" };
}
