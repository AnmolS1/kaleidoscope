// Capture-time pressure and smoothing, driven through the REAL Scene.
//
// Everything here is exercised by dispatching synthetic pen PointerEvents at the
// live canvas, because that is the only input path that carries `pointerType`
// and `pressure` — Playwright's `page.mouse` reports neither. The events are
// untrusted, which is fine: Scene's `setPointerCapture` is already wrapped in a
// try/catch and its coalesced-event read already falls back to `[e]`.
//
// THE VACUOUS-PASS TRAP this file is built to avoid: `pointFromEvent` falls back
// to a hard-coded 0.5 when `e.pressure` is 0, and 0.5^0.6 / 0.5^1 / 0.5^1.6 are
// three different numbers. So "the three presets differ" passes even if pressure
// injection is completely broken. Every assertion below therefore names the
// EXPECTED value for an injected 0.8, and additionally asserts it is not what
// the 0.5 fallback would have produced.

import { expect, test } from "@playwright/test";

// Fixed geometry so the canvas backing store, and therefore every render, is
// deterministic and comparable across the cases in one test.
test.use({ viewport: { width: 1000, height: 760 }, deviceScaleFactor: 1 });

const INJECTED = 0.8;
const GAMMA = { light: 0.6, normal: 1, firm: 1.6 } as const;
type Preset = keyof typeof GAMMA;

/**
 * Draw one pen stroke and report what the engine stored plus a PNG of the
 * committed art canvas.
 *
 * `preset`/`po` are written to the STATE SIGNALS, not pushed at the Scene
 * directly, so this also covers the Canvas.tsx bridge that carries them into the
 * engine — the popover that will write those signals is a later task, and
 * without the bridge the whole feature would be inert in the app.
 */
async function penStroke(
  page: import("@playwright/test").Page,
  opts: { preset?: Preset; po?: boolean; pointerType?: string; size?: number } = {},
) {
  return page.evaluate(async (o) => {
    const load = (p: string): Promise<any> => import(/* @vite-ignore */ p);
    const S = await load("/src/client/state.ts");
    const scene = S.scene.value;
    if (!scene) return { error: "scene not mounted" } as any;

    S.pressurePreset.value = o.preset ?? "normal";
    S.pressureOpacity.value = o.po ?? false;
    S.size.value = o.size ?? 24;
    scene.clear();

    const host = document.querySelector(".canvas-host")!;
    const live = host.querySelectorAll("canvas")[2] as HTMLCanvasElement;
    const art = host.querySelectorAll("canvas")[1] as HTMLCanvasElement;
    const r = live.getBoundingClientRect();

    const ev = (type: string, x: number, y: number) =>
      new PointerEvent(type, {
        pointerId: 11,
        pointerType: o.pointerType ?? "pen",
        pressure: 0.8,
        isPrimary: true,
        bubbles: true,
        cancelable: true,
        clientX: r.left + x,
        clientY: r.top + y,
      });

    // A wide arc, so smoothing has real curvature to express and the stroke
    // covers enough pixels for a width change to show.
    const cx = r.width / 2;
    const cy = r.height / 2;
    const pt = (i: number): [number, number] => [cx + i * 26 - 130, cy - 120 + Math.sin(i / 1.6) * 70];
    live.dispatchEvent(ev("pointerdown", ...pt(0)));
    for (let i = 1; i <= 10; i++) live.dispatchEvent(ev("pointermove", ...pt(i)));
    live.dispatchEvent(ev("pointerup", ...pt(10)));

    const stroke = scene.getDrawing().layers[0].strokes[0];
    return {
      count: scene.getDrawing().layers[0].strokes.length,
      pressures: stroke ? stroke.pts.map((p: number[]) => p[2]) : [],
      sm: stroke?.sm,
      po: stroke?.po,
      png: art.toDataURL("image/png"),
    };
  }, opts);
}

test.describe("pressure presets and smoothing at capture", () => {
  test("stores p^gamma for each of the three presets", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".canvas-host canvas");

    for (const preset of ["light", "normal", "firm"] as Preset[]) {
      const res = await penStroke(page, { preset });
      expect(res.error, "scene mounted").toBeUndefined();
      expect(res.count, `${preset}: one committed stroke`).toBe(1);

      // `PointerEvent.pressure` is a float32 in the browser, so the 0.8 that
      // goes in comes back as 0.800000011920929. Seven digits is well inside
      // that and still ~7 orders of magnitude tighter than any preset gap.
      const want = INJECTED ** GAMMA[preset];
      for (const p of res.pressures) {
        expect(p, `${preset}: stored pressure`).toBeCloseTo(want, 7);
      }
      // If synthetic `pressure` did not survive the event constructor, every
      // point would carry the 0.5 fallback raised to the same gamma — which is
      // still three distinct values across the presets, and would sail past a
      // "the presets differ" assertion. Name it explicitly.
      expect(res.pressures[0], `${preset}: not the 0.5 fallback`).not.toBeCloseTo(
        0.5 ** GAMMA[preset],
        6,
      );
    }
  });

  test("normal is the identity, light lifts and firm lowers", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".canvas-host canvas");

    const light = (await penStroke(page, { preset: "light" })).pressures[0];
    const normal = (await penStroke(page, { preset: "normal" })).pressures[0];
    const firm = (await penStroke(page, { preset: "firm" })).pressures[0];

    expect(normal).toBeCloseTo(INJECTED, 7); // float32 pressure; see above
    expect(light).toBeGreaterThan(normal);
    expect(firm).toBeLessThan(normal);
  });

  test("every new stroke carries sm: 1", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".canvas-host canvas");
    expect((await penStroke(page)).sm).toBe(1);
  });

  test("po is set for a pen only when the toggle is on", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".canvas-host canvas");

    expect((await penStroke(page, { po: true })).po, "pen + toggle on").toBe(1);
    expect((await penStroke(page, { po: false })).po, "pen + toggle off").toBeUndefined();
    // A mouse or finger reports a constant pressure, so `po` there would just
    // dim every stroke by a fixed amount. Pen-only is the rule.
    expect(
      (await penStroke(page, { po: true, pointerType: "mouse" })).po,
      "mouse + toggle on",
    ).toBeUndefined();
    expect(
      (await penStroke(page, { po: true, pointerType: "touch" })).po,
      "touch + toggle on",
    ).toBeUndefined();
  });
});

test.describe("the presets are visibly different on the canvas", () => {
  test("three presets render three different pictures, and a repeat renders the same one", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForSelector(".canvas-host canvas");

    const light = (await penStroke(page, { preset: "light" })).png;
    const normal = (await penStroke(page, { preset: "normal" })).png;
    const firm = (await penStroke(page, { preset: "firm" })).png;
    // CONTROL. Without this, "the three differ" is compatible with the renderer
    // emitting noise: it proves the comparison is stable when the input is.
    const normalAgain = (await penStroke(page, { preset: "normal" })).png;

    expect(normal.length, "the canvas actually drew something").toBeGreaterThan(5000);
    expect(normalAgain, "same preset, same pixels").toBe(normal);
    expect(light, "light vs normal").not.toBe(normal);
    expect(firm, "firm vs normal").not.toBe(normal);
    expect(light, "light vs firm").not.toBe(firm);
  });

  test("po changes the pixels, and only when it is on", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".canvas-host canvas");

    const off = (await penStroke(page, { po: false })).png;
    const on = (await penStroke(page, { po: true })).png;
    const offAgain = (await penStroke(page, { po: false })).png;

    expect(offAgain, "control: po off is reproducible").toBe(off);
    expect(on, "po on paints at a pressure-scaled alpha").not.toBe(off);
  });
});

test.describe("smoothing reaches the pixels", () => {
  // The unit tests prove `strokeSegments` emits cubics and that `drawStroke`
  // turns them into bezierCurveTo. This closes the last gap: that the curve
  // survives all the way through the live Scene's compositing onto real pixels.
  test("an sm stroke renders differently from the same points as a polyline", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".canvas-host canvas");

    const render = (sm: boolean) =>
      page.evaluate(async (withSm: boolean) => {
        const load = (p: string): Promise<any> => import(/* @vite-ignore */ p);
        const S = await load("/src/client/state.ts");
        const scene = S.scene.value;
        // Sharp direction changes, widely spaced: a polyline shows corners here
        // where the smoothed path rounds them.
        const pts = [
          [-0.6, 0.1, 1],
          [-0.2, -0.5, 1],
          [0.1, 0.4, 1],
          [0.5, -0.3, 1],
          [0.7, 0.2, 1],
        ];
        scene.loadDrawing({
          v: 2,
          bg: "light",
          layers: [
            {
              id: "l1",
              name: "Layer 1",
              visible: true,
              opacity: 1,
              sym: { segments: 4, mirror: false },
              strokes: [
                {
                  tool: "solid",
                  color: "#E84A27",
                  size: 10,
                  opacity: 1,
                  ...(withSm ? { sm: 1 } : {}),
                  pts,
                },
              ],
            },
          ],
        });
        const host = document.querySelector(".canvas-host")!;
        const art = host.querySelectorAll("canvas")[1] as HTMLCanvasElement;
        return art.toDataURL("image/png");
      }, sm);

    const polyline = await render(false);
    const smoothed = await render(true);
    // CONTROL: without it, "these differ" would also pass if the renderer were
    // simply non-deterministic.
    const polylineAgain = await render(false);

    expect(polyline.length, "something was drawn").toBeGreaterThan(5000);
    expect(polylineAgain, "control: same input, same pixels").toBe(polyline);
    expect(smoothed, "sm: 1 curves the path").not.toBe(polyline);
  });
});
