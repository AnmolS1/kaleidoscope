import { test, expect, type Page } from "@playwright/test";
import { drawOnCanvas, openSave, submitSavePiece, testLogin, uniqueSub } from "./helpers";

// The studio chrome is three different layouts (DESIGN.md §2): a rail at
// regular width, a dock + scrolling strip at compact width, and the rail
// restyled at compact height. Every layout assertion below is paired with its
// negative half at the OTHER breakpoint — "the dock is visible" passes at
// desktop too if the dock were merely rendered off-screen, so it is asserted
// together with "there is no rail" and vice versa.

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

/**
 * Any PANEL painted over the middle of the viewport, or "none".
 *
 * `elementsFromPoint`, not `elementFromPoint`: the dismiss scrim is a
 * full-bleed transparent layer and would always be the topmost hit, which would
 * make the whole check answer "something is over the centre" forever. The rule
 * being tested is DESIGN.md's "no panel covers the drawing's centre".
 */
function panelAtCentre(page: Page): Promise<string> {
  return page.evaluate(() => {
    const els = document.elementsFromPoint(
      Math.round(window.innerWidth / 2),
      Math.round(window.innerHeight / 2),
    );
    const panel = els.find((el) => el.closest(".menu-panel, .pop-panel, .overlay-card"));
    return panel ? `${panel.tagName}.${panel.className}` : "none";
  });
}

/**
 * How far out from an element's centre it still owns the hit test, in each
 * direction — i.e. its EFFECTIVE target, not its painted box.
 *
 * A `::before` that expands a small control's hit area only works if nothing
 * overlaps it: two overlapping expanded boxes do not both win, the later sibling
 * takes the overlap. Measuring the painted box (or trusting the CSS) misses that
 * entirely, which is exactly how a row of 24px swatches kept a ~32px effective
 * target while the stylesheet claimed 44.
 */
function exclusiveTarget(page: Page, selector: string, nth = 0) {
  return page.locator(selector).nth(nth).evaluate((el) => {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const owns = (dx: number, dy: number) => {
      const hit = document.elementFromPoint(cx + dx, cy + dy);
      return !!hit && (hit === el || el.contains(hit));
    };
    const reach = (dx: number, dy: number) => {
      let n = 0;
      while (n < 60 && owns(dx * (n + 1), dy * (n + 1))) n++;
      return n;
    };
    // +1 for the centre pixel itself, which neither one-sided walk counts.
    return { width: reach(-1, 0) + reach(1, 0) + 1, height: reach(0, -1) + reach(0, 1) + 1 };
  });
}

test.describe("compact width (phone portrait)", () => {
  test.use({ viewport: PHONE });

  test("dock + strip layout, bottom-sheet save, gallery 2-col + brand, initials fallback", async ({
    page,
  }) => {
    await page.goto("/");
    await testLogin(page, uniqueSub("mobile"));

    // Phone chrome: a docked tool bar and a scrolling strip — and NO rail. The
    // second half is what makes this a phone assertion rather than a "some
    // toolbar exists" assertion.
    await expect(page.locator(".dock")).toBeVisible();
    await expect(page.locator(".strip")).toBeVisible();
    await expect(page.locator(".rail")).toHaveCount(0);
    await expect(page.locator(".edge-sliders")).toHaveCount(0);

    // Exactly one toolbar landmark, and it is the dock.
    await expect(page.getByRole("toolbar", { name: "Drawing tools" })).toBeVisible();
    expect(await page.locator('.dock[role="toolbar"]').count()).toBe(1);

    // No horizontal scroll on a phone-width viewport. (The strip scrolls inside
    // itself; the page must not.)
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);

    // Every dock target clears 44px. These are sized unconditionally rather than
    // behind `@media (pointer: coarse)`, which a viewport-only test never
    // triggers — so this assertion measures the shipped size, not a vacuous one.
    const small = await page.locator(".dock .icon-btn").evaluateAll((els) =>
      els
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.width < 44 || r.height < 44)
        .map((r) => `${Math.round(r.width)}x${Math.round(r.height)}`),
    );
    expect(small, "dock buttons under 44px").toEqual([]);

    // Palette swatches are 24px dots whose hit area is expanded by a
    // pseudo-element. Assert the EFFECTIVE target, not the painted box: with the
    // frame's 8px gaps the expansions overlap and each swatch really owned only
    // ~32px, while the painted box and the stylesheet both looked correct.
    const swatch = await exclusiveTarget(page, ".strip .swatch");
    expect(swatch.width, "swatch effective width").toBeGreaterThanOrEqual(44);
    expect(swatch.height, "swatch effective height").toBeGreaterThanOrEqual(44);

    // A strip chip opens a bottom sheet. It must paint ABOVE the canvas AND
    // above the dock (regression: the opaque canvas, later in DOM, hid an
    // upward-opening panel; the dock's own stacking context then hid the sheet).
    // toBeVisible() cannot catch either — hit-test the control.
    const brushChip = page.locator('.strip summary[aria-label^="Brush settings"]');
    await brushChip.click();
    const sizeInput = page.locator('.strip details[open] .menu-panel input[aria-label="Brush size"]');
    await expect(sizeInput).toBeVisible();
    const onTop = await sizeInput.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
      return !!hit && (el === hit || el.contains(hit) || hit.contains(el));
    });
    expect(onTop).toBe(true);

    // "No panel covers the drawing's centre" (DESIGN.md §2) — with the tallest
    // sheet open, the middle of the viewport is still canvas.
    expect(await panelAtCentre(page)).toBe("none");

    // Dismiss by tapping outside. The chip that opened the sheet is UNDER it —
    // an open bottom sheet covers the strip — so tap-outside is the only way
    // back, which is exactly why the scrim exists.
    // Target the scrim by locator, not by raw coordinates: a bare mouse click
    // races the render that puts the scrim there and lands on the canvas
    // instead — which passes locally and fails under load.
    await page.locator(".pop-scrim").click({ position: { x: 195, y: 300 } });
    await expect(page.locator(".strip .pop-brush")).toBeHidden();

    // Draw, then open Save — it docks as a bottom sheet with the action in view
    // (the bug this fixes pushed Save/Cancel off-screen).
    await drawOnCanvas(page, 4);
    // Through `openSave`, so the in-viewport assertion below is made against the
    // real form and not the pre-flight placeholder (which is short enough to fit
    // on any screen and would pass the very check this test exists for).
    await openSave(page);
    await page.getByLabel("Title").fill("Mobile Mandala");
    await expect(page.locator(".save-actions .btn-primary")).toBeInViewport();

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
});

test.describe("regular width (rail)", () => {
  test.use({ viewport: DESKTOP });

  test("rail layout, edge sliders inset from the edge, nothing over the centre", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".canvas-host canvas");

    // The negative half: no dock, no strip at this width.
    await expect(page.locator(".rail")).toBeVisible();
    await expect(page.locator(".edge-sliders")).toBeVisible();
    await expect(page.locator(".dock")).toHaveCount(0);
    await expect(page.locator(".strip")).toHaveCount(0);
    expect(await page.locator('.rail[role="toolbar"]').count()).toBe(1);

    // Rail targets are 44px here too (the 36px allowance is the top actions).
    // Direct children only: `.rail .icon-btn` would also sweep in the buttons
    // inside a rail-anchored popover, which are a different control class.
    const small = await page.locator(".rail > .icon-btn, .rail > .menu > summary.icon-btn").evaluateAll((els) =>
      els
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.width < 44 || r.height < 44)
        .map((r) => `${Math.round(r.width)}x${Math.round(r.height)}`),
    );
    expect(small, "rail buttons under 44px").toEqual([]);

    // Edge sliders must clear the viewport edge by ≥20px — a slider flush to the
    // edge fights the iPad system swipe. Assert the REQUIREMENT (≥20), not the
    // design's exact 24, so a legitimate re-inset does not fail the gate.
    const inset = await page.locator(".edge-sliders").evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { right: window.innerWidth - r.right, left: r.left };
    });
    expect(inset.right).toBeGreaterThanOrEqual(20);
    expect(inset.left).toBeGreaterThan(20);

    // The colour popover's swatches get the same treatment as the strip's: this
    // popover is the picker on an iPad too, so its 24px dots need the same
    // exclusive 44px target, and the 10px gap a mouse would want does not give
    // it. Measured on the second swatch, which has neighbours on both sides.
    await page.locator('.rail summary[aria-label="Color"]').click();
    await expect(page.locator(".pop-swatches")).toBeVisible();
    const popSwatch = await exclusiveTarget(page, ".pop-swatches .swatch", 1);
    expect(popSwatch.width, "popover swatch effective width").toBeGreaterThanOrEqual(44);
    expect(popSwatch.height, "popover swatch effective height").toBeGreaterThanOrEqual(44);
    await page.locator(".pop-scrim").click({ position: { x: 640, y: 400 } });

    // "No panel covers the drawing's centre" (DESIGN.md §2), checked for EACH
    // popover — they are one-at-a-time, so opening them all at once would only
    // ever test the last one.
    for (const [label, inside] of [
      ['.rail summary[aria-label="Color"]', ".pop-swatches"],
      ['.rail summary[aria-label^="Symmetry settings"]', ".pop-sym"],
      ['.rail summary[aria-label="Brush settings"]', ".pop-brush"],
      ['.rail summary[aria-label="More options"]', ".overflow-menu .menu-panel"],
      ["#download-menu > summary", "#download-menu .menu-panel"],
    ] as const) {
      await page.locator(label).click();
      await expect(page.locator(inside)).toBeVisible();
      expect(await panelAtCentre(page), `${label} covers the centre`).toBe("none");
    }
  });

  test("a popover closes on a tap outside, and the tap does not reach the canvas", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".canvas-host canvas");
    await page.locator('.rail summary[aria-label="Brush settings"]').click();
    await expect(page.locator(".pop-brush")).toBeVisible();

    // Middle of the canvas: with the scrim in place this dismisses the popover
    // and commits nothing. Without it the dismissing tap would also land a
    // one-point stroke — which is why Clear is the discriminator here.
    await page.locator(".pop-scrim").click({ position: { x: 640, y: 400 } });
    // `<details>` keeps its children in the DOM when closed, so this is a
    // visibility assertion, not a count one.
    await expect(page.locator(".pop-brush")).toBeHidden();
    await expect(page.getByLabel("Clear canvas")).toBeDisabled();
  });

  test("the decorative chrome does not intercept a stroke", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".canvas-host canvas");

    // `.studio-chrome` is pointer-events: none with each interactive island
    // opting back in. The readout capsule and the shortcut strip deliberately do
    // NOT, so they can float over the drawing. That was a claim in a CSS comment
    // until now; this is the claim as a test.
    for (const sel of [".top-bar .readout", ".shortcut-strip"]) {
      const hit = await page.locator(sel).evaluate((el) => {
        const r = el.getBoundingClientRect();
        const h = document.elementFromPoint(
          Math.round(r.left + r.width / 2),
          Math.round(r.top + r.height / 2),
        );
        return h ? h.tagName : "none";
      });
      expect(hit, `${sel} intercepts the pointer`).toBe("CANVAS");
    }

    // And the consequence that actually matters: a stroke STARTED on the readout
    // still draws. A hit test alone would not catch a capsule that swallowed
    // pointerdown while reporting the canvas underneath.
    const box = (await page.locator(".top-bar .readout").boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) await page.mouse.move(x + i * 8, y + i * 12);
    await page.mouse.up();
    await expect(page.getByLabel("Clear canvas")).toBeEnabled();
  });

  test("the shortcut strip lists only shortcuts that work", async ({ page }) => {
    await page.goto("/");
    const strip = page.locator(".shortcut-strip");
    await expect(strip).toBeVisible();
    const keys = await strip.locator("kbd").allTextContents();
    // DESIGN.md's strip, in full now that T06c has landed `E` (remove-stroke)
    // and `L` (layers) — they were filtered out while their handlers did not
    // exist, rather than advertised as dead keys. This assertion is what fails
    // if someone adds a key to the strip without adding the handler. The keys
    // themselves are exercised in layers.spec.ts, which owns that tool and panel.
    expect(keys).toEqual(["B", "G", "E", "L", ",", ".", "[", "]", "⌘Z", "?"]);

    // …and the keys the strip claims actually do something.
    // Scoped to the rail: the brush popover carries the same trio, so an
    // unscoped getByLabel is a strict-mode violation.
    const railGlow = page.locator('.rail > .icon-btn[aria-label="Glow brush"]');
    const railSolid = page.locator('.rail > .icon-btn[aria-label="Solid brush"]');
    await page.keyboard.press("g");
    await expect(railGlow).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("b");
    await expect(railSolid).toHaveAttribute("aria-pressed", "true");
    const readout = page.locator(".top-bar .readout");
    const before = await readout.innerText();
    await page.keyboard.press(".");
    await expect(readout).not.toHaveText(before);
  });

  test("the brush popover hides its pressure controls until a pen has been seen", async ({ page }) => {
    // Both directions. Asserting only the "shown" half would pass with the
    // `penSeen` gate deleted, which is the whole point of the gate.
    await page.goto("/");
    await page.locator('.rail summary[aria-label="Brush settings"]').click();
    await expect(page.getByRole("group", { name: "Pressure preset" })).toHaveCount(0);
    await expect(page.getByRole("switch", { name: /Smooth strokes/ })).toBeVisible();

    // localStorage needs an origin, so seed it after the first load and reload.
    await page.evaluate(() => localStorage.setItem("kal.penSeen", "true"));
    await page.reload();
    await page.locator('.rail summary[aria-label="Brush settings"]').click();
    await expect(page.getByRole("group", { name: "Pressure preset" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Firm" })).toBeVisible();
  });
});
