import { test, expect, type Page } from "@playwright/test";
import {
  craftPiece,
  drawOnCanvas,
  hiddenOnlyDrawing,
  mockAtCap,
  openSave,
  submitSavePiece,
  testLogin,
  uniqueSub,
} from "./helpers";

// DESIGN.md §4: one dialog, ELEVEN states. One test per state, and each asserts
// a string or an affordance that ONLY that state shows — a test that merely
// checks the dialog opened would pass in all eleven and prove nothing.
//
// `data-save-state` on the card is the resolver's own verdict; every test pairs
// it with the visible copy, so a resolver that says the right word while
// rendering the wrong body still fails.

const dialog = (page: Page) => page.getByRole("dialog", { name: "Save to gallery" });

/** Get the title into a saveable shape without going through the chips. */
async function nameIt(page: Page, title: string) {
  await page.getByLabel("Title").fill(title);
}

test.describe("save dialog states", () => {
  test("1. SaveSignedOut — no session", async ({ page }) => {
    await page.goto("/");
    await drawOnCanvas(page, 1);
    await openSave(page);

    await expect(dialog(page)).toHaveAttribute("data-save-state", "signed-out");
    await expect(
      page.getByText("Your drawing stays on the canvas while you sign in."),
    ).toBeVisible();
    // Scoped to the dialog: the page header carries the same link.
    await expect(dialog(page).getByRole("link", { name: "Sign in with Google" })).toBeVisible();
    // Signed out there is nothing to save, so there is no form at all.
    await expect(page.getByLabel("Title")).toHaveCount(0);
  });

  test("2. SaveNothingVisible — every stroke is on a hidden layer", async ({ page }) => {
    await page.goto("/");
    await testLogin(page, uniqueSub("save-hidden"));

    // The only way to get ink onto a hidden layer on this branch (the layers
    // panel is T06c). The piece is real; so is the remix that loads it back.
    //
    // UNLISTED, not private, and that is a workaround: `GET /p/:id` currently
    // 500s for any piece it will not describe — a private one, or an unknown id
    // — because it hands back the immutable ASSETS response and the security
    // middleware then throws setting CSP on it (permalink.ts, `return shell`).
    // Reported to the lead; not this task's file to fix.
    const id = await craftPiece(page, {
      drawing: hiddenOnlyDrawing(),
      title: "Hidden Ink",
      visibility: "unlisted",
    });
    await page.goto(`/p/${id}`);
    await page.getByRole("button", { name: "Remix" }).click();
    await page.waitForURL((u) => u.pathname === "/");

    const events = await armShowLayersListener(page);
    await openSave(page);

    await expect(dialog(page)).toHaveAttribute("data-save-state", "nothing-visible");
    await expect(page.getByText("Nothing to save yet.")).toBeVisible();
    await expect(
      page.getByText("Everything you drew is on a hidden layer. Show a layer, or draw something new."),
    ).toBeVisible();
    // Nothing to name, nothing to verify.
    await expect(page.getByLabel("Title")).toHaveCount(0);
    await expect(page.locator(".ts-widget")).toHaveCount(0);

    await page.getByRole("button", { name: "Show layers" }).click();
    expect(await events()).toBe(1);
    await expect(dialog(page)).toHaveCount(0);
  });

  test("2b. an EMPTY canvas gets the headline but not the hidden-layer claim", async ({ page }) => {
    await page.goto("/");
    await testLogin(page, uniqueSub("save-empty"));
    await openSave(page);

    await expect(dialog(page)).toHaveAttribute("data-save-state", "nothing-visible");
    await expect(page.getByText("Nothing to save yet.")).toBeVisible();
    // The discriminator against test 2: with no strokes at all, the sentence
    // about a hidden layer would simply be false, and so would the button that
    // offers to go show one.
    await expect(page.getByText("Everything you drew is on a hidden layer.")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Show layers" })).toHaveCount(0);
  });

  test("3. SaveFirst — the ordinary save", async ({ page }) => {
    await page.goto("/");
    await testLogin(page, uniqueSub("save-first"));
    await drawOnCanvas(page, 2);
    await openSave(page);

    await expect(dialog(page)).toHaveAttribute("data-save-state", "first");
    // Empty with the placeholder carrying the ask — NOT pre-filled "Untitled",
    // which this client's own header now makes a hard 400.
    await expect(page.getByLabel("Title")).toHaveValue("");
    await expect(page.getByLabel("Title")).toHaveAttribute("placeholder", "Give it a name");
    await expect(page.locator(".save-actions .btn-primary")).toHaveText("Save piece");
    await expect(page.locator(".save-actions .btn-primary")).toBeEnabled();
    await expect(page.locator(".note")).toHaveCount(0);
    // Public is the default and is available.
    await expect(page.getByRole("button", { name: "Public", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByRole("button", { name: "Public", exact: true })).toBeEnabled();
  });

  test("3b. the AI name chips fill the title", async ({ page }) => {
    // The Workers AI binding is genuinely remote, and local dev has no
    // credentials for it — the endpoint catches that and answers `{names: []}`,
    // which is correct and also means the chips would otherwise never render in
    // any test. Stubbing the endpoint is what makes them a mechanism under test
    // rather than a code path nobody has looked at.
    await page.route("**/api/artworks/suggest-names", (r) =>
      r.fulfill({ json: { names: ["Saffron Orbit", "Twelve Doors", "Ember Lattice"] } }),
    );
    await page.goto("/");
    await testLogin(page, uniqueSub("save-chips"));
    await drawOnCanvas(page, 16);
    await openSave(page);

    await expect(page.locator(".save-suggest .chip")).toHaveCount(3);
    await page.locator(".save-suggest .chip", { hasText: "Twelve Doors" }).click();
    await expect(page.getByLabel("Title")).toHaveValue("Twelve Doors");
    await expect(page.locator(".save-actions .btn-primary")).toBeEnabled();
  });

  test("4. SaveTitleError — empty, and 'Untitled' in any spelling", async ({ page }) => {
    await page.goto("/");
    await testLogin(page, uniqueSub("save-title"));
    await drawOnCanvas(page, 3);
    await openSave(page);

    // An untouched empty title is SaveFirst, not an accusation. Clicking Save is
    // what turns it into the error — the same click that would otherwise 400.
    await expect(dialog(page)).toHaveAttribute("data-save-state", "first");
    await page.locator(".save-actions .btn-primary").click();
    await expect(dialog(page)).toHaveAttribute("data-save-state", "title-error");
    await expect(
      page.getByText("Give your piece a real name — “Untitled” doesn’t count."),
    ).toBeVisible();
    await expect(page.locator(".save-actions .btn-primary")).toBeDisabled();

    await nameIt(page, "Untitled");
    await expect(dialog(page)).toHaveAttribute("data-save-state", "title-error");
    await expect(page.locator(".save-actions .btn-primary")).toBeDisabled();

    // The fullwidth spelling the Worker's NFKC fold also rejects. Without the
    // client mirroring it, this would leave the dialog looking fine and the
    // save answering 400.
    await nameIt(page, "ｕｎｔｉｔｌｅｄ");
    await expect(dialog(page)).toHaveAttribute("data-save-state", "title-error");

    await nameIt(page, "Real Name");
    await expect(dialog(page)).toHaveAttribute("data-save-state", "first");
    await expect(page.locator(".save-actions .btn-primary")).toBeEnabled();
  });

  test("5. SaveSelfUnchanged — the pre-flight finds your own piece", async ({ page }) => {
    await page.goto("/");
    await testLogin(page, uniqueSub("save-self-un"));
    await drawOnCanvas(page, 4);
    await openSave(page);
    await nameIt(page, "Dawn Bloom");
    await submitSavePiece(page);
    const id = page.url().split("/p/")[1];

    // Remix loads the EXACT stored drawing back, so the hash is the stored one
    // by construction rather than by hoping two mouse paths agree.
    await page.getByRole("button", { name: "Remix" }).click();
    await page.waitForURL((u) => u.pathname === "/");
    await openSave(page);

    await expect(dialog(page)).toHaveAttribute("data-save-state", "self-unchanged");
    await expect(page.getByText("This is exactly the piece you already saved.")).toBeVisible();
    await expect(page.getByText("Make a change to save a new version.")).toBeVisible();
    await expect(page.locator(".piece-title")).toHaveText("Dawn Bloom");
    await expect(page.locator(".piece-line")).toContainText("You ·");
    // No title field: there is nothing new to name.
    await expect(page.getByLabel("Title")).toHaveCount(0);

    await page.getByRole("button", { name: "Open it" }).click();
    await expect(page).toHaveURL(new RegExp(`/p/${id}$`));
  });

  test("5b. SaveSelfUnchanged → Edit title & visibility PATCHes the existing piece", async ({
    page,
  }) => {
    await page.goto("/");
    await testLogin(page, uniqueSub("save-self-edit"));
    await drawOnCanvas(page, 5);
    await openSave(page);
    await nameIt(page, "First Name");
    await submitSavePiece(page);
    const id = page.url().split("/p/")[1];

    await page.getByRole("button", { name: "Remix" }).click();
    await page.waitForURL((u) => u.pathname === "/");
    await openSave(page);
    await expect(dialog(page)).toHaveAttribute("data-save-state", "self-unchanged");

    const patch = page.waitForResponse(
      (r) => r.url().includes(`/api/artworks/${id}`) && r.request().method() === "PATCH",
    );
    await page.getByRole("button", { name: "Edit title & visibility" }).click();
    await expect(page.getByLabel("Title")).toHaveValue("First Name");
    await nameIt(page, "Second Name");
    await page.getByRole("button", { name: "Save changes" }).click();
    expect((await patch).status()).toBe(200);

    await page.waitForURL(new RegExp(`/p/${id}$`));
    await expect(page).toHaveTitle(/Second Name — Kaleidoscope/);
  });

  test("6. SaveSelfChanged — a remix of your own piece that has moved on", async ({ page }) => {
    await page.goto("/");
    await testLogin(page, uniqueSub("save-self-chg"));
    await drawOnCanvas(page, 6);
    await openSave(page);
    await nameIt(page, "Ember Lattice");
    await submitSavePiece(page);

    await page.getByRole("button", { name: "Remix" }).click();
    await page.waitForURL((u) => u.pathname === "/");
    await drawOnCanvas(page, 7); // one more stroke → a different picture
    await openSave(page);

    await expect(dialog(page)).toHaveAttribute("data-save-state", "self-changed");
    await expect(page.locator(".save-remix-hint")).toHaveText("Remix of your Ember Lattice");
    // Seeded with the source title, and the button says what it will do.
    await expect(page.getByLabel("Title")).toHaveValue("Ember Lattice");
    await expect(page.locator(".save-actions .btn-primary")).toHaveText("Save as new");
  });

  test("7. SaveOtherUnchanged — the pre-flight finds someone else's viewable piece", async ({
    page,
  }) => {
    await page.goto("/");
    // Two accounts, one drawing — and the drawing is the DEFAULT per-run
    // perturbation, not `{ stable: true }`. Stable collides across RUNS too, and
    // with a per-run account that turns the first save into a 409 against last
    // run's user: the collision this test wants is within one run, which the
    // default jitter already gives (it is fixed for the whole process).
    await testLogin(page, uniqueSub("save-other-a"));
    await drawOnCanvas(page, 8);
    await openSave(page);
    await nameIt(page, "Twelve Doors");
    await submitSavePiece(page);
    const id = page.url().split("/p/")[1];

    await testLogin(page, uniqueSub("save-other-b"));
    await page.goto(`/p/${id}`);
    await page.getByRole("button", { name: "Remix" }).click();
    await page.waitForURL((u) => u.pathname === "/");
    await openSave(page);

    await expect(dialog(page)).toHaveAttribute("data-save-state", "other-unchanged");
    await expect(page.getByText("This exact drawing is already in the gallery.")).toBeVisible();
    await expect(page.getByText("Make a change to save your version — anything counts.")).toBeVisible();
    await expect(page.locator(".piece-line")).toContainText("by E2E save-other-a");
    await expect(page.locator(".save-actions .btn-primary")).toBeDisabled();
  });

  test("8. SaveDuplicateOther — POST 409 WITH `of`", async ({ page }) => {
    await page.goto("/");
    await testLogin(page, uniqueSub("save-dup-a"));
    await drawOnCanvas(page, 9);
    await openSave(page);
    await nameIt(page, "Saffron Orbit");
    await submitSavePiece(page);
    const id = page.url().split("/p/")[1];

    await testLogin(page, uniqueSub("save-dup-b"));
    await page.goto(`/p/${id}`);
    await page.getByRole("button", { name: "Remix" }).click();
    await page.waitForURL((u) => u.pathname === "/");

    // Blind the pre-flight so the POST is what discovers the twin. 429 is a real
    // response from that route (120/h), not an invented one — and this is the
    // only way to reach the POST branch, since a working pre-flight correctly
    // short-circuits to SaveOtherUnchanged first.
    await page.route("**/api/artworks/hash/**", (r) =>
      r.fulfill({ status: 429, json: { error: "rate_limited" } }),
    );

    const post = page.waitForResponse(
      (r) => r.url().endsWith("/api/artworks") && r.request().method() === "POST",
    );
    await openSave(page);
    await expect(dialog(page)).toHaveAttribute("data-save-state", "first");
    await nameIt(page, "My Version");
    await submitDoomed(page);

    expect((await post).status()).toBe(409);
    await expect(dialog(page)).toHaveAttribute("data-save-state", "duplicate-other");
    await expect(page.locator(".note")).toContainText("This exact drawing is already in the gallery as");
    await expect(page.locator(".note")).toContainText("by E2E save-dup-a");
    // The link is the thing this state has and the private variant does not.
    await expect(page.locator(".note a")).toHaveAttribute("href", `/p/${id}`);
    await expect(page.locator(".note a")).toHaveText("Saffron Orbit");
    await expect(page.locator(".save-actions .btn-primary")).toBeDisabled();
  });

  test("9. SaveDuplicateOtherPrivate — POST 409 WITHOUT `of`", async ({ page }) => {
    // The state the plan never had. Someone else holds this exact drawing
    // privately: the pre-flight withholds it (correctly — naming it would leak
    // both its existence and its title), so the POST 409s with nothing to link.
    await page.goto("/");
    await testLogin(page, uniqueSub("save-priv-a"));
    await drawOnCanvas(page, 10);
    await openSave(page);
    await nameIt(page, "Kept Quiet");
    await page.getByRole("button", { name: "Private", exact: true }).click();
    await submitSavePiece(page);

    // testLogin reloads in place, and in place is the permalink — go back to the
    // studio before reaching for the canvas.
    await testLogin(page, uniqueSub("save-priv-b"));
    await page.goto("/");
    await drawOnCanvas(page, 10);

    const post = page.waitForResponse(
      (r) => r.url().endsWith("/api/artworks") && r.request().method() === "POST",
    );
    await openSave(page);
    // The pre-flight ran and found NOTHING — that is the withholding working.
    await expect(dialog(page)).toHaveAttribute("data-save-state", "first");
    await nameIt(page, "My Version");
    await submitDoomed(page);

    const res = await post;
    // 409 here is also the proof the two drawings hashed the same. A 201 would
    // mean the fixture drifted, and the assertion below would then be vacuous.
    expect(res.status()).toBe(409);
    expect(await res.json()).toEqual({ error: "duplicate_of_other" });

    await expect(dialog(page)).toHaveAttribute("data-save-state", "duplicate-other-private");
    await expect(page.locator(".note")).toContainText(
      "Someone already has this exact drawing in their private collection",
    );
    // The negative that separates this from state 8: nothing to open, and no
    // one named. Without it, one component could render both and both pass.
    await expect(page.locator(".note a")).toHaveCount(0);
    await expect(page.locator(".note")).not.toContainText("save-priv-a");
    await expect(page.locator(".save-actions .btn-primary")).toBeDisabled();
  });

  test("10. SaveAtCap — the public wall is already full", async ({ page }) => {
    await mockAtCap(page, 10, 10);
    await page.goto("/");
    await testLogin(page, uniqueSub("save-cap"));
    await drawOnCanvas(page, 11);
    await openSave(page);

    await expect(dialog(page)).toHaveAttribute("data-save-state", "at-cap");
    await expect(page.getByRole("button", { name: "Public", exact: true })).toBeDisabled();
    // `exact`, because the primary button reads "Save unlisted".
    await expect(page.getByRole("button", { name: "Unlisted", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.locator(".field-cap")).toContainText("Your public wall is full (10 of 10)");
    // The cap is a CURRENT count, so the copy has to offer both exits.
    await expect(page.locator(".field-cap")).toContainText("make an older piece private");
    await expect(page.locator(".field-cap .link-inline")).toHaveText("get Kaleidoscope Plus");
    await expect(page.locator(".save-actions .btn-primary")).toHaveText("Save unlisted");
  });

  test("10b. a 201 that came back capReached lands in the same state, piece saved", async ({
    page,
  }) => {
    await page.goto("/");
    await testLogin(page, uniqueSub("save-cap-post"));
    await drawOnCanvas(page, 12);
    // The Worker cannot produce this locally (PLUS_ENABLED is unset, so no cap
    // is enforced). Its arithmetic is covered by the worker unit tests; what is
    // under test here is that the client renders a SAVED piece rather than an
    // offer to save one.
    await page.route("**/api/artworks", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      await route.fulfill({
        status: 201,
        json: {
          id: "capped123",
          url: "/p/capped123",
          visibility: "unlisted",
          capReached: true,
          cap: 10,
          count: 10,
        },
      });
    });

    await openSave(page);
    await nameIt(page, "Overflow");
    // Same retry-until-the-token-lands loop as every other submit: a click
    // before Turnstile answers is a deliberate no-op, not a failure.
    await submitUntil(page, page.locator(".note"));

    await expect(dialog(page)).toHaveAttribute("data-save-state", "at-cap");
    await expect(page.locator(".note")).toContainText("Saved unlisted.");
    await expect(page.locator(".note")).toContainText("Your public wall is full (10 of 10)");
    await expect(page.locator(".save-actions .btn-primary")).toHaveText("Open it");
    // Saved means saved: no verification widget offering to do it again.
    await expect(page.locator(".ts-widget")).toHaveCount(0);
  });

  test("11. SaveError — the gallery cannot be reached", async ({ page }) => {
    await page.goto("/");
    await testLogin(page, uniqueSub("save-err"));
    await drawOnCanvas(page, 13);
    await page.route("**/api/artworks", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      await route.abort("connectionfailed");
    });

    await openSave(page);
    await nameIt(page, "Doomed Piece");
    await submitDoomed(page);

    await expect(dialog(page)).toHaveAttribute("data-save-state", "error");
    await expect(page.locator(".note-alert")).toContainText(
      "Couldn’t reach the gallery. Your drawing is safe here — try again in a moment.",
    );
    await expect(page.locator(".save-actions .btn-primary")).toHaveText("Try again");
    await expect(page.locator(".save-actions .btn-primary")).toBeEnabled();
    // "Your drawing is safe here" has to be true: the dialog is still open over
    // a canvas that still has the strokes.
    await expect(page.getByLabel("Title")).toHaveValue("Doomed Piece");
  });
});

test.describe("my pieces — 402 cap_reached on a visibility change", () => {
  test("the select snaps back and says why", async ({ page }) => {
    await page.goto("/");
    await testLogin(page, uniqueSub("cap-patch"));
    await drawOnCanvas(page, 14);
    await openSave(page);
    await nameIt(page, "Wall Piece");
    await page.getByRole("button", { name: "Unlisted", exact: true }).click();
    await submitSavePiece(page);

    await page.route("**/api/artworks/*", async (route) => {
      if (route.request().method() !== "PATCH") return route.fallback();
      await route.fulfill({ status: 402, json: { error: "cap_reached", cap: 10, count: 10 } });
    });

    await page.goto("/me");
    const select = page.locator(".art-card select").first();
    await expect(select).toHaveValue("unlisted");
    await select.selectOption("public");

    await expect(page.locator(".art-cap")).toContainText("Public wall is full (10 of 10)");
    await expect(page.locator(".art-cap")).toContainText("Make another piece private to free a slot");
    // The assertion that would still pass if the revert were deleted is the
    // message; this is the one that would not. A refused change must not leave
    // the control showing a value the server rejected.
    await expect(select).toHaveValue("unlisted");
    await expect(page.locator(".art-card option[value=public]").first()).toBeDisabled();
  });

  test("a plain failure reverts too, with no cap message", async ({ page }) => {
    // The cap case gets a second re-render for free (the message appears), so
    // it cannot tell whether the explicit revert does anything. A 500 changes
    // nothing else on screen — if the state is not rewritten here, the select
    // simply keeps the value the server refused.
    await page.goto("/");
    await testLogin(page, uniqueSub("patch-500"));
    await drawOnCanvas(page, 15);
    await openSave(page);
    await nameIt(page, "Stubborn Piece");
    await page.getByRole("button", { name: "Unlisted", exact: true }).click();
    await submitSavePiece(page);

    await page.route("**/api/artworks/*", async (route) => {
      if (route.request().method() !== "PATCH") return route.fallback();
      await route.fulfill({ status: 500, json: { error: "server_error" } });
    });

    await page.goto("/me");
    const select = page.locator(".art-card select").first();
    await select.selectOption("private");
    await expect(select).toHaveValue("unlisted");
    await expect(page.locator(".art-cap")).toHaveCount(0);
  });
});

// ---- small utilities -------------------------------------------------------

/**
 * Click the primary action for a save that is expected NOT to navigate.
 *
 * `submitSavePiece` waits for the permalink; these cases end in a 409 or a
 * network failure, so they need the same retry-until-the-token-lands loop
 * without the redirect.
 */
async function submitDoomed(page: Page): Promise<void> {
  await submitUntil(page, page.locator(".note-alert"));
}

/** Click the primary action until `settled` appears. */
async function submitUntil(page: Page, settled: ReturnType<Page["locator"]>): Promise<void> {
  await expect(async () => {
    await page.locator(".save-actions .btn-primary").click();
    await expect(settled).toBeVisible({ timeout: 2500 });
  }).toPass({ timeout: 20_000 });
}

/** Count `kaleido:show-layers` events, the seam the panel (T06c) will listen on. */
async function armShowLayersListener(page: Page): Promise<() => Promise<number>> {
  await page.evaluate(() => {
    (window as unknown as { __showLayers: number }).__showLayers = 0;
    window.addEventListener("kaleido:show-layers", () => {
      (window as unknown as { __showLayers: number }).__showLayers++;
    });
  });
  return () => page.evaluate(() => (window as unknown as { __showLayers: number }).__showLayers);
}
