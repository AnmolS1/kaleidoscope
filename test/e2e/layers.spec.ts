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

test("a row shows its own name, symmetry, mirror and opacity", async ({ page }) => {
  await openPanel(page);
  const row = page.locator(".layer-row").first();
  await expect(row.locator(".layer-name")).toHaveText("Layer 1");
  await expect(row.locator(".layer-sym")).toHaveText("12 · D · 100%");

  // The line tracks the layer, not a global: change segments and drop mirror.
  await page.keyboard.press(",");
  await page.keyboard.press("m");
  await expect(row.locator(".layer-sym")).toHaveText("11 · C · 100%");
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

test("Add locks at the free cap of 3, is unlocked at 3 of 8, and locks again at 8", async ({
  page,
}) => {
  await openPanel(page);
  const add = page.getByRole("button", { name: /^Add layer/ });

  // --- free (signed out): cap 3 ---
  await expect(page.locator(".layers-count")).toHaveText("1 of 3");
  await expect(add).toBeEnabled();
  await expect(page.locator(".layer-note")).toHaveCount(0);

  await addLayers(page, 2);
  await expect(page.locator(".layers-count")).toHaveText("3 of 3");
  await expect(add).toBeDisabled();
  await expect(page.locator(".layer-note")).toHaveText(
    "Layers: 3 of 3 · Kaleidoscope Plus unlocks 8",
  );
  // The way out is a real control, not decoration. T08 builds the sheet; all
  // that can be asserted here is that the link exists and is clickable.
  await expect(page.locator(".layer-note .link-inline")).toBeEnabled();
  await page.locator(".layer-note .link-inline").click();

  // --- THE CONTROL: cap 8 with only 3 layers must be UNLOCKED ---
  // Without this case, "disabled at 3 of 3" and "disabled at 8 of 8" are both
  // satisfied by an Add button that is simply always disabled.
  await testLogin(page, uniqueSub("layers-cap"));
  await page.waitForSelector(".canvas-host canvas");
  await openPanel(page);
  await expect(page.locator(".layers-count")).toHaveText("1 of 8");
  await expect(add).toBeEnabled();
  await addLayers(page, 2);
  await expect(page.locator(".layers-count")).toHaveText("3 of 8");
  await expect(add).toBeEnabled();
  await expect(page.locator(".layer-note")).toHaveCount(0);

  // --- Plus: cap 8, and a different footnote with no upsell ---
  await addLayers(page, 5);
  await expect(page.locator(".layers-count")).toHaveText("8 of 8");
  await expect(add).toBeDisabled();
  await expect(page.locator(".layer-note")).toHaveText("All 8 layers in use");
  await expect(page.locator(".layer-note .link-inline")).toHaveCount(0);
});

test("Duplicate is capped too, and Delete stops at the last layer", async ({ page }) => {
  await openPanel(page);
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

  // Stroke A: Layer 1, 12 segments mirrored → 24 images. A short arc up-left.
  await page.mouse.move(cx - 150, cy - 40);
  await page.mouse.down();
  for (let i = 1; i <= 14; i++) await page.mouse.move(cx - 150 + i * 4, cy - 40 - i * 3);
  await page.mouse.up();
  const aAt = { x: cx - 150 + 7 * 4, y: cy - 40 - 7 * 3 };

  // Stroke B: a new layer at 6 segments, mirror off → 6 images. Down-right, and
  // far enough from A that neither arc's images land on the other's probe
  // point — which is what makes "still there / gone" a real discriminator.
  await openPanel(page);
  await page.getByRole("button", { name: /^Add layer/ }).click();
  for (let i = 0; i < 6; i++) await page.keyboard.press(",");
  await page.keyboard.press("m");
  await expect(page.locator(".layer-sym").first()).toHaveText("6 · C · 100%");

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

  // 12 segments mirrored = 24 images, and the halo is drawn on every one. A
  // highlight that only marked the tapped image would render exactly 1.
  await expect(page.locator(".remove-highlight g")).toHaveCount(24);
  await expect(page.locator(".remove-capsule")).toContainText("24 images");
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
  await expect(page.locator(".remove-capsule")).toContainText("Stroke on Layer 1 · 24 images");
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
  await expect(page.locator(".layer-sym").first()).toHaveText("3 · C · 100%");

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

// ---------------------------------------------------------------------------
// the hidden-layer refusal
// ---------------------------------------------------------------------------

test("drawing on a hidden layer is refused, named in the toast, and never auto-unhidden", async ({
  page,
}) => {
  await openPanel(page);
  await page.locator(".layer-name").first().dblclick();
  await page.locator(".layer-rename").fill("Highlights");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Hide Highlights" }).click();

  await drawOnCanvas(page);
  expect(await strokeCount(page)).toBe(0);
  await expect(page.locator(".toast-text")).toHaveText(
    "“Highlights” is hidden, so nothing was drawn.",
  );
  // Still hidden. The refusal is the whole design — a layer that quietly
  // un-hides itself would make the toast a lie.
  await expect(page.locator(".layer-row.is-hidden")).toHaveCount(1);

  await page.getByRole("button", { name: "Show layer" }).click();
  await expect(page.locator(".layer-row.is-hidden")).toHaveCount(0);
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
  const results = await new AxeBuilder({ page }).include(".layers-panel").analyze();
  expect(results.violations).toEqual([]);
});

test("every standalone panel control is at least 44px, and every row is too", async ({ page }) => {
  await openPanel(page);
  await addLayers(page, 2);

  // DEVIATION FROM DESIGN.md §2's "every touch target ≥ 44px", forced by the
  // design itself: a row is grip · thumbnail · NAME OVER A SYM LINE · eye, and
  // the frames draw that whole row about 46px tall. Two stacked controls cannot
  // both be 44px inside 46px — honouring the rule literally would double the
  // row height and put a three-layer panel past the frame's proportions.
  //
  // So the ROW carries the 44px, and the name/sym pair are two affordances
  // inside it. Everything that is a standalone target — grip, eye, footer
  // chips — is held to the full 44.
  for (const box of await page.locator(".layer-row").all()) {
    expect((await box.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }

  const targets = page.locator(".layer-grip, .layer-eye, .layer-foot .chip");
  const n = await targets.count();
  expect(n).toBe(3 * 2 + 3); // grip + eye per row, plus Add / Duplicate / Delete
  for (let i = 0; i < n; i++) {
    const box = await targets.nth(i).boundingBox();
    expect(box, `target ${i} has no box`).not.toBeNull();
    expect(box!.height, `target ${i} height`).toBeGreaterThanOrEqual(44);
  }
});
