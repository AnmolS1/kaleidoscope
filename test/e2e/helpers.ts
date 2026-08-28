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

// Per-run perturbation, so a drawing made in one run never hashes the same as
// one made in another. ~60 x 16 combinations on top of each spec's own seed.
//
// Uniqueness has to live in the DRAWING, not just the account. Saving is
// content-addressed: an identical drawing is refused as a duplicate whoever
// makes it — 200 `deduped` for the same user, 409 `duplicate_of_other` for a
// different one. Giving each spec a fresh account therefore does not isolate it;
// it converts a benign dedupe into a hard 409 against the previous run's user.
// (Learned by making exactly that change and watching the failure get worse.)
//
// CI starts with an empty D1 every run, so this is invisible there. A dev box
// keeps .wrangler/state, which is why the suite has to be re-runnable locally.
const RUN_DRAWING_JITTER = {
  dx: Math.floor(Math.random() * 60),
  extra: Math.floor(Math.random() * 16),
};

/**
 * Draw a stroke across the live canvas with the mouse (commits one stroke).
 *
 * `seed` perturbs the path so two calls produce drawings with DIFFERENT content
 * hashes. Dedupe and the remix block are both keyed on that hash, so a test that
 * needs "the same piece again" and one that needs "a changed piece" differ only
 * by this argument.
 *
 * By default the path is ALSO perturbed per run, so re-running the suite against
 * a populated local database does not collide with itself. Pass
 * `{ stable: true }` to opt out — that is what a test deliberately exercising
 * dedupe or the cross-user remix block wants, since it needs the hashes to
 * collide on purpose. With `stable` and seed 0 the path is the original one,
 * byte for byte.
 */
export async function drawOnCanvas(
  page: Page,
  seed = 0,
  opts: { stable?: boolean } = {},
): Promise<void> {
  const canvas = page.locator(".canvas-host canvas").last();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("canvas not found");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  // Whole numbers of pixels throughout: capture drops moves under ~1.1px, so a
  // fractional offset can perturb the path without changing a single stored
  // point — i.e. without changing the hash, which is the thing being varied.
  const jitter = opts.stable ? { dx: 0, extra: 0 } : RUN_DRAWING_JITTER;
  const dx = seed * 11 + jitter.dx;
  await page.mouse.move(cx + dx, cy - 90);
  await page.mouse.down();
  for (let i = 1; i <= 24 + jitter.extra; i++) {
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
  // Wait on the SESSION, not on a piece of chrome. `.avatar-btn` is only in the
  // desktop header — at phone width the account control lives elsewhere — so
  // asserting it here made this helper silently unusable from mobile.spec.
  // Asking the API is layout-independent and is the actual precondition every
  // caller needs: subsequent locator calls auto-wait for their own UI.
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const r = await fetch("/api/me", { credentials: "same-origin" });
          const d = (await r.json()) as { user: unknown | null };
          return d.user !== null;
        }),
      { message: "signed-in session after test-login", timeout: 10_000 },
    )
    .toBe(true);
  return body.userId;
}

/** The second test account — a different person from `testLogin`'s default. */
export function secondUser(): { sub: string; name: string; email: string } {
  return { sub: "test-sub-2", name: "E2E Other", email: "other@example.com" };
}

// One id per suite run, so every `uniqueSub` in a run agrees and no two runs
// collide. Not exported: a spec that wants two accounts in the SAME run should
// call `uniqueSub` twice with different prefixes, which is clearer than sharing
// a counter.
const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * A signed-in account that belongs to this spec and this run alone.
 *
 * Saving is deduplicated per user on the drawing's content hash, so two specs
 * that draw the same shape as the same account no longer both get a save: the
 * second is handed the FIRST one's piece, and any assertion about its own title
 * or permalink then fails. Which spec loses depends on scheduling order, so the
 * failure is intermittent rather than reliable — the worst kind.
 *
 * The same collision happens across runs, because the local D1 in
 * .wrangler/state persists (CI starts empty, a dev box does not). Keying the
 * account on a per-run id fixes both at once and leaves the drawing geometry
 * alone, so nothing about what is rendered changes.
 *
 * Use this wherever a spec just needs "some signed-in user who can save". A
 * spec that is deliberately TESTING dedupe or the cross-user remix block wants
 * the opposite — a fixed `sub` via `testLogin`, plus a fixed `drawOnCanvas`
 * seed — so that the hashes do collide on purpose.
 */
export function uniqueSub(prefix: string): { sub: string; name: string; email: string } {
  const sub = `${prefix}-${RUN_ID}`;
  return { sub, name: `E2E ${prefix}`, email: `${sub}@example.com` };
}
