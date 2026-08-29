import { test, expect, type Page } from "@playwright/test";

// The symmetry dial (DESIGN.md §3). What makes these assertions rather than
// decoration: a dial that only proved "the value changed" would pass with the
// angle negated, the sweep offset dropped, or the whole mapping rotated — every
// one of those still changes the value when you drag. So the drag targets are
// COORDINATES COPIED OFF THE ARTBOARD (`kaleidoscope-plan/design/src/Dial.dc.html`),
// each asserting one exact segment count, and the handle's rendered position is
// read back out of the DOM. Forward and inverse have to agree, at points this
// file did not derive from the code.
//
// The four targets sit mid-bucket (±7.14°, ~10px of arc slack), NOT at the top
// of the ring: the top is exactly 13.5, the boundary between two buckets, where
// a sub-pixel rounding difference flips the answer.

/** Outer tick ends at r=80, in viewBox units, straight from the artboard. */
const ARTBOARD: Record<number, [number, number]> = {
  3: [-40.0, 69.3],
  6: [-76.4, 23.6],
  12: [-29.2, -74.5],
  15: [29.2, -74.5],
  24: [40.0, 69.3],
};

async function openDial(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("toolbar", { name: "Drawing tools" })).toBeVisible();
  await page.locator('.rail summary[aria-label^="Symmetry settings"]').click();
  await expect(page.locator(".pop-sym .dial-svg")).toBeVisible();
  // The dial is drawn in IBM Plex Mono at 10px and the label-clearance check
  // below is decided by roughly a pixel, so let the face actually arrive.
  await page.evaluate(() => document.fonts.ready);
}

/**
 * Page coordinates of the dial centre, and viewBox units → CSS px.
 *
 * Waits for the box to stop moving first. The popover opens with a 4px rise,
 * so a frame measured the instant it becomes visible is ~3px above where the
 * dial ends up — and every position assertion built on it then fails by three
 * pixels, blaming the dial for the popover's entrance.
 */
async function frame(page: Page): Promise<{ cx: number; cy: number; k: number }> {
  const read = async () => {
    const b = await page.locator(".dial-svg").boundingBox();
    if (!b) throw new Error("dial not laid out");
    return b;
  };
  let prev = await read();
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(30);
    const next = await read();
    if (Math.abs(next.x - prev.x) < 0.05 && Math.abs(next.y - prev.y) < 0.05) {
      return { cx: next.x + next.width / 2, cy: next.y + next.height / 2, k: next.width / 220 };
    }
    prev = next;
  }
  throw new Error("the popover never settled");
}

async function segments(page: Page): Promise<number> {
  return Number(await page.locator(".pop-sym .dial-range").inputValue());
}

/** Where the handle actually is on screen, in page coordinates. */
async function knobCentre(page: Page): Promise<{ x: number; y: number }> {
  const b = await page.locator(".dial-knob").boundingBox();
  if (!b) throw new Error("no handle");
  // The box is the element's bbox rotated into screen space, so its WIDTH is
  // angle-dependent and excludes the stroke — but its centre is the circle's
  // centre at any angle, which is the only thing read here.
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/**
 * The handle's position once it has stopped moving.
 *
 * The handle SWEEPS to a new angle over 180ms, so a single sample taken right
 * after a write catches it in flight and reports the wrong place for a dial
 * that is entirely correct.
 */
async function settledKnob(page: Page): Promise<{ x: number; y: number }> {
  let prev = await knobCentre(page);
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(30);
    const next = await knobCentre(page);
    if (Math.hypot(next.x - prev.x, next.y - prev.y) < 0.05) return next;
    prev = next;
  }
  throw new Error("the handle never stopped moving");
}

test("the artboard's own tick positions each read back as their exact count", async ({ page }) => {
  await openDial(page);
  const { cx, cy, k } = await frame(page);

  // Every count is asserted from a position this test did not compute. A
  // mapping that is negated, offset or rotated cannot satisfy all five.
  for (const [value, [x, y]] of Object.entries(ARTBOARD)) {
    await page.mouse.click(cx + x * k, cy + y * k);
    expect(await segments(page), `clicking the ${value} tick`).toBe(Number(value));
  }
});

test("dragging the ring walks the counts in order and lands on the right one", async ({ page }) => {
  await openDial(page);
  const { cx, cy, k } = await frame(page);

  // Along the ring from 3 (−240°) to 15 (−68.57°), sampled every ~14°.
  const from = -240;
  const to = -240 + ((15 - 3) / 21) * 300;
  const at = (deg: number) => {
    const a = (deg * Math.PI) / 180;
    return { x: cx + 80 * Math.cos(a) * k, y: cy + 80 * Math.sin(a) * k };
  };

  const start = at(from);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  expect(await segments(page), "the press itself sets the count").toBe(3);

  const seen: number[] = [3];
  for (let i = 1; i <= 12; i++) {
    const p = at(from + ((to - from) * i) / 12);
    await page.mouse.move(p.x, p.y);
    seen.push(await segments(page));
  }
  await page.mouse.up();

  expect(await segments(page), "the drag ends on 15").toBe(15);
  // A tick per step: the count climbs through the intermediate values rather
  // than snapping from one end to the other.
  expect(seen[seen.length - 1]).toBe(15);
  for (let i = 1; i < seen.length; i++) {
    expect(Number.isInteger(seen[i]), `integer at sample ${i}`).toBe(true);
    expect(seen[i], `no backtrack at sample ${i}`).toBeGreaterThanOrEqual(seen[i - 1]);
    expect(seen[i]).toBeGreaterThanOrEqual(3);
    expect(seen[i]).toBeLessThanOrEqual(24);
  }
  expect(new Set(seen).size, "distinct counts passed through").toBeGreaterThanOrEqual(6);
});

test.describe("touch", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  // The mouse never exercises `touch-action: none` or the pointer capture, and
  // the phone sheet + iPad popover are where this control mostly lives.
  test("a finger drag on the ring works, and does not scroll the sheet", async ({ page }) => {
    await page.goto("/");
    await page.locator('.strip summary[aria-label^="Symmetry settings"]').click();
    await expect(page.locator(".pop-sym .dial-svg")).toBeVisible();
    const { cx, cy, k } = await frame(page);
    const sheet = page.locator(".pop-sym");
    const scrollBefore = await sheet.evaluate((el) => el.scrollTop);

    const at = (deg: number) => {
      const a = (deg * Math.PI) / 180;
      return { x: cx + 80 * Math.cos(a) * k, y: cy + 80 * Math.sin(a) * k };
    };
    const start = at(-240);
    await page.touchscreen.tap(start.x, start.y);
    expect(await segments(page), "a tap on the 3 tick").toBe(3);

    // A real drag, dispatched as touch pointer events with a capture in play.
    await page.locator(".dial-svg").evaluate(
      (svg, pts) => {
        const fire = (type: string, x: number, y: number) =>
          svg.dispatchEvent(
            new PointerEvent(type, {
              pointerId: 7,
              pointerType: "touch",
              isPrimary: true,
              bubbles: true,
              cancelable: true,
              clientX: x,
              clientY: y,
            }),
          );
        fire("pointerdown", pts[0][0], pts[0][1]);
        for (const [x, y] of pts.slice(1)) fire("pointermove", x, y);
        fire("pointerup", pts[pts.length - 1][0], pts[pts.length - 1][1]);
      },
      Array.from({ length: 13 }, (_, i) => {
        const p = at(-240 + (((15 - 3) / 21) * 300 * i) / 12);
        return [p.x, p.y] as [number, number];
      }),
    );
    expect(await segments(page), "a finger drag from 3 lands on 15").toBe(15);
    expect(await sheet.evaluate((el) => el.scrollTop), "the sheet did not scroll").toBe(
      scrollBefore,
    );
  });
});

test("the handle sits where the count says, and the ticks fill in behind it", async ({ page }) => {
  await openDial(page);
  const { cx, cy, k } = await frame(page);

  // The forward mapping, read out of the rendered DOM: set a count through the
  // hidden range (NOT by dragging) and check where the handle actually is.
  // Together with the drag test this is what proves the two directions agree —
  // either alone passes with a mapping that is consistently wrong.
  for (const value of [3, 6, 12, 15, 24]) {
    await page.locator(".pop-sym .dial-range").fill(String(value));
    const [x, y] = ARTBOARD[value];
    const knob = await settledKnob(page);
    expect(knob.x, `handle x at ${value}`).toBeCloseTo(cx + x * k, 0);
    expect(knob.y, `handle y at ${value}`).toBeCloseTo(cy + y * k, 0);

    // Ticks at or below the count are crease-filled, the rest hairline; and the
    // preview draws one ray per image.
    await expect(page.locator(".dial-tick.is-on")).toHaveCount(value - 2);
    await expect(page.locator(".dial-guide")).toHaveCount(value);
  }
});

test("the handle never covers a label — every one of the eight, measured", async ({ page }) => {
  await openDial(page);
  const { k } = await frame(page);

  // Whether IBM Plex Mono actually loaded decides this by about a pixel, so a
  // silent fallback to a system mono would make the measurement meaningless.
  expect(
    await page.evaluate(() => document.fonts.check('10px "IBM Plex Mono"')),
    "IBM Plex Mono is loaded, so the glyph boxes are the real ones",
  ).toBe(true);

  // Every labelled tick, not a sample. The dial is left-right symmetric, but
  // the GLYPHS are not: "6" is one character where "18" is two, so the roomy
  // measurement at 6 says nothing about 18 on the mirrored ray.
  const gaps: Record<number, number> = {};
  for (const value of [3, 6, 9, 12, 15, 18, 21, 24]) {
    await page.locator(".pop-sym .dial-range").fill(String(value));
    // Settle the sweep first — a handle caught in flight is not the handle
    // whose clearance is being certified.
    await settledKnob(page);
    gaps[value] = await page.evaluate(
      ({ v, r }) => {
        const knob = document.querySelector(".dial-knob")!.getBoundingClientRect();
        const label = document
          .querySelector(`.dial-label[data-value="${v}"]`)!
          .getBoundingClientRect();
        const kx = knob.left + knob.width / 2;
        const ky = knob.top + knob.height / 2;
        // Nearest point of the label's real glyph box to the handle's centre,
        // less the handle's painted radius (r=9 plus half of its 2px ring).
        // The handle's own client rect is NOT that radius — Chromium rotates
        // the unstroked bbox and returns its axis-aligned bounds, which is both
        // stroke-free and angle-dependent.
        const dx = Math.max(label.left - kx, 0, kx - label.right);
        const dy = Math.max(label.top - ky, 0, ky - label.bottom);
        return Math.hypot(dx, dy) - 10 * r;
      },
      { v: value, r: k },
    );
    expect(gaps[value], `label ${value} clearance in px`).toBeGreaterThan(0);
  }
  // Printed so a change that eats the margin is visible before it goes
  // negative — the tightest of these is ~2px, which is not much to spend.
  const worst = Object.entries(gaps).sort((a, b) => a[1] - b[1])[0];
  console.log("label clearance (px):", JSON.stringify(gaps), "— tightest:", worst[0]);
});

test("the mirror toggle is a real 44px control on the centre disc", async ({ page }) => {
  await openDial(page);
  const mirror = page.getByRole("button", { name: "Mirror (dihedral symmetry)" });

  // The effective target, hit-tested — not the bounding box. The dial's SVG is
  // a sibling that spans the whole 220px, so a box measurement would report 44
  // even if the SVG were painted over the button and swallowed every tap.
  const size = await mirror.evaluate((el) => {
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
    return { width: reach(-1, 0) + reach(1, 0) + 1, height: reach(0, -1) + reach(0, 1) + 1 };
  });
  expect(size.width, "mirror toggle effective width").toBeGreaterThanOrEqual(44);
  expect(size.height, "mirror toggle effective height").toBeGreaterThanOrEqual(44);

  // And it toggles the thing it claims to. The foot line is the independent
  // witness — aria-pressed alone could flip while nothing else moved.
  const before = await mirror.getAttribute("aria-pressed");
  await expect(page.locator(".pop-sym .pop-foot .mono-lg")).toHaveText(
    before === "true" ? /mirrored$/ : /rotational$/,
  );
  await mirror.click();
  await expect(mirror).toHaveAttribute("aria-pressed", before === "true" ? "false" : "true");
  await expect(page.locator(".pop-sym .pop-foot .mono-lg")).toHaveText(
    before === "true" ? /rotational$/ : /mirrored$/,
  );

  // Pressing the centre must not have spun the dial as a side effect.
  expect(await segments(page)).toBe(12);
});

test("the accessible control is a real range, and says what it is worth", async ({ page }) => {
  await openDial(page);
  // The contract the older slider carried, unchanged: iOS VoiceOver adjusts a
  // native range, and a spec elsewhere asserts this label.
  const range = page.getByLabel("Symmetry segments");
  await expect(range).toHaveAttribute("type", "range");
  await expect(range).toHaveAttribute("min", "3");
  await expect(range).toHaveAttribute("max", "24");
  await expect(range).toHaveAttribute("aria-valuetext", "12 segments, mirrored");

  await page.getByRole("button", { name: "Mirror (dihedral symmetry)" }).click();
  await expect(range).toHaveAttribute("aria-valuetext", "12 segments, rotational");

  // The keyboard drives it, and the drawing follows — not just the input.
  await range.focus();
  await page.keyboard.press("ArrowRight");
  expect(await segments(page)).toBe(13);
  await expect(page.locator(".top-bar .readout")).toContainText("13 · C");
});

test("the `,` and `.` shortcuts move the dial itself", async ({ page }) => {
  await openDial(page);
  // The dial is a VIEW of `S.segments`, not a second copy of it: a write from
  // outside has to move the handle. (It would not if the handle were driven by
  // drag state instead of by the signal.)
  const start = await settledKnob(page);
  // Fired at the document, not at the dial: the global handler ignores events
  // whose target is an INPUT, so pressing the hidden range would prove nothing.
  await page.keyboard.press(",");
  expect(await segments(page)).toBe(11);
  const moved = await settledKnob(page);
  // One step is 300/21 ≈ 14.3° at r=80, so a real move is ~20px. The handle
  // sweeps there, so this has to be read AFTER it settles — sampled at the
  // instant of the keypress it reads half a pixel and looks broken.
  expect(Math.hypot(moved.x - start.x, moved.y - start.y), "handle travel per step").toBeGreaterThan(15);

  await page.keyboard.press(".");
  await page.keyboard.press(".");
  expect(await segments(page)).toBe(13);
  await expect(page.locator(".dial-guide")).toHaveCount(13);
});

// The sweep, and the reduced-motion escape from it.
//
// 🔴 `transitionDuration` CANNOT test this. Playwright's reduced-motion
// emulation ALSO forces every transition and animation on the page to ~0
// (it reports "1e-06s"), so the duration reads as good as zero whether or not
// this stylesheet has a reduced-motion branch at all — deleting the branch
// leaves a duration assertion green. `transition-property` is not forced, and
// `transition: none` sets it to `none`, so that is the property with something
// to say. Both cases are asserted, and each is the other's control.
test.describe("motion", () => {
  test("the handle sweeps by default", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await openDial(page);
    expect(
      await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches),
      "control: this page is NOT in reduced-motion",
    ).toBe(false);
    const t = await page
      .locator(".dial-handle")
      .evaluate((el) => getComputedStyle(el).transitionProperty);
    expect(t, "the handle animates its rotation along the ring").toBe("transform");
  });

  test("reduced motion: no sweep — the handle snaps", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openDial(page);
    expect(
      await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches),
      "the reduced-motion emulation actually reached the page",
    ).toBe(true);
    const t = await page
      .locator(".dial-handle")
      .evaluate((el) => getComputedStyle(el).transitionProperty);
    expect(t, "nothing transitions — the handle and the preview both snap").toBe("none");
  });
});
