import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { drawOnCanvas, uniqueSub, testLogin } from "./helpers";

// T06c — the layers panel and the remove-stroke tool (DESIGN.md §3).
//
// WHAT EACH ASSERTION HERE IS DEFENDING AGAINST, because several of these look
// like they would pass either way and do not:
//
//  * The panel lists layers TOP-FIRST while `S.layers` is BOTTOM-FIRST, so every
//    index crossing back into the engine is flipped. "The order changed" passes
//    with the flip inverted, so the order tests are pinned against the readout's
//    `L<n>`, which is computed from the model array — panel and readout have to
//    agree or the mapping is wrong.
//  * The locked Add state is asserted at cap 3 AND cap 8, with the cap-8/3-layer
//    case in between as the control. An assertion that only ever sees a full
//    stack cannot tell "locked at the cap" from "locked always".
//  * Remove-stroke asserts WHICH stroke went, via the confirm capsule's identity
//    (layer name + image count) and by re-probing both locations afterwards. A
//    count that drops by one is satisfied by deleting the wrong stroke.
//  * The non-undoable rules (visibility, rename) are asserted POSITIVELY — the
//    rename and the hide must SURVIVE an undo that reverts the operation before
//    them. "Undo is disabled" would pass vacuously.
//
// NO DARK-MODE AXE SCAN. A dark `analyze()` hangs the Playwright worker (see the
// note at the top of a11y.spec.ts); dark contrast is unit-tested instead.

const LAYERS_BTN = /^Layers, /;

async function openPanel(page: Page): Promise<void> {
  await page.getByRole("button", { name: LAYERS_BTN }).first().click();
  await expect(page.locator(".layers-panel")).toBeVisible();
}

/** Row names, top row first — i.e. the order a person reads them. */
function rowNames(page: Page) {
  return page.locator(".layer-name").allTextContents();
}

/** The active-layer index the READOUT reports, from the model array. */
async function readoutLayer(page: Page): Promise<string> {
  const text = (await page.locator(".readout").first().textContent()) ?? "";
  return text.trim().split(" ")[0];
}

async function addLayers(page: Page, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await page.getByRole("button", { name: /^Add layer/ }).click();
}

/** Drag a row's grip onto the row currently at `toIndex`. */
async function dragRow(page: Page, fromIndex: number, toIndex: number, cancel = false) {
  const grips = page.locator(".layer-grip");
  const from = await grips.nth(fromIndex).boundingBox();
  const to = await grips.nth(toIndex).boundingBox();
  if (!from || !to) throw new Error("grip not found");
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  // Two moves: the first is the one that starts the gesture, the second lands
  // it. A single jump can be delivered before the pointer capture is live.
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 + 12, { steps: 3 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 6 });
  if (cancel) await page.keyboard.press("Escape");
  await page.mouse.up();
}

/**
 * The size a control actually OWNS, walked out from its centre with
 * `elementFromPoint` — its effective target, not its painted box.
 *
 * Copied from `mobile.spec.ts`, where it was written after a row of swatches
 * kept a ~32px effective target while both the painted box and the stylesheet
 * said 44: `inset` resolves against the padding box, and two overlapping
 * expanded boxes do not both win — the later sibling takes the overlap.
 * Measuring the box is exactly what hid that, so the panel's own small targets
 * are measured the same way.
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

/**
 * Set the layer cap directly, rather than through `/api/me`.
 *
 * The cap does come from `plus.layerCap`, but a signed-out or offline studio
 * falls back to the default — so a test that drives it by signing in is
 * asserting the auth round-trip as much as the panel. Reaching for the signal
 * makes the cap an input to the test instead of a consequence of one.
 */
async function setLayerCap(page: Page, cap: number): Promise<void> {
  await page.evaluate(async (n) => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const S = await load("/src/client/state.ts");
    S.layerCap.value = n;
  }, cap);
}

/**
 * Drive the Plus SURFACE, rather than inheriting whatever the deploy ships.
 *
 * The footnote's offer is gated on it, so a test that reads it from
 * `wrangler.jsonc` is asserting today's rollout state. That is not theoretical:
 * turning the flag on for the App Review window turned this file red inside the
 * deploy pipeline, on a change with nothing to do with layers.
 */
async function setPlusSurface(page: Page, surface: boolean): Promise<void> {
  await page.evaluate(async (on) => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const S = await load("/src/client/state.ts");
    const cur = S.plus.value ?? {
      active: false, sources: [], publicCount: 0, publicCap: null, layerCap: 3, enabled: false,
    };
    S.plus.value = { ...cur, surface: on };
  }, surface);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector(".canvas-host canvas");
});

// ---------------------------------------------------------------------------
// panel structure
// ---------------------------------------------------------------------------

test("panel lists layers top-first, and the bottom row is the readout's L1", async ({ page }) => {
  await openPanel(page);
  await addLayers(page, 2);

  const names = await rowNames(page);
  expect(names).toEqual(["Layer 3", "Layer 2", "Layer 1"]);

  // THE DISCRIMINATOR. `L<n>` is `findIndex` into the bottom-first model array,
  // so if the panel's display→model flip were inverted the two would disagree
  // here while the list above still looked perfectly ordered.
  await page.locator(".layer-name").last().click();
  expect(await readoutLayer(page)).toBe("L1");
  await page.locator(".layer-name").first().click();
  expect(await readoutLayer(page)).toBe("L3");
});

/**
 * The fold count a NEW drawing opens at. Named once here because several
 * assertions below are about how that value is DISPLAYED and how many symmetry
 * images it produces — so when the product default moves (12 → 8, to match
 * iOS), one line changes rather than four scattered literals, and a failure
 * says "the default moved" instead of looking like four unrelated breakages.
 */
const DEFAULT_FOLD = 8;

test("a row shows its own name, symmetry, mirror and opacity", async ({ page }) => {
  await openPanel(page);
  const row = page.locator(".layer-row").first();
  await expect(row.locator(".layer-name")).toHaveText("Layer 1");
  await expect(row.locator(".layer-line")).toHaveText(`${DEFAULT_FOLD} · D · 100%`);

  // The line tracks the layer, not a global: change segments and drop mirror.
  // One step DOWN from the default, so the expectation moves with it.
  await page.keyboard.press(",");
  await page.keyboard.press("m");
  await expect(row.locator(".layer-line")).toHaveText(`${DEFAULT_FOLD - 1} · C · 100%`);
});

test("the eye hides a layer and the row says so", async ({ page }) => {
  await openPanel(page);
  await expect(page.locator(".layer-row.is-hidden")).toHaveCount(0);
  await page.getByRole("button", { name: "Hide Layer 1" }).click();
  await expect(page.locator(".layer-row.is-hidden")).toHaveCount(1);
  await page.getByRole("button", { name: "Show Layer 1" }).click();
  await expect(page.locator(".layer-row.is-hidden")).toHaveCount(0);
});

test("double-click renames a row inline, and Escape abandons the edit", async ({ page }) => {
  await openPanel(page);
  await page.locator(".layer-name").first().dblclick();
  await page.locator(".layer-rename").fill("Ribbons");
  await page.keyboard.press("Enter");
  await expect(page.locator(".layer-name").first()).toHaveText("Ribbons");

  await page.locator(".layer-name").first().dblclick();
  await page.locator(".layer-rename").fill("Discarded");
  await page.keyboard.press("Escape");
  await expect(page.locator(".layer-name").first()).toHaveText("Ribbons");
});

test("a row's symmetry line selects that layer and opens the symmetry popover", async ({ page }) => {
  await openPanel(page);
  await addLayers(page, 1);
  // Layer 2 is active after the add; reach for the BOTTOM row's sym line.
  expect(await readoutLayer(page)).toBe("L2");
  await page.locator(".layer-sym").last().click();
  expect(await readoutLayer(page)).toBe("L1");
  await expect(page.locator(".pop-sym")).toBeVisible();
  // The popover names the layer it edits.
  await expect(page.locator(".pop-sym .chip-sm")).toHaveText("Layer 1");
});

// ---------------------------------------------------------------------------
// the cap — asserted at BOTH caps, with the unlocked middle case as control
// ---------------------------------------------------------------------------

test("Add locks at the cap, is unlocked below it, and says which cap it is", async ({ page }) => {
  // THE CAP IS DRIVEN DIRECTLY, not via sign-in. It really does come from
  // `plus.layerCap`, but a signed-out or offline studio falls back to the
  // default, so driving it through the API would make this partly a test of the
  // auth round-trip. Here the cap is an input.
  await openPanel(page);
  const add = page.getByRole("button", { name: /^Add layer/ });

  // --- free: cap 3 ---
  await setLayerCap(page, 3);
  await expect(page.locator(".layers-count")).toHaveText("1 of 3");
  await expect(add).toBeEnabled();
  await expect(page.locator(".layer-note")).toHaveCount(0);

  await addLayers(page, 2);
  await expect(page.locator(".layers-count")).toHaveText("3 of 3");
  await expect(add).toBeDisabled();

  // Without the Plus surface the footnote states the cap and offers nothing —
  // the link would open a sheet that refuses to render (S14). The surface-on
  // variant is its own test below, because turning it on mid-flow changes
  // unrelated chrome.
  //
  // Set explicitly: "no offer" is the behaviour under test, so the test has to
  // say the surface is off rather than depend on the deploy still shipping it
  // that way.
  await setPlusSurface(page, false);
  await expect(page.locator(".layer-note")).toHaveText("Layers: 3 of 3");
  await expect(page.locator(".layer-note")).not.toHaveText(
    "Layers: 3 of 3 · Kaleidoscope Plus unlocks 8",
  );
  // The link itself is asserted in "the cap footnote offers Plus only when the
  // surface is on" below, where the surface is set BEFORE the panel renders.

  // --- THE CONTROL: the SAME three layers at cap 8 must be UNLOCKED ---
  // Without this case, "disabled at 3 of 3" and "disabled at 8 of 8" are both
  // satisfied by an Add button that is simply always disabled. Nothing about
  // the stack changes here — only the cap — so it isolates the cap exactly.
  await setLayerCap(page, 8);
  await expect(page.locator(".layers-count")).toHaveText("3 of 8");
  await expect(add).toBeEnabled();
  await expect(page.locator(".layer-note")).toHaveCount(0);

  // --- Plus: cap 8, a different footnote, and no upsell ---
  await addLayers(page, 5);
  await expect(page.locator(".layers-count")).toHaveText("8 of 8");
  await expect(add).toBeDisabled();
  await expect(page.locator(".layer-note")).toHaveText("All 8 layers in use");
  await expect(page.locator(".layer-note .link-inline")).toHaveCount(0);

  // A FULL STACK STILL HAS TO FIT. Eight rows plus header, hairline, footer and
  // footnote come to ~595px, and from `top: 68px` that runs off the bottom of
  // any viewport under ~680px CSS — which a 1366x768 laptop is, once browser
  // chrome is taken out. `.studio` is `overflow: hidden`, so there is no page
  // scroll to rescue it: the footnote, and on a shorter window the Delete chip,
  // just become unreachable. Only this test ever builds eight rows.
  await page.setViewportSize({ width: 1280, height: 650 });
  const panel = (await page.locator(".layers-panel").boundingBox())!;
  expect(panel.y + panel.height, "the panel runs past the bottom of the viewport").toBeLessThanOrEqual(650);
  for (const label of ["Add layer, locked at 8", "Duplicate layer", "Delete layer"]) {
    const chip = (await page.getByRole("button", { name: label }).boundingBox())!;
    expect(chip.y + chip.height, `${label} is off-screen`).toBeLessThanOrEqual(650);
  }
});

test("the cap the panel reports is the one /api/me actually hands it", async ({ page }) => {
  // The test above drives the signal, so on its own it would pass with the API
  // never consulted. This is the other half.
  //
  // Asserted against the value FETCHED IN THE TEST, not against a hard-coded
  // 3-then-8. The old pair encoded a deploy's flag state as a constant, so when
  // the signed-out branch of /api/me started answering with a cap of its own
  // (S18) the test failed while reporting nothing about the panel — and worse,
  // it would have gone on passing had the constant happened to match. What the
  // panel owes the API is agreement, whatever the API says.
  const apiCap = async () =>
    await page.evaluate(async () => {
      const res = await fetch("/api/me", { credentials: "same-origin" });
      return ((await res.json()) as { plus: { layerCap: number } }).plus.layerCap;
    });

  await openPanel(page);
  await expect(page.locator(".layers-count")).toHaveText(`1 of ${await apiCap()}`);

  await testLogin(page, uniqueSub("layers-cap"));
  await page.waitForSelector(".canvas-host canvas");
  await openPanel(page);
  await expect(page.locator(".layers-count")).toHaveText(`1 of ${await apiCap()}`);

  // CONTROL: the panel is READING the value, not printing a constant that
  // happens to match. Nothing else in this file would fail if it were.
  await setLayerCap(page, 5);
  await expect(page.locator(".layers-count")).toHaveText("1 of 5");
});


test("Duplicate is capped too, and Delete stops at the last layer", async ({ page }) => {
  await openPanel(page);
  // The cap is driven here rather than taken from the deploy's flags: this test
  // is about what Duplicate and Delete do AT a cap, and reading the number off
  // the current configuration made it fail whenever that configuration changed
  // for reasons that have nothing to do with either button.
  await setLayerCap(page, 3);
  await expect(page.getByRole("button", { name: "Delete layer" })).toBeDisabled();
  await addLayers(page, 1);
  await expect(page.getByRole("button", { name: "Delete layer" })).toBeEnabled();

  await page.getByRole("button", { name: "Duplicate layer" }).click();
  await expect(page.locator(".layers-count")).toHaveText("3 of 3");
  await expect(page.getByRole("button", { name: "Duplicate layer" })).toBeDisabled();
});

// ---------------------------------------------------------------------------
// reordering
// ---------------------------------------------------------------------------

test("dragging a row reorders it, and a cancelled drag leaves the order alone", async ({
  page,
}) => {
  await openPanel(page);
  await addLayers(page, 2);
  expect(await rowNames(page)).toEqual(["Layer 3", "Layer 2", "Layer 1"]);

  await dragRow(page, 0, 2);
  expect(await rowNames(page)).toEqual(["Layer 2", "Layer 1", "Layer 3"]);
  // The model has to have moved with the view — a panel-only reorder would
  // leave the readout pointing at a different layer than the row it highlights.
  await page.locator(".layer-name").last().click();
  expect(await readoutLayer(page)).toBe("L1");

  // THE CONTROL: an identical gesture cancelled with Escape must change nothing.
  await dragRow(page, 0, 2, true);
  expect(await rowNames(page)).toEqual(["Layer 2", "Layer 1", "Layer 3"]);
});

// ---------------------------------------------------------------------------
// undo rules — the engine's, asserted from the UI
// ---------------------------------------------------------------------------

test("reordering a layer is undoable", async ({ page }) => {
  await openPanel(page);
  await addLayers(page, 1);

  await dragRow(page, 0, 1);
  expect(await rowNames(page)).toEqual(["Layer 1", "Layer 2"]);
  await page.keyboard.press("Meta+z");
  expect(await rowNames(page)).toEqual(["Layer 2", "Layer 1"]);
});

test("hiding and renaming a layer do not consume an undo step", async ({ page }) => {
  // "Undo is disabled" on its own is worth nothing — it is disabled at the start
  // of every session. What makes this an assertion is the pair: the two ops that
  // must NOT push a step leave the button alone, and the one that MUST push a
  // step turns it on immediately afterwards.
  const undo = page.getByRole("button", { name: "Undo" });
  await openPanel(page);
  await expect(undo).toBeDisabled();

  await page.getByRole("button", { name: "Hide Layer 1" }).click();
  await expect(page.locator(".layer-row.is-hidden")).toHaveCount(1);
  await expect(undo).toBeDisabled();

  await page.locator(".layer-name").first().dblclick();
  await page.locator(".layer-rename").fill("Ribbons");
  await page.keyboard.press("Enter");
  await expect(page.locator(".layer-name").first()).toHaveText("Ribbons");
  await expect(undo).toBeDisabled();

  // THE CONTROL: an operation that IS undoable enables it on the spot.
  await page.getByRole("button", { name: /^Add layer/ }).click();
  await expect(undo).toBeEnabled();
});

test("an undo after a hide reverts the layer that was added, not the hide", async ({ page }) => {
  // The ordering discriminator, and the reason the test above is not enough on
  // its own: undo pops the MOST RECENT step, so with the non-undoable op first
  // an undo reverts the add either way. Doing the hide LAST is what separates
  // the two worlds — if visibility were an undo step, this undo would restore
  // the eye and leave two layers standing.
  await openPanel(page);
  await setLayerCap(page, 3); // the count, not the cap, is what this test reads
  await page.getByRole("button", { name: /^Add layer/ }).click();
  await expect(page.locator(".layers-count")).toHaveText("2 of 3");
  await page.getByRole("button", { name: "Hide Layer 1" }).click();
  await expect(page.locator(".layer-row.is-hidden")).toHaveCount(1);

  await page.keyboard.press("Meta+z");
  await expect(page.locator(".layers-count")).toHaveText("1 of 3");
});

// ---------------------------------------------------------------------------
// remove-stroke
// ---------------------------------------------------------------------------

/**
 * Two strokes that can be told apart WITHOUT reading engine internals: they sit
 * on different layers with different symmetry, so the confirm capsule's
 * "Stroke on <layer> · <n> images" is a unique identifier for each.
 */
async function twoDistinguishableStrokes(page: Page) {
  const canvas = page.locator(".canvas-host canvas").last();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("canvas not found");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // Stroke A: Layer 1, at the default fold count, mirrored → twice that many
  // images. A short arc up-left.
  await page.mouse.move(cx - 150, cy - 40);
  await page.mouse.down();
  for (let i = 1; i <= 14; i++) await page.mouse.move(cx - 150 + i * 4, cy - 40 - i * 3);
  await page.mouse.up();
  const aAt = { x: cx - 150 + 7 * 4, y: cy - 40 - 7 * 3 };

  // Stroke B: a new layer at 6 segments, mirror off → 6 images. Down-right, and
  // far enough from A that neither arc's images land on the other's probe
  // point — which is what makes "still there / gone" a real discriminator.
  //
  // The COUNT is what matters (6 images, distinct from A's DEFAULT_FOLD * 2),
  // so step down from the default to reach it rather than pressing a fixed
  // number of times — a fixed 6 presses used to land on 6 from a default of 12
  // and now clamps at the 3-segment floor instead.
  const bFold = 6;
  await openPanel(page);
  await page.getByRole("button", { name: /^Add layer/ }).click();
  for (let i = 0; i < DEFAULT_FOLD - bFold; i++) await page.keyboard.press(",");
  await page.keyboard.press("m");
  await expect(page.locator(".layer-line").first()).toHaveText(`${bFold} · C · 100%`);

  await page.mouse.move(cx + 40, cy + 150);
  await page.mouse.down();
  for (let i = 1; i <= 14; i++) await page.mouse.move(cx + 40 + i * 3, cy + 150 + i * 2);
  await page.mouse.up();
  const bAt = { x: cx + 40 + 7 * 3, y: cy + 150 + 7 * 2 };

  return { aAt, bAt };
}

function strokeCount(page: Page) {
  return page
    .locator(".canvas-host")
    .getAttribute("aria-label")
    .then((l) => Number(/(\d+) strokes?/.exec(l ?? "")?.[1] ?? -1));
}

async function armRemove(page: Page) {
  await page.getByRole("button", { name: "Remove stroke" }).click();
  await expect(page.locator(".readout").first()).toContainText("REMOVE STROKE");
}

test("remove-stroke highlights every symmetry image of the tapped stroke", async ({ page }) => {
  await openPanel(page);
  await drawOnCanvas(page, 0, { stable: true });
  await armRemove(page);

  const box = (await page.locator(".canvas-host canvas").last().boundingBox())!;
  await page.mouse.click(box.x + box.width / 2 + Math.sin(4) * 70, box.y + box.height / 2 - 90 + 84);

  // Mirrored, so the image count is TWICE the fold count, and the halo is drawn
  // on every one. A highlight that only marked the tapped image would render
  // exactly 1. Expressed as the relationship rather than a magic 24, so it keeps
  // asserting something real when the default fold count moves.
  const images = DEFAULT_FOLD * 2;
  await expect(page.locator(".remove-highlight g")).toHaveCount(images);
  await expect(page.locator(".remove-capsule")).toContainText(`${images} images`);
});

test("Delete removes the stroke that was tapped, and leaves the other one alone", async ({
  page,
}) => {
  const { aAt, bAt } = await twoDistinguishableStrokes(page);
  expect(await strokeCount(page)).toBe(2);
  await armRemove(page);

  // Identify A by its capsule before touching anything: layer name AND image
  // count, neither of which B shares.
  await page.mouse.click(aAt.x, aAt.y);
  await expect(page.locator(".remove-capsule")).toContainText(
    `Stroke on Layer 1 · ${DEFAULT_FOLD * 2} images`,
  );
  // Tapping a stroke on another layer switches to it and says so.
  await expect(page.locator(".toast-text")).toHaveText("Switched to Layer 1");

  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.locator(".remove-capsule")).toHaveCount(0);
  expect(await strokeCount(page)).toBe(1);

  // NOT just "one fewer": A's location must now be empty and B must still be
  // hittable with its own identity. Deleting the wrong stroke passes the count
  // assertion above and fails both of these.
  await page.mouse.click(aAt.x, aAt.y);
  await expect(page.locator(".remove-miss")).toHaveText("Nothing here");
  await expect(page.locator(".remove-capsule")).toHaveCount(0);

  await page.mouse.click(bAt.x, bAt.y);
  await expect(page.locator(".remove-capsule")).toContainText("Stroke on Layer 2 · 6 images");
});

test("a second tap on the same stroke removes it", async ({ page }) => {
  await drawOnCanvas(page, 0, { stable: true });
  await armRemove(page);
  const box = (await page.locator(".canvas-host canvas").last().boundingBox())!;
  const at = {
    x: box.x + box.width / 2 + Math.sin(4) * 70,
    y: box.y + box.height / 2 - 90 + 84,
  };
  await page.mouse.click(at.x, at.y);
  await expect(page.locator(".remove-capsule")).toBeVisible();
  await page.mouse.click(at.x, at.y);
  await expect(page.locator(".remove-capsule")).toHaveCount(0);
  expect(await strokeCount(page)).toBe(0);
});

test("Escape, Cancel and a tap on empty space all clear the highlight without removing", async ({
  page,
}) => {
  await drawOnCanvas(page, 0, { stable: true });
  await armRemove(page);
  const box = (await page.locator(".canvas-host canvas").last().boundingBox())!;
  const at = {
    x: box.x + box.width / 2 + Math.sin(4) * 70,
    y: box.y + box.height / 2 - 90 + 84,
  };
  // Empty canvas, and clear of every piece of floating chrome: the rail ends
  // at x=72, the top bar at y≈70, the edge sliders and zoom badge live on the
  // right, and the shortcut strip along the bottom. A probe at x+30 lands on
  // the RAIL and never reaches the canvas at all.
  const empty = { x: box.x + box.width * 0.2, y: box.y + box.height * 0.25 };

  for (const dismiss of ["escape", "cancel", "outside"] as const) {
    await page.mouse.click(at.x, at.y);
    await expect(page.locator(".remove-capsule")).toBeVisible();

    if (dismiss === "escape") await page.keyboard.press("Escape");
    else if (dismiss === "cancel") await page.getByRole("button", { name: "Cancel" }).click();
    else await page.mouse.click(empty.x, empty.y);

    await expect(page.locator(".remove-capsule")).toHaveCount(0);
    await expect(page.locator(".remove-highlight")).toHaveCount(0);
    // The stroke is still there — which is the point. `toHaveCount(0)` above is
    // also what a successful DELETE produces, so without this the three
    // dismissals would be indistinguishable from three deletions.
    expect(await strokeCount(page)).toBe(1);
    // Still armed, so the loop can go round again.
    await expect(page.locator(".readout").first()).toContainText("REMOVE STROKE");
  }
});

test("tapping empty space with nothing highlighted says so", async ({ page }) => {
  await drawOnCanvas(page, 0, { stable: true });
  await armRemove(page);
  const box = (await page.locator(".canvas-host canvas").last().boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.25);
  await expect(page.locator(".remove-miss")).toHaveText("Nothing here");
  expect(await strokeCount(page)).toBe(1);
});

test("the remove tool does not draw, and leaving it restores the previous brush", async ({
  page,
}) => {
  // Glow, not the default — so "restored" means something more than "reset".
  await page.getByRole("button", { name: "Glow brush" }).click();
  await expect(page.getByRole("button", { name: "Glow brush" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await armRemove(page);
  // While Remove is armed, no brush is active: two lit tool buttons would be a
  // rail that cannot say what a drag would do.
  await expect(page.getByRole("button", { name: "Glow brush" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );

  await drawOnCanvas(page);
  expect(await strokeCount(page)).toBe(0);

  await page.getByRole("button", { name: "Remove stroke" }).click();
  await expect(page.getByRole("button", { name: "Glow brush" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await drawOnCanvas(page, 1);
  expect(await strokeCount(page)).toBe(1);
});

test("arming remove-stroke does not break wheel zoom", async ({ page }) => {
  // THE CONTROL for how the tap is intercepted. A full-bleed pointer-events
  // catcher over the canvas would also swallow `wheel` and pinch, silently
  // regressing zoom-pan.spec.ts; a capture-phase pointerdown listener does not.
  await drawOnCanvas(page, 0, { stable: true });
  await armRemove(page);
  const box = (await page.locator(".canvas-host canvas").last().boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -240);
  await page.keyboard.up("Control");
  await expect(page.locator(".zoom-badge")).not.toHaveText(/\b100%/);
});

test("a highlight is dropped when an undo shifts the stroke it points at", async ({ page }) => {
  // `StrokeHit.index` is POSITIONAL, and this is the reachable way it goes bad.
  // Delete the older of two strokes, then arm a highlight on the survivor —
  // which has just become index 0 — and undo the delete. The older stroke comes
  // back AT index 0, so the armed hit now names a completely different stroke,
  // and pressing Delete would remove that one while the count still fell by
  // exactly one. Nothing on screen would say anything went wrong.
  //
  // Three rotations, no mirror, and two strokes at clearly different radii: with
  // C_3 every image of a stroke keeps its distance from the centre, so no image
  // of one can land on the other's probe point. Without that, "still hittable"
  // and "hit its neighbour's image" are the same observation.
  const canvas = page.locator(".canvas-host canvas").last();
  const box = (await canvas.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  await openPanel(page);
  for (let i = 0; i < 9; i++) await page.keyboard.press(",");
  await page.keyboard.press("m");
  await expect(page.locator(".layer-line").first()).toHaveText("3 · C · 100%");

  // Inner stroke, r ≈ 70.
  await page.mouse.move(cx + 70, cy - 20);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(cx + 70, cy - 20 + i * 4);
  await page.mouse.up();
  const inner = { x: cx + 70, y: cy - 20 + 5 * 4 };

  // Outer stroke, r ≈ 250.
  await page.mouse.move(cx + 250, cy - 20);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(cx + 250, cy - 20 + i * 4);
  await page.mouse.up();
  const outer = { x: cx + 250, y: cy - 20 + 5 * 4 };

  expect(await strokeCount(page)).toBe(2);
  await armRemove(page);

  // Remove the INNER (index 0) one, so the outer slides down into index 0.
  await page.mouse.click(inner.x, inner.y);
  await expect(page.locator(".remove-capsule")).toBeVisible();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  expect(await strokeCount(page)).toBe(1);

  // Arm a highlight on the outer stroke — now index 0.
  await page.mouse.click(outer.x, outer.y);
  await expect(page.locator(".remove-capsule")).toBeVisible();

  // …and put the inner stroke back at index 0 underneath it.
  await page.keyboard.press("Meta+z");
  expect(await strokeCount(page)).toBe(2);

  // The highlight must be GONE. Both strokes are still in range, so nothing
  // else would have caught this: without the guard the capsule stays up, still
  // says "1 images", and its Delete removes the inner stroke instead.
  await expect(page.locator(".remove-capsule")).toHaveCount(0);
  await expect(page.locator(".remove-highlight")).toHaveCount(0);

  // Both strokes survived, and re-tapping the outer one arms it again.
  await page.mouse.click(outer.x, outer.y);
  await expect(page.locator(".remove-capsule")).toBeVisible();
  expect(await strokeCount(page)).toBe(2);
});

test("every halo image is drawn where the engine actually finds the stroke", async ({ page }) => {
  // Counting `.remove-highlight g` and reading the capsule prove the right
  // NUMBER of images and the right stroke identity. Neither says the transform
  // puts those images in the right PLACES — and the 12·D screenshot cannot
  // show it either, because there every image lands on some other image's ink
  // and a wrong highlight still looks like a mandala.
  //
  // So: probe the canvas AT each halo image's own centre and require the
  // engine's hit-test to come back with this same stroke. That ties the SVG
  // geometry to the ink rather than to itself. Escape between probes, because
  // a second tap on an already-armed stroke is the delete gesture.
  //
  // D_3 (6 images) rather than a cyclic group, because dropping the mirror
  // composition is the mutation that positions can actually detect: any cyclic
  // image set is closed under inverse, so a globally negated rotation maps the
  // set onto itself and NO position-based assertion can see it. That one is
  // covered by symmetry.test.ts, which pins `transformPoint` directly.
  const canvas = page.locator(".canvas-host canvas").last();
  const box = (await canvas.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  await openPanel(page);
  for (let i = 0; i < 9; i++) await page.keyboard.press(",");
  await expect(page.locator(".layer-line").first()).toHaveText("3 · D · 100%");

  // A short, straight, off-axis stroke: straight so its bounding-box centre is
  // genuinely ON the ink, off-axis so no image coincides with another.
  await page.mouse.move(cx + 170, cy - 60);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(cx + 170, cy - 60 + i * 5);
  await page.mouse.up();
  const tap = { x: cx + 170, y: cy - 60 + 5 * 5 };

  await armRemove(page);
  await page.mouse.click(tap.x, tap.y);
  await expect(page.locator(".remove-capsule")).toContainText("6 images");

  const read = () =>
    page.locator(".remove-halo").evaluateAll((els) =>
      els.map((e) => {
        const r = e.getBoundingClientRect();
        return [r.left + r.width / 2, r.top + r.height / 2] as [number, number];
      }),
    );

  // Six DISTINCT places. Dropping `scale(1,-1)` from the image transform makes
  // each mirrored image render on top of its rotational twin: still six paths,
  // still all sitting on ink, but only three positions.
  const atRest = await read();
  expect(atRest).toHaveLength(6);
  const distinct = new Set(atRest.map(([x, y]) => `${Math.round(x / 8)},${Math.round(y / 8)}`));
  expect(distinct.size, `halo images overlap: ${JSON.stringify(atRest)}`).toBe(6);

  // ZOOM WITH THE HIGHLIGHT UP, so the geometry is then read at a NON-IDENTITY
  // view. At scale 1 / pan 0 the view transform IS the identity, so dropping
  // `drawingToScreen` entirely changes nothing and that whole step goes
  // unasserted — as it was until this. Zooming also exercises the rAF follow
  // loop, since a pan or zoom never touches a signal the component subscribes
  // to.
  // OFF-CENTRE anchor, and that is the whole point of the coordinates. A
  // ctrl+wheel pins the drawing point under the cursor, so zooming AT the centre
  // leaves the centre exactly where it was — `drawingToScreen(view, w/2, h/2)`
  // then returns w/2, h/2, identical to having no view transform at all, and
  // dropping that step goes undetected. Anchoring away from the centre is what
  // makes tx/ty actually move the origin.
  //
  // And a GENTLE zoom: at 272% four of the six images are already off the
  // viewport and at 739% all six are, which would leave the probe loop below
  // with nothing to check.
  await page.mouse.move(cx - 150, cy + 100);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -30);
  await page.keyboard.up("Control");
  await expect(page.locator(".zoom-badge")).not.toHaveText(/\b100%/);
  await expect(page.locator(".remove-capsule")).toBeVisible();

  const onScreen = (await read()).filter(
    ([x, y]) =>
      x > box.x + 90 && x < box.x + box.width - 90 && y > box.y + 80 && y < box.y + box.height - 80,
  );
  expect(onScreen, "halo images left the viewport — lower the zoom").toHaveLength(6);

  for (const [x, y] of onScreen) {
    await page.keyboard.press("Escape");
    await expect(page.locator(".remove-capsule")).toHaveCount(0);
    await page.mouse.click(x, y);
    await expect(
      page.locator(".remove-capsule"),
      `no stroke under the halo image at ${Math.round(x)},${Math.round(y)}`,
    ).toContainText("Stroke on Layer 1 · 6 images");
  }
});

// ---------------------------------------------------------------------------
// per-layer opacity (T16)
//
// `setLayerOpacity` existed in the engine, pinned by unit tests, with NOTHING
// calling it: every layer sat at 1 forever while the row printed a percentage
// that could only ever read 100%. These tests are about the control that closes
// that gap, and two of them are written specifically to fail on the mistakes
// that make it LOOK finished:
//
//  * "the value changed after a drag" passes with coalescing completely broken,
//    with the gesture never sealed, and with the drag emitting one event. So the
//    undo test drags TWICE and pins the depth from both ends: one undo must land
//    on the first drag's value (not the original — that is the seal), and the
//    second must exhaust the stack (that is the coalescing).
//  * "the percentage changed" says nothing about the picture. Opacity is
//    composited, so the ink itself has to change — asserted against the art
//    canvas, with the same-render-twice control that makes a difference mean
//    something.
// ---------------------------------------------------------------------------

const opacityRange = (page: Page) => page.locator(".layer-opacity-range");

async function openOpacity(page: Page, nth = 0): Promise<void> {
  await page.locator(".layer-opacity").nth(nth).click();
  await expect(opacityRange(page)).toBeVisible();
  // Disclosing a control and leaving the keyboard behind on the trigger is the
  // same as not disclosing it, so every opening asserts where focus landed.
  await expect(opacityRange(page)).toBeFocused();
}

/** The percentage the row is showing, as a number. */
async function rowPercent(page: Page, nth = 0): Promise<number> {
  const t = (await page.locator(".layer-opacity").nth(nth).textContent()) ?? "";
  return Number(t.replace("%", ""));
}

/**
 * Drag the open slider's thumb to a fraction of its track, in many small steps.
 *
 * The step count is load-bearing: a single jump would be ONE `input` event, and
 * a one-event "drag" is one undo entry whether the code coalesces or not — the
 * test would then pass with the feature's hardest part deleted.
 */
async function dragOpacityTo(page: Page, frac: number): Promise<void> {
  const box = (await opacityRange(page).boundingBox())!;
  const y = box.y + box.height / 2;
  // Inset by roughly half a thumb, which is where Chromium puts value 0 and 100.
  const x = (f: number) => box.x + 8 + (box.width - 16) * f;
  await page.mouse.move(x((await rowPercent(page)) / 100), y);
  await page.mouse.down();
  await page.mouse.move(x(frac), y, { steps: 24 });
  await page.mouse.up();
}

/** The committed art canvas (grid / art / live — the middle one). */
function artPixels(page: Page): Promise<string> {
  return page.evaluate(() => {
    const host = document.querySelector(".canvas-host")!;
    const art = host.querySelectorAll("canvas")[1] as HTMLCanvasElement;
    return art.toDataURL("image/png");
  });
}

test("the row's percentage is a control: it discloses a slider that sets that layer", async ({
  page,
}) => {
  await openPanel(page);
  await addLayers(page, 1);

  // Closed, the row is exactly the line the frames draw.
  await expect(page.locator(".layer-line").first()).toHaveText(`${DEFAULT_FOLD} · D · 100%`);
  await expect(opacityRange(page)).toHaveCount(0);

  await openOpacity(page, 0);
  // One slider, for the row that asked for it — not one per row.
  await expect(opacityRange(page)).toHaveCount(1);
  await dragOpacityTo(page, 0.4);

  const pct = await rowPercent(page, 0);
  expect(pct, "the drag must move the value off 100").toBeLessThan(70);
  expect(pct).toBeGreaterThan(10);
  // The line still composes, with the new number in it.
  await expect(page.locator(".layer-line").first()).toHaveText(`${DEFAULT_FOLD} · D · ${pct}%`);

  // THE CONTROL: the OTHER layer is untouched. A control wired to the active
  // layer instead of to its own row would pass every assertion above.
  expect(await rowPercent(page, 1)).toBe(100);
});

test("a whole drag is ONE undo entry, and undo restores the value it started at", async ({
  page,
}) => {
  const undo = page.getByRole("button", { name: "Undo" }).first();
  // The baseline is VERIFIED, not assumed: every claim below is a delta from an
  // empty history, so "+1 per drag" is what is actually being asserted.
  await expect(undo).toBeDisabled();

  await openPanel(page);
  await openOpacity(page);

  await dragOpacityTo(page, 0.6);
  const afterFirst = await rowPercent(page);
  expect(afterFirst).toBeLessThan(100);

  await dragOpacityTo(page, 0.2);
  const afterSecond = await rowPercent(page);
  expect(afterSecond, "the second drag must land somewhere else").toBeLessThan(afterFirst);

  // Two drags, two entries — pinned from BOTH ends.
  await expect(undo).toBeEnabled();
  await undo.click();
  // Not 100: if the gesture were never sealed, both drags would have collapsed
  // into a single entry and this would already be back at the original value.
  await expect(page.locator(".layer-opacity").first()).toHaveText(`${afterFirst}%`);
  await expect(undo).toBeEnabled();

  await undo.click();
  await expect(page.locator(".layer-opacity").first()).toHaveText("100%");
  // And nothing else: without coalescing a 24-step drag leaves a couple of dozen
  // entries here, and this is the assertion that sees them.
  await expect(undo).toBeDisabled();
});

test("each arrow key is its own undo step, and Escape returns focus to the row", async ({
  page,
}) => {
  const undo = page.getByRole("button", { name: "Undo" }).first();
  await openPanel(page);

  // Keyboard the whole way in: focus the disclosure and open it with Enter.
  await page.locator(".layer-opacity").first().focus();
  await page.keyboard.press("Enter");
  await expect(opacityRange(page)).toBeFocused();

  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowLeft");
  expect(await rowPercent(page)).toBe(97);

  // Three presses, three entries: the seal hangs off key-UP, so discrete presses
  // stay discrete while a HELD key (one keydown stream, one keyup) is one step.
  for (const expected of [98, 99, 100]) {
    await undo.click();
    expect(await rowPercent(page)).toBe(expected);
  }
  await expect(undo).toBeDisabled();

  await opacityRange(page).focus();
  await page.keyboard.press("Escape");
  await expect(opacityRange(page)).toHaveCount(0);
  // Escape leaves the SLIDER, not the panel — and puts focus back where it came
  // from, or a keyboard user is dropped at the top of the document.
  await expect(page.locator(".layers-panel")).toHaveCount(1);
  await expect(page.locator(".layer-opacity").first()).toBeFocused();
});

test("lowering a layer's opacity changes the pixels, and 100% restores them exactly", async ({
  page,
}) => {
  await drawOnCanvas(page);
  expect(await strokeCount(page), "an empty canvas would compare equal forever").toBe(1);

  const before = await artPixels(page);
  // THE CONTROL: the same drawing, read twice, is identical — so a difference
  // below is a difference in the render and not in the observable.
  expect(await artPixels(page)).toBe(before);
  expect(before.length).toBeGreaterThan(2000);

  await openPanel(page);
  await openOpacity(page);
  // PageDown moves a 0–100 range by ten, so this is an exact 40% — no reliance
  // on where a drag happens to land.
  for (let i = 0; i < 6; i++) await page.keyboard.press("PageDown");
  expect(await rowPercent(page)).toBe(40);

  const faded = await artPixels(page);
  expect(faded, "a layer at 40% must not paint the same as one at 100%").not.toBe(before);

  // Back to full: the composite is off again and the pixels are the ones every
  // stored piece was rasterized from. (The bypass ITSELF is pinned by
  // test/unit/render-trace.test.ts and v1-render.spec.ts; this is the round trip
  // through the control.)
  await page.keyboard.press("End");
  expect(await rowPercent(page)).toBe(100);
  expect(await artPixels(page)).toBe(before);
});

test("opening a reorder drag closes the slider", async ({ page }) => {
  // The reorder maths reads one row height and applies it to every row, so a row
  // 44px taller than its neighbours drops on the wrong index. Asserted because
  // the failure is silent: the drag still works, it just lands one row off.
  await openPanel(page);
  await addLayers(page, 2);
  // The slider is opened on the row that is about to be DRAGGED, which is the
  // case the pitch measurement gets wrong: that row is the tall one.
  await openOpacity(page, 2);

  await dragRow(page, 2, 0);
  await expect(opacityRange(page)).toHaveCount(0);
  expect(await rowNames(page)).toEqual(["Layer 1", "Layer 3", "Layer 2"]);
});

// ---------------------------------------------------------------------------
// phone
// ---------------------------------------------------------------------------

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("the panel is a bottom sheet that stays clear of the drawing's centre", async ({ page }) => {
    await openPanel(page);
    const box = (await page.locator(".layers-panel").boundingBox())!;
    expect(box.x).toBe(0);
    expect(box.width).toBe(390);
    // DESIGN.md §2's one hard rule: no panel covers the drawing's centre.
    expect(box.y).toBeGreaterThan(844 / 2);
    expect(box.height).toBeLessThanOrEqual(844 * 0.45);
  });

  test("a tap outside the sheet closes it and does NOT land a stroke", async ({ page }) => {
    // The sheet covers the dock AND the strip — i.e. both controls that open
    // it — so a scrim is the only way back out. Without one the panel is
    // unclosable and the dismissing tap draws on the canvas instead.
    //
    // This is also the regression guard for a CSS ordering trap that shipped
    // once: `.layers-scrim`'s base `display: none` was written AFTER the media
    // query that turns it on, so at equal specificity the `none` won at every
    // width and the scrim silently never rendered. Nothing about the desktop
    // layout changes when that happens, which is why it needs a phone test.
    await openPanel(page);
    expect(await strokeCount(page)).toBe(0);

    await page.mouse.click(195, 200);
    await expect(page.locator(".layers-panel")).toHaveCount(0);
    expect(await strokeCount(page)).toBe(0);
  });

  test("remove-stroke works from the dock, with the capsule on screen", async ({ page }) => {
    // The phone branch renders its OWN copy of the panel and the overlay, and
    // nothing else here exercises the tool at this width. The capsule is
    // position:fixed and anchored to the tap, so on a 390px viewport it is the
    // one that can most easily be clamped off-screen.
    await drawOnCanvas(page, 0, { stable: true });
    expect(await strokeCount(page)).toBe(1);

    await page.locator(".dock").getByRole("button", { name: "Remove stroke" }).click();
    const box = (await page.locator(".canvas-host canvas").last().boundingBox())!;
    await page.mouse.click(
      box.x + box.width / 2 + Math.sin(4) * 70,
      box.y + box.height / 2 - 90 + 84,
    );

    const capsule = page.locator(".remove-capsule");
    await expect(capsule).toBeVisible();
    const cb = (await capsule.boundingBox())!;
    expect(cb.x, "capsule pushed off the left edge").toBeGreaterThanOrEqual(0);
    expect(cb.x + cb.width, "capsule pushed off the right edge").toBeLessThanOrEqual(390);

    await page.getByRole("button", { name: "Delete", exact: true }).click();
    expect(await strokeCount(page)).toBe(0);
  });

  test("the strip chip and the dock button open the same one panel", async ({ page }) => {
    const dockBtn = page.locator(".dock").getByRole("button", { name: LAYERS_BTN });
    const stripChip = page.locator(".strip").getByRole("button", { name: LAYERS_BTN });
    await stripChip.click();
    await expect(page.locator(".layers-panel")).toHaveCount(1);
    await page.mouse.click(195, 200);
    await expect(page.locator(".layers-panel")).toHaveCount(0);
    await dockBtn.click();
    await expect(page.locator(".layers-panel")).toHaveCount(1);
  });
});

// ---------------------------------------------------------------------------
// accessibility
// ---------------------------------------------------------------------------

test("the open panel has no axe violations (light only)", async ({ page }) => {
  await openPanel(page);
  await addLayers(page, 2);
  // With a slider disclosed: it is a control that only exists in one state, so
  // scanning the panel closed would never see its name, its role or its value.
  await openOpacity(page, 1);
  await expect(opacityRange(page)).toHaveCount(1);
  const results = await new AxeBuilder({ page }).include(".layers-panel").analyze();
  expect(results.violations).toEqual([]);
});

test("every standalone panel control owns at least 44px, measured by hit-test", async ({
  page,
}) => {
  await openPanel(page);
  await addLayers(page, 2);

  // DEVIATION FROM DESIGN.md §2's "every touch target ≥ 44px", forced by the
  // design itself: a row is grip · thumbnail · NAME OVER A SYM LINE · eye, and
  // the frames draw that whole row about 46px tall. Two stacked controls cannot
  // both be 44px inside 46px — honouring the rule literally would double the
  // row height and put a three-layer panel past the frame's proportions. So the
  // ROW carries the 44px and the name/sym pair are affordances inside it.
  for (const row of await page.locator(".layer-row").all()) {
    expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }

  // Everything that IS a standalone target is measured with `elementFromPoint`
  // walked out from its centre, not by its bounding box. A painted box says
  // nothing about what a finger actually lands on: a neighbour that overlaps
  // wins the overlap, which is how a row of swatches held a ~32px real target
  // while the box and the stylesheet both read 44 (see mobile.spec.ts).
  const targets: Array<[string, number]> = [
    [".layer-grip", 3],
    [".layer-eye", 3],
    [".layer-foot .chip", 3],
  ];
  // The opacity slider is a standalone control the moment it exists, so it is
  // measured too — with the row's own 44px no longer able to stand in for it,
  // since it is a second line INSIDE that row rather than an affordance on it.
  await openOpacity(page, 0);
  const slider = await exclusiveTarget(page, ".layer-opacity-range");
  expect(slider.height, "opacity slider effective height").toBeGreaterThanOrEqual(44);
  await page.locator(".layer-opacity").first().click();
  await expect(page.locator(".layer-opacity-range")).toHaveCount(0);

  for (const [selector, count] of targets) {
    await expect(page.locator(selector)).toHaveCount(count);
    for (let i = 0; i < count; i++) {
      const t = await exclusiveTarget(page, selector, i);
      expect(t.height, `${selector}[${i}] effective height`).toBeGreaterThanOrEqual(44);
      // The grip is a deliberately narrow column, so only height is a target
      // claim there; the eye and the chips must own both axes.
      if (selector !== ".layer-grip") {
        expect(t.width, `${selector}[${i}] effective width`).toBeGreaterThanOrEqual(24);
      }
    }
  }
});

test("E arms the remove tool and L toggles the panel, and both actually work", async ({ page }) => {
  // The strip advertises these two, so they have to DO something — asserting
  // that the strip lists them (mobile.spec.ts) would pass with both handlers
  // deleted. Both directions each, since a toggle that only ever turns on is
  // half a shortcut.
  await expect(page.locator(".layers-panel")).toHaveCount(0);
  await page.keyboard.press("l");
  await expect(page.locator(".layers-panel")).toHaveCount(1);
  await page.keyboard.press("l");
  await expect(page.locator(".layers-panel")).toHaveCount(0);

  const readout = page.locator(".readout").first();
  await expect(readout).not.toContainText("REMOVE STROKE");
  await page.keyboard.press("e");
  await expect(readout).toContainText("REMOVE STROKE");
  await expect(page.getByRole("button", { name: "Remove stroke" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  // Armed by keyboard, the tool really is armed: a drag draws nothing.
  await drawOnCanvas(page);
  expect(await strokeCount(page)).toBe(0);

  await page.keyboard.press("e");
  await expect(readout).not.toContainText("REMOVE STROKE");
  await drawOnCanvas(page, 1);
  expect(await strokeCount(page)).toBe(1);
});

test("typing a layer name does not fire the shortcuts inside it", async ({ page }) => {
  // Renaming a layer to "Everest" must not arm the eraser on the E, nor toggle
  // the panel on the two Es... or rather on the L in "Malachite". Two guards
  // stand between: `isTypingTarget` at the top of App's handler, and the rename
  // input's own `stopPropagation`.
  //
  // `pressSequentially`, NOT `fill`: fill sets the value directly and dispatches
  // no key events at all, so the test would pass with every guard deleted. That
  // is precisely what it did until a mutation caught it.
  await openPanel(page);
  await page.locator(".layer-name").first().dblclick();

  // Wait for the old name to actually BE selected before typing. `autoFocus`
  // fires the focus (and so the select) on Preact's schedule, not Playwright's,
  // and `pressSequentially` does not wait for it — start a character early and
  // it lands beside an unselected name instead of replacing it, which showed up
  // as this test passing alone and failing in a full run.
  // This also keeps the select-on-focus behaviour asserted rather than
  // sidestepped: poll for the selection instead of forcing one.
  const rename = page.locator(".layer-rename");
  await expect
    .poll(() =>
      rename.evaluate((el) => {
        const i = el as HTMLInputElement;
        return (i.selectionEnd ?? 0) - (i.selectionStart ?? 0);
      }),
    )
    .toBe("Layer 1".length);

  await rename.pressSequentially("Everest Lake", { delay: 5 });

  await expect(page.locator(".readout").first()).not.toContainText("REMOVE STROKE");
  await expect(page.locator(".layers-panel")).toHaveCount(1);

  await page.keyboard.press("Enter");
  await expect(page.locator(".layer-name").first()).toHaveText("Everest Lake");
});

// S14. The footnote's "Kaleidoscope Plus" link is gated on the Plus SURFACE,
// because `PlusSheet` refuses to render without it — an ungated link is a
// button that visibly does nothing, and the user at the cap is exactly who
// clicks it. Reachable today: `/api/me` degrades to a plus block with the
// surface off when CAP_EPOCH is malformed, and the free layer cap still applies.
test("the cap footnote offers Plus only when the surface is on", async ({ page }) => {
  await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const S = await load("/src/client/state.ts");
    S.plus.value = { active: false, sources: [], publicCount: 0, publicCap: null,
                     layerCap: 3, enabled: false, surface: true };
  });
  await openPanel(page);
  await setLayerCap(page, 3);
  await addLayers(page, 2);

  await expect(page.locator(".layer-note")).toHaveText(
    "Layers: 3 of 3 · Kaleidoscope Plus unlocks 8",
  );
  await expect(page.locator(".layer-note .link-inline")).toBeEnabled();
});

// REVIEW.md S13 — WCAG 2.1.1. The grip was a focusable role="button" with no
// key handler at all, so layer order could only be changed with a mouse.
// PLAN T06c required keyboard reordering explicitly.
test("layer rows reorder from the keyboard", async ({ page }) => {
  await openPanel(page);
  await addLayers(page, 2); // three layers: display order is top-first

  const names = () => page.locator(".layer-row .layer-name").allTextContents();
  const before = await names();
  expect(before).toHaveLength(3);

  // Focus the TOP row's grip and send it down one.
  await page.locator(".layer-row").first().locator(".layer-grip").focus();
  await page.keyboard.press("ArrowDown");

  const after = await names();
  expect(after, "the top layer should have swapped with the one below it").toEqual([
    before[1], before[0], before[2],
  ]);

  // Focus follows the row, so a second press continues rather than dropping.
  await page.keyboard.press("ArrowDown");
  expect(await names()).toEqual([before[1], before[2], before[0]]);

  // And it stops at the end instead of wrapping or throwing.
  await page.keyboard.press("ArrowDown");
  expect(await names()).toEqual([before[1], before[2], before[0]]);
});
