// The Apple Pencil hover ring, through the real Scene and the real overlay.
//
// Driven with synthetic pen PointerEvents for the same reason pressure.spec.ts
// is: `page.mouse` carries neither `pointerType` nor `pressure`, and both are
// the entire input to this feature.
//
// WHAT WOULD STILL PASS IF THE FEATURE WERE DELETED, and how each is closed:
//
//  - "a ring is visible"            → one ring at the pen satisfies it. Closed by
//                                     counting rings AND their distinct centres
//                                     against imageCount, mirrored and not, so
//                                     the two cases expect different numbers.
//  - "rings appear on pen input"    → a ring drawn on EVERY pointermove satisfies
//                                     it. Closed by the pressure-0.8 case, which
//                                     must produce none.
//  - "the canvas still looks right" → closed by pinning the art canvas's pixels
//                                     and the stroke count across a hover.
//
// test/unit/hover.test.ts pins the geometry itself; this file pins that it
// reaches the DOM and that it draws no ink.

import { expect, test, type Page } from "@playwright/test";

test.use({ viewport: { width: 1000, height: 760 }, deviceScaleFactor: 1 });

/** Open the studio with the pen already known, so no toast is in flight. */
async function studio(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // App.tsx raises "Apple Pencil detected" on the false→true transition, and
    // the very first synthetic hover would trip it. Latching it up front keeps
    // the toast out of every assertion below. (Same trick as a11y.spec.ts:101.)
    localStorage.setItem("kal.penSeen", "true");
  });
  await page.goto("/");
  await page.waitForSelector(".canvas-host canvas");
}

/** Dispatch one pointermove at a canvas-relative point. No button, no capture. */
async function move(
  page: Page,
  x: number,
  y: number,
  opts: { pointerType?: string; pressure?: number } = {},
): Promise<void> {
  await page.evaluate(
    (o) => {
      const live = document.querySelectorAll(".canvas-host canvas")[2] as HTMLCanvasElement;
      const r = live.getBoundingClientRect();
      live.dispatchEvent(
        new PointerEvent("pointermove", {
          pointerId: 21,
          pointerType: o.pointerType,
          pressure: o.pressure,
          isPrimary: true,
          bubbles: true,
          cancelable: true,
          clientX: r.left + o.x,
          clientY: r.top + o.y,
        }),
      );
    },
    { x, y, pointerType: opts.pointerType ?? "pen", pressure: opts.pressure ?? 0 },
  );
}

/** Every ring currently in the overlay, in document order. */
async function rings(page: Page) {
  return page.$$eval(".hover-ring circle", (els) =>
    els.map((el) => ({
      x: Number(el.getAttribute("cx")),
      y: Number(el.getAttribute("cy")),
      r: Number(el.getAttribute("r")),
      primary: el.getAttribute("data-primary") === "1",
      opacity: Number(el.getAttribute("opacity")),
    })),
  );
}

/** Set the active layer's symmetry through the signals the toolbar writes. */
async function setSym(page: Page, segments: number, mirror: boolean): Promise<void> {
  await page.evaluate(
    async (o) => {
      const load = (p: string): Promise<any> => import(/* @vite-ignore */ p);
      const S = await load("/src/client/state.ts");
      S.segments.value = o.segments;
      S.mirror.value = o.mirror;
    },
    { segments, mirror },
  );
}

const distinct = (rs: { x: number; y: number }[]) =>
  new Set(rs.map((r) => `${r.x.toFixed(3)},${r.y.toFixed(3)}`)).size;

test.describe("the hover ring is drawn at every symmetry image", () => {
  test("mirrored 12-fold shows 24 rings in 24 places; unmirrored shows 12", async ({ page }) => {
    await studio(page);

    // Off-centre and off every mirror axis, so all 2n images are distinct.
    // (0, 0) or a point on y = 0 would collapse them for reasons that have
    // nothing to do with the ring.
    const hx = 500 + 120;
    const hy = 380 + 66;

    await setSym(page, 12, true);
    await move(page, hx, hy);
    const mirrored = await rings(page);
    expect(mirrored, "12-fold mirrored = 24 images").toHaveLength(24);
    expect(distinct(mirrored), "…in 24 distinct places").toBe(24);

    await setSym(page, 12, false);
    const rotational = await rings(page);
    // The count must FALL when the mirror comes off. A ring-drawer that ignored
    // symmetry entirely would return the same number for both.
    expect(rotational, "12-fold rotational = 12 images").toHaveLength(12);
    expect(distinct(rotational), "…in 12 distinct places").toBe(12);

    await setSym(page, 5, false);
    expect(await rings(page), "5-fold rotational = 5 images").toHaveLength(5);
  });

  test("the ring under the pen is opaque and the others are at 55%", async ({ page }) => {
    await studio(page);
    await setSym(page, 8, true);
    const hx = 500 + 90;
    const hy = 380 + 40;
    await move(page, hx, hy);

    const rs = await rings(page);
    expect(rs).toHaveLength(16);
    const primary = rs.filter((r) => r.primary);
    expect(primary, "exactly one ring is the one under the pen").toHaveLength(1);
    // The overlay is inset:0 in the same host as the canvases, so a
    // canvas-relative hover is an overlay-relative ring position at 1×.
    expect(primary[0].x).toBeCloseTo(hx, 1);
    expect(primary[0].y).toBeCloseTo(hy, 1);
    expect(primary[0].opacity).toBe(1);
    for (const r of rs.filter((r) => !r.primary)) expect(r.opacity).toBe(0.55);
  });

  test("moving the pen moves every ring", async ({ page }) => {
    await studio(page);
    await setSym(page, 6, false);
    await move(page, 560, 400);
    const a = await rings(page);
    await move(page, 620, 300);
    const b = await rings(page);
    expect(a).toHaveLength(6);
    expect(b).toHaveLength(6);
    // Every one of them, not just the one under the pen: a reflection that were
    // computed once and cached would fail here and nowhere else.
    for (let i = 0; i < 6; i++) {
      expect(`${b[i].x},${b[i].y}`, `image ${i} moved`).not.toBe(`${a[i].x},${a[i].y}`);
    }
  });
});

test.describe("the ring is hover only", () => {
  test("a pen in contact (pressure 0.8) draws no ring", async ({ page }) => {
    await studio(page);
    await setSym(page, 12, true);

    // Control first: the same event at pressure 0 does produce rings, so a
    // failure below is the pressure test and not a broken harness.
    await move(page, 600, 420, { pressure: 0 });
    expect(await rings(page), "control: hovering pen").toHaveLength(24);

    // No pointerdown precedes this on purpose. The guard under test is
    // `pressure === 0` alone; if the engine also required "no stroke in
    // progress" the suppression here would prove nothing about it.
    await move(page, 610, 430, { pressure: 0.8 });
    expect(await rings(page), "pen in contact").toHaveLength(0);
  });

  test("a mouse and a finger never show it, whatever their pressure", async ({ page }) => {
    await studio(page);
    await setSym(page, 12, true);
    await move(page, 600, 420, { pointerType: "mouse", pressure: 0 });
    expect(await rings(page), "mouse at pressure 0").toHaveLength(0);
    await move(page, 600, 420, { pointerType: "touch", pressure: 0 });
    expect(await rings(page), "touch at pressure 0").toHaveLength(0);
    await move(page, 600, 420, { pointerType: "pen", pressure: 0 });
    expect(await rings(page), "control: the pen still does").toHaveLength(24);
  });

  test("the ring clears when the pen leaves the canvas", async ({ page }) => {
    await studio(page);
    await move(page, 600, 420);
    expect(await rings(page)).not.toHaveLength(0);
    await page.evaluate(() => {
      const live = document.querySelectorAll(".canvas-host canvas")[2] as HTMLCanvasElement;
      live.dispatchEvent(
        new PointerEvent("pointerleave", { pointerId: 21, pointerType: "pen", bubbles: true }),
      );
    });
    expect(await rings(page), "pen out of range").toHaveLength(0);
  });
});

test.describe("hovering never commits ink", () => {
  test("a hover across the canvas changes neither the stroke count nor a pixel", async ({
    page,
  }) => {
    await studio(page);
    await setSym(page, 12, true);

    // Draw first, so "unchanged" is a real picture rather than an empty canvas
    // that would compare equal however broken the hover path were.
    await page.mouse.move(420, 300);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) await page.mouse.move(420 + i * 9, 300 + i * 6);
    await page.mouse.up();

    const read = () =>
      page.evaluate(async () => {
        const load = (p: string): Promise<any> => import(/* @vite-ignore */ p);
        const S = await load("/src/client/state.ts");
        const art = document.querySelectorAll(".canvas-host canvas")[1] as HTMLCanvasElement;
        return { count: S.strokeCount.value as number, png: art.toDataURL("image/png") };
      });

    const before = await read();
    expect(before.count, "the fixture stroke committed").toBe(1);

    for (let i = 0; i < 20; i++) await move(page, 380 + i * 12, 260 + i * 9);
    expect(await rings(page), "…and the pen really was hovering").not.toHaveLength(0);

    const after = await read();
    expect(after.count, "hovering adds no stroke").toBe(before.count);
    // The ring lives on its own SVG overlay, so it must not have touched the art
    // canvas either — a ring painted into the art layer would be saved.
    expect(after.png, "hovering leaves the art canvas byte-identical").toBe(before.png);
  });
});
