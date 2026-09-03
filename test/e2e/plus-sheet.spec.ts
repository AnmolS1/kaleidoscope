import { test, expect, type Page, type Route } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { drawOnCanvas, openSave, testLogin, uniqueSub } from "./helpers";

// DESIGN.md §5 is "one sheet, SIX states" (plus an error state the spec leaves
// to code). One test per state, and each asserts a string or an affordance that
// ONLY that state shows — "the sheet opened" would pass in all seven and prove
// nothing.
//
// `data-plus-state` is the resolver's own verdict; every test pairs it with the
// visible copy, so a resolver that says the right word while rendering the
// wrong body still fails.

// The studio keeps the compact toolbar's ⋯ overflow in the DOM at every width,
// so `.plus-menu-item` legitimately matches twice once Plus is enabled — the
// account panel's row and the overflow's. Assertions about the ROW are scoped
// to `.auth-panel`; assertions that the row is ABSENT stay unscoped on purpose,
// because both copies have to go.
const accountRow = (page: Page) => page.locator(".auth-panel .plus-menu-item");

const sheet = (page: Page) => page.getByRole("dialog", { name: "Kaleidoscope Plus" });
const plusMenuItem = (page: Page) => page.getByRole("menuitem", { name: /Kaleidoscope Plus/ });

/**
 * Merge a Plus block into the REAL /api/me.
 *
 * Never a fabricated body: the real response also carries `csrf` and
 * `turnstileSiteKey`, and dropping them turns every later save into a 403 for a
 * reason that has nothing to do with the test. Same technique as helpers.ts's
 * `mockAtCap`.
 *
 * The patch is read on every call, so a test can flip `active` mid-run to play
 * the Lemon Squeezy webhook landing late.
 */
async function mockPlus(page: Page, patch: () => Record<string, unknown>): Promise<void> {
  await page.route("**/api/me", async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as Record<string, unknown>;
    const plus = (body.plus ?? {}) as Record<string, unknown>;
    // The real block goes FIRST and the fixture overrides it: locally
    // `PLUS_ENABLED` is unset, so the worker honestly reports `publicCap: null`
    // (no cap to report), and a spread in the other order would let that null
    // win and silently delete the meter this file exists to check.
    const over = patch();
    body.plus = {
      ...plus,
      active: false,
      sources: [],
      publicCount: 0,
      publicCap: 10,
      layerCap: 3,
      // `surface` governs whether the Plus UI EXISTS; `enabled` governs whether
      // the caps are enforced (REVIEW L1 split them). Every test in this file
      // predates the split and says `enabled: true` to mean "the sheet is
      // available", so surface follows enabled unless a test sets it — which
      // keeps each test's intent while letting the independence be asserted.
      surface: over.enabled ?? false,
      ...over,
    };
    await route.fulfill({ response: res, json: body });
  });
}

/** Open the account menu in the studio header. */
async function openAccountMenu(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Account menu" }).click();
  await expect(page.getByRole("menu")).toBeVisible();
}

async function openSheetFromMenu(page: Page): Promise<void> {
  await openAccountMenu(page);
  await plusMenuItem(page).click();
  await expect(sheet(page)).toBeVisible();
  // Wait for FOCUS, not just for the element. `toBeVisible` resolves as soon as
  // the card paints, which can be a frame before the mount effects run — and
  // an Escape pressed in that window hits no listener. (1 run in 5 failed that
  // way before this line existed; it also asserts the focus move itself.)
  await expect(sheet(page)).toBeFocused();
}

/** Sign in with the Plus block patched in from the very first /api/me. */
async function signedInWithPlus(
  page: Page,
  prefix: string,
  patch: () => Record<string, unknown>,
): Promise<void> {
  await mockPlus(page, patch);
  await page.goto("/");
  await testLogin(page, uniqueSub(prefix));
}

/** Fail the checkout route with an exact status, and prove that status arrived. */
async function checkoutFails(
  page: Page,
  status: number,
  json: Record<string, unknown>,
): Promise<() => Promise<void>> {
  await page.route("**/api/billing/checkout*", (route: Route) => route.fulfill({ status, json }));
  const pending = page.waitForResponse((r) => r.url().includes("/api/billing/checkout"));
  return async () => {
    // Assert the STATUS CODE, not `ok()`: 401, 409 and 429 each map to a
    // different sheet state, and `!ok` cannot tell them apart.
    expect((await pending).status()).toBe(status);
  };
}

// ---------------------------------------------------------------------------
// The kill switch. This is the assertion that keeps an unapproved IAP invisible.
// ---------------------------------------------------------------------------

test.describe("the Plus SURFACE flag is the kill switch", () => {
  test("surface:false removes every door to the sheet, not just the sheet", async ({ page }) => {
    // 🔴 THE SURFACE IS SET HERE, not inherited from the deploy.
    //
    // This used to lean on `wrangler.jsonc` shipping the flag false — "no
    // interception needed, and none used, so nothing here can be an artefact of
    // the mock". Reasonable, and it made the test a hostage: the day the flag
    // was turned on for the App Review window this went red, in the deploy
    // pipeline, on a change that had nothing to do with the kill switch.
    //
    // A test of "what does OFF look like" has to say off. Reading it from the
    // configuration means the test asserts today's rollout state and calls it a
    // behaviour.
    await mockPlus(page, () => ({ enabled: false, surface: false, publicCap: null }));
    await page.goto("/");
    await testLogin(page, uniqueSub("plus-off"));
    await openAccountMenu(page);

    // The menu itself rendered — otherwise "no Plus row" would be true of a
    // menu that failed to open at all.
    await expect(page.getByRole("menuitem", { name: "My pieces" })).toBeVisible();

    await expect(plusMenuItem(page)).toHaveCount(0);
    await expect(page.locator(".plus-menu-item")).toHaveCount(0);
    // No cap counter either: a count with no cap is not a limit.
    await expect(page.locator(".auth-count")).toHaveCount(0);
    // And the sheet is nowhere in the document, from any door.
    await expect(page.locator("[data-plus-state]")).toHaveCount(0);
  });

  test("a worker with NO plus block at all is treated as disabled", async ({ page }) => {
    // `initAuth` leaves `plus` null against an older worker and whenever
    // /api/me failed. Null must fail CLOSED — it is not "enabled: undefined".
    await page.route("**/api/me", async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as Record<string, unknown>;
      delete body.plus;
      await route.fulfill({ response: res, json: body });
    });
    await page.goto("/");
    await testLogin(page, uniqueSub("plus-null"));
    await openAccountMenu(page);

    await expect(page.getByRole("menuitem", { name: "My pieces" })).toBeVisible();
    await expect(plusMenuItem(page)).toHaveCount(0);
    await expect(page.locator("[data-plus-state]")).toHaveCount(0);
  });

  test("CONTROL: surface on puts the same doors back", async ({ page }) => {
    // Without this, the two tests above pass just as well against a build where
    // the Plus row was never written.
    await signedInWithPlus(page, "plus-on", () => ({ enabled: true, publicCount: 7 }));
    await openAccountMenu(page);

    await expect(plusMenuItem(page)).toBeVisible();
    await expect(page.locator(".auth-count")).toHaveText("7 of 10 public posts");
    await expect(accountRow(page).locator(".chip")).toHaveText("$4.99");
  });
});

// ---------------------------------------------------------------------------
// The six states.
// ---------------------------------------------------------------------------

test.describe("Plus sheet states", () => {
  test("1. PlusBefore — the pitch, with the meter at 9 of 10", async ({ page }) => {
    await signedInWithPlus(page, "plus-before", () => ({ enabled: true, publicCount: 9 }));
    await openSheetFromMenu(page);

    await expect(sheet(page)).toHaveAttribute("data-plus-state", "before");
    // Only this state shows the meter AND an enabled buy button.
    await expect(sheet(page).locator(".plus-meter-head")).toContainText("9 of 10");
    await expect(sheet(page).locator(".plus-meter-fill")).toHaveCSS("width", /.+/);
    const cta = sheet(page).locator(".plus-cta");
    await expect(cta).toHaveText("Unlock for $4.99");
    await expect(cta).toBeEnabled();
    await expect(sheet(page).locator(".plus-foot")).toContainText("One-time purchase of $4.99.");
    for (const f of ["Unlimited public posts", "Eight layers", "One-time purchase"]) {
      await expect(sheet(page).getByText(f, { exact: true })).toBeVisible();
    }
    // No note of any kind — every other state has one or is mid-flight.
    await expect(sheet(page).locator(".note")).toHaveCount(0);
  });

  test("2. PlusPurchasing — the button is disabled and says Unlocking…", async ({ page }) => {
    await signedInWithPlus(page, "plus-buying", () => ({ enabled: true, publicCount: 2 }));
    // A deliberate delay: without it the state exists for one frame and the
    // test is either flaky or vacuous. The URL is LOCAL, so the redirect is
    // observable and never leaves for lemonsqueezy.com.
    await page.route("**/api/billing/checkout*", async (route) => {
      await new Promise((r) => setTimeout(r, 1200));
      await route.fulfill({ status: 200, json: { url: "/?checkout=stub" } });
    });
    const checkout = page.waitForResponse((r) => r.url().includes("/api/billing/checkout"));

    await openSheetFromMenu(page);
    await sheet(page).locator(".plus-cta").click();

    await expect(sheet(page)).toHaveAttribute("data-plus-state", "purchasing");
    await expect(sheet(page).locator(".plus-cta")).toHaveText("Unlocking…");
    await expect(sheet(page).locator(".plus-cta")).toBeDisabled();
    // Restore is disabled too — two billing calls in flight at once is exactly
    // how a second checkout gets started.
    await expect(sheet(page).getByRole("button", { name: "Restore purchase" })).toBeDisabled();

    expect((await checkout).status()).toBe(200);
    // It really redirects. A "purchasing" state that never navigates is a hang.
    await page.waitForURL((u) => u.search.includes("checkout=stub"));
    // The redirect reloads the app, so /api/me is in flight as the test ends.
    // An interception still running then errors and Playwright charges it to
    // whichever test is next — which is how test 3 failed for test 2's reason.
    await page.unrouteAll({ behavior: "ignoreErrors" });
  });

  test("3. PlusPurchased — restore finds the entitlement the webhook just wrote", async ({
    page,
  }) => {
    let owned = false;
    await signedInWithPlus(page, "plus-bought", () => ({ enabled: true, active: owned }));
    await openSheetFromMenu(page);
    await expect(sheet(page)).toHaveAttribute("data-plus-state", "before");

    // The Lemon Squeezy webhook lands. This is the real reason web restore
    // exists: the grant is asynchronous and this client's block is stale.
    owned = true;
    const me = page.waitForResponse((r) => r.url().includes("/api/me"));
    await sheet(page).getByRole("button", { name: "Restore purchase" }).click();
    expect((await me).status()).toBe(200);

    await expect(sheet(page)).toHaveAttribute("data-plus-state", "purchased");
    await expect(sheet(page).getByText("You’re in.")).toBeVisible();
    await expect(sheet(page).locator(".note")).toContainText(
      "Eight layers and unlimited public posts, on web and in the app.",
    );
    // Only this state offers a way out and no way to pay again.
    await expect(sheet(page).getByRole("button", { name: "Back to canvas" })).toBeVisible();
    await expect(sheet(page).getByText(/Unlock for/)).toHaveCount(0);

    await sheet(page).getByRole("button", { name: "Back to canvas" }).click();
    await expect(sheet(page)).toHaveCount(0);

    // The fresh block was published, not just displayed: the price chip is
    // wrong for someone who already owns Plus.
    await openAccountMenu(page);
    await expect(accountRow(page)).toBeVisible();
    await expect(accountRow(page).locator(".chip")).toHaveCount(0);
  });

  test("4. PlusRestoreNone — restore finds nothing on this account", async ({ page }) => {
    await signedInWithPlus(page, "plus-none", () => ({ enabled: true, active: false }));
    await openSheetFromMenu(page);
    await sheet(page).getByRole("button", { name: "Restore purchase" }).click();

    await expect(sheet(page)).toHaveAttribute("data-plus-state", "restore-none");
    await expect(sheet(page).locator(".note")).toContainText("No purchase found for this account.");
    // Still buyable — this is a "not yours" answer, not a failure.
    await expect(sheet(page).locator(".plus-cta")).toHaveText("Unlock for $4.99");
    // The discriminator against `before`: `before` has the meter and no note.
    await expect(sheet(page).locator(".plus-meter-head")).toHaveCount(0);
  });

  test("4b. restore against an EXPIRED session says sign in, and the sheet survives", async ({
    page,
  }) => {
    // An expired session is `user: null` — and the plus block is STILL THERE,
    // because REVIEW S18 made it unconditional (the surface flag is a property
    // of the deploy, not of a user). Publishing that block would tell someone
    // whose session lapsed that they do not own Plus, and would drop their
    // layer cap to the signed-out value on the way.
    //
    // This test used to simulate the lapse with `delete body.plus`, which was
    // the shape BEFORE S18. That mock kept passing while the real thing broke:
    // it was asserting against a contract the worker had stopped honouring.
    // Deleting `user` is what an expired session actually looks like.
    let signedOut = false;
    await page.route("**/api/me", async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as Record<string, unknown>;
      if (signedOut) body.user = null;
      // `surface` too: it is what makes the Plus UI exist at all (REVIEW L1).
      else body.plus = { ...((body.plus ?? {}) as object), enabled: true, surface: true, publicCap: 10 };
      await route.fulfill({ response: res, json: body });
    });
    await page.goto("/");
    await testLogin(page, uniqueSub("plus-expired"));
    await openSheetFromMenu(page);

    signedOut = true;
    await sheet(page).getByRole("button", { name: "Restore purchase" }).click();

    await expect(sheet(page)).toBeVisible();
    await expect(sheet(page)).toHaveAttribute("data-plus-state", "sign-in");
    await expect(sheet(page).getByRole("link", { name: "Sign in to continue" })).toBeVisible();
  });

  test("5. PlusBoundElsewhere — 409 bound_elsewhere offers a different account", async ({
    page,
  }) => {
    await signedInWithPlus(page, "plus-bound", () => ({ enabled: true }));
    const assertStatus = await checkoutFails(page, 409, { error: "bound_elsewhere" });
    await openSheetFromMenu(page);
    await sheet(page).locator(".plus-cta").click();
    await assertStatus();

    await expect(sheet(page)).toHaveAttribute("data-plus-state", "bound-elsewhere");
    await expect(sheet(page).locator(".note")).toContainText(
      "This purchase is linked to another Kaleidoscope account.",
    );
    // The affordance is the point: a generic error would offer "try again",
    // which can never work.
    await expect(sheet(page).getByRole("button", { name: "Switch account" })).toBeVisible();
    await expect(sheet(page).getByText(/Unlock for/)).toHaveCount(0);
  });

  test("6. PlusSignIn — 401 asks for a session, not a retry", async ({ page }) => {
    await signedInWithPlus(page, "plus-401", () => ({ enabled: true }));
    const assertStatus = await checkoutFails(page, 401, { error: "unauthorized" });
    await openSheetFromMenu(page);
    await sheet(page).locator(".plus-cta").click();
    await assertStatus();

    await expect(sheet(page)).toHaveAttribute("data-plus-state", "sign-in");
    await expect(sheet(page).locator(".note")).toContainText(
      "Sign in first so the purchase follows your account across web and iOS.",
    );
    const cta = sheet(page).getByRole("link", { name: "Sign in to continue" });
    await expect(cta).toBeVisible();
    await expect(cta).toHaveAttribute("href", /\/api\/auth\/login/);
  });

  test("7. error — 429 and 503 are told apart, and neither claims a charge", async ({ page }) => {
    await signedInWithPlus(page, "plus-429", () => ({ enabled: true }));
    const assert429 = await checkoutFails(page, 429, { error: "rate_limited" });
    await openSheetFromMenu(page);
    await sheet(page).locator(".plus-cta").click();
    await assert429();

    await expect(sheet(page)).toHaveAttribute("data-plus-state", "error");
    await expect(sheet(page).locator(".note")).toContainText("Give it a few minutes");

    // Re-route to a 503 and retry: the generic message must be a DIFFERENT
    // sentence, or the rate-limit branch is decoration.
    const assert503 = await checkoutFails(page, 503, { error: "not_enabled" });
    await sheet(page).locator(".plus-cta").click();
    await assert503();
    await expect(sheet(page).locator(".note")).toContainText("Nothing was charged");
    await expect(sheet(page).locator(".note")).not.toContainText("Give it a few minutes");
  });
});

// ---------------------------------------------------------------------------
// The other door, and a11y.
// ---------------------------------------------------------------------------

test.describe("the sheet's second door", () => {
  test("the save dialog's cap copy opens it", async ({ page }) => {
    // T06a wires `S.plusOpen`; this is the half that proves something renders
    // when it flips.
    await signedInWithPlus(page, "plus-cap", () => ({
      enabled: true,
      publicCount: 10,
      publicCap: 10,
    }));
    await drawOnCanvas(page, 21);
    await openSave(page);
    await page.locator(".field-cap .link-inline").click();

    await expect(sheet(page)).toBeVisible();
    await expect(sheet(page)).toHaveAttribute("data-plus-state", "before");
    await expect(sheet(page).locator(".plus-meter-head")).toContainText("10 of 10");
  });

  test("Escape closes the sheet", async ({ page }) => {
    await signedInWithPlus(page, "plus-esc", () => ({ enabled: true }));
    await openSheetFromMenu(page);
    await page.keyboard.press("Escape");
    await expect(sheet(page)).toHaveCount(0);
  });

  test("no axe violations with the sheet open", async ({ page }) => {
    // Light mode only. A dark-mode analyze() hangs the worker.
    await signedInWithPlus(page, "plus-axe", () => ({ enabled: true, publicCount: 9 }));
    await openSheetFromMenu(page);
    await page.evaluate(() =>
      Promise.all(
        document.getAnimations().map((a) => a.finished.then(() => undefined, () => undefined)),
      ),
    );
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    const summary = results.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      nodes: v.nodes.map((n) => ({ target: n.target.join(" "), why: n.failureSummary })),
    }));
    expect(summary, JSON.stringify(summary, null, 2)).toEqual([]);
  });
});
