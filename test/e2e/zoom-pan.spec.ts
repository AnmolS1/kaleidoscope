// Zoom and pan, driven through the REAL Scene.
//
// Two of these are the task's acceptance criteria and they are written to FAIL
// if the transform is applied the wrong way round rather than merely to observe
// that something happened:
//
//  - "a stroke at 4x lands at the right normalized coords" asserts the exact
//    coordinates, computed here by hand from the screen positions, and pairs
//    them with a 1x control. Multiplying by the scale instead of dividing gives
//    numbers 16x out, which this sees; "a stroke exists" would not.
//  - "decimation at 8x keeps sub-2px screen moves" drives 2 px integer steps.
//    With the threshold divided by the scale it is ~1.1 px of SCREEN at every
//    zoom, so they are all kept; without the division it is 8.8 px of screen at
//    8x and four fifths of them vanish. It is paired with a zero-move control,
//    so it cannot pass by decimation having been switched off altogether.
//
// Touch gestures use synthetic PointerEvents, the same technique pressure.spec
// uses for pen input: page.mouse cannot express a second finger. They are
// untrusted events, which the engine already tolerates (setPointerCapture is
// wrapped in try/catch). What that does NOT cover is real iOS hardware — Safari
// touch-action, the browser's own pinch-to-zoom, and Pencil-vs-finger arbitration
// are only observable on a device.

import { expect, test, type Page } from "@playwright/test";

// Fixed geometry so the canvas backing store, and every coordinate below, is
// deterministic.
test.use({ viewport: { width: 1000, height: 760 }, deviceScaleFactor: 1 });

interface Geom {
  left: number;
  top: number;
  cssW: number;
  cssH: number;
}

/** Load the studio, clear it, and report where the live canvas actually is. */
async function studio(page: Page): Promise<Geom> {
  await page.goto("/");
  await page.waitForSelector(".canvas-host canvas");
  return page.evaluate(async () => {
    const load = (p: string): Promise<any> => import(/* @vite-ignore */ p);
    const S = await load("/src/client/state.ts");
    const scene = S.scene.value;
    scene.resetView();
    scene.clear();
    S.drawWithFinger.value = true;

    const host = document.querySelector(".canvas-host")!;
    const live = host.querySelectorAll("canvas")[2] as HTMLCanvasElement;
    const art = host.querySelectorAll("canvas")[1] as HTMLCanvasElement;
    const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    const r = live.getBoundingClientRect();
    // cssW/cssH from the BACKING STORE, the same way the engine derived them, so
    // the expected coordinates below are computed against the geometry the
    // engine is actually using rather than against the layout box.
    return { left: r.left, top: r.top, cssW: art.width / dpr, cssH: art.height / dpr };
  });
}

/** Zoom about the middle of the canvas and return the resulting view. */
function zoomCentre(page: Page, factor: number) {
  return page.evaluate(async (f: number) => {
    const load = (p: string): Promise<any> => import(/* @vite-ignore */ p);
    const S = await load("/src/client/state.ts");
    const scene = S.scene.value;
    const art = document.querySelector(".canvas-host")!.querySelectorAll("canvas")[1] as HTMLCanvasElement;
    const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    scene.zoomAt(art.width / dpr / 2, art.height / dpr / 2, f);
    return scene.getView();
  }, factor);
}

function firstStroke(page: Page) {
  return page.evaluate(async () => {
    const load = (p: string): Promise<any> => import(/* @vite-ignore */ p);
    const S = await load("/src/client/state.ts");
    const layer = S.scene.value.getDrawing().layers[0];
    return { count: layer.strokes.length, pts: layer.strokes[0]?.pts ?? [] };
  });
}

/** Drag the mouse through canvas-relative points, committing one stroke. */
async function mouseStroke(page: Page, g: Geom, pts: Array<[number, number]>): Promise<void> {
  await page.mouse.move(g.left + pts[0][0], g.top + pts[0][1]);
  await page.mouse.down();
  for (const [x, y] of pts.slice(1)) await page.mouse.move(g.left + x, g.top + y);
  await page.mouse.up();
}

test.describe("view transform", () => {
  test("a stroke drawn at 4x lands at the right normalized coordinates", async ({ page }) => {
    const g = await studio(page);
    const half = Math.min(g.cssW, g.cssH) / 2;

    const view = await zoomCentre(page, 4);
    // PRECONDITION, asserted before anything is drawn: a centre-anchored 4x on
    // this canvas is exactly this view. If a clamp, a resize or a rounding
    // change ever perturbs it, this fails loudly instead of the expectations
    // below quietly adapting to whatever the engine chose.
    expect(view).toEqual({ scale: 4, tx: -1.5 * g.cssW, ty: -1.5 * g.cssH });

    // Screen offsets from the centre of the canvas.
    const offsets: Array<[number, number]> = [
      [100, -80],
      [140, -40],
      [180, 0],
      [220, 40],
    ];
    await mouseStroke(
      page,
      g,
      offsets.map(([dx, dy]) => [g.cssW / 2 + dx, g.cssH / 2 + dy] as [number, number]),
    );

    const at4 = await firstStroke(page);
    expect(at4.count).toBe(1);
    expect(at4.pts.length).toBe(offsets.length);
    // Worked out here, independently of the engine: a screen offset of `d` px
    // from the centre is d/4 drawing px at 4x, and normalized coordinates divide
    // by `half`. Applying the scale the wrong way round would give d*4/half.
    for (let i = 0; i < offsets.length; i++) {
      expect(at4.pts[i][0]).toBeCloseTo(offsets[i][0] / 4 / half, 6);
      expect(at4.pts[i][1]).toBeCloseTo(offsets[i][1] / 4 / half, 6);
    }

    // Control: the identical screen path at 1x must produce DIFFERENT, larger
    // coordinates — otherwise the assertions above would hold with the view
    // ignored entirely.
    await page.evaluate(async () => {
      const load = (p: string): Promise<any> => import(/* @vite-ignore */ p);
      const S = await load("/src/client/state.ts");
      S.scene.value.resetView();
      S.scene.value.clear();
    });
    await mouseStroke(
      page,
      g,
      offsets.map(([dx, dy]) => [g.cssW / 2 + dx, g.cssH / 2 + dy] as [number, number]),
    );
    const at1 = await firstStroke(page);
    expect(at1.pts.length).toBe(offsets.length);
    for (let i = 0; i < offsets.length; i++) {
      expect(at1.pts[i][0]).toBeCloseTo(offsets[i][0] / half, 6);
    }
    expect(at1.pts[0][0]).not.toBeCloseTo(at4.pts[0][0], 4);
  });

  test("decimation at 8x keeps sub-2px screen moves", async ({ page }) => {
    const g = await studio(page);
    const view = await zoomCentre(page, 8);
    expect(view.scale).toBe(8);

    // 2 px steps: above the ~1.1 px screen threshold the divided form gives, far
    // below the 8.8 px an undivided one would demand at 8x.
    const STEPS = 20;
    const path: Array<[number, number]> = [];
    for (let i = 0; i <= STEPS; i++) path.push([g.cssW / 2 - 100 + i * 2, g.cssH / 2]);
    await mouseStroke(page, g, path);

    const kept = await firstStroke(page);
    expect(kept.count).toBe(1);
    // Allow one or two lost to event coalescing; four fifths missing is the
    // failure this is looking for.
    expect(kept.pts.length).toBeGreaterThanOrEqual(STEPS - 1);

    // Control: decimation is still ON at 8x. Repeating the same point moves
    // zero px, so every one after the first must be dropped — if this also kept
    // 21 points the test above would be passing because nothing is filtered.
    await page.evaluate(async () => {
      const load = (p: string): Promise<any> => import(/* @vite-ignore */ p);
      const S = await load("/src/client/state.ts");
      S.scene.value.clear();
    });
    await mouseStroke(
      page,
      g,
      Array.from({ length: STEPS + 1 }, () => [g.cssW / 2, g.cssH / 2] as [number, number]),
    );
    const still = await firstStroke(page);
    expect(still.pts.length).toBe(1);
  });

  test("at the identity view the engine adds no transform of its own", async ({ page }) => {
    // The render goldens cannot see this: `translate(0, 0); scale(1, 1)` is a
    // bit-exact no-op, so v1-render.spec passes with the guard deleted (checked
    // by deleting it). The guard is still what keeps the 1x paint path literally
    // the pre-view path, so it gets its own observation.
    //
    // `ctx.scale` is a clean probe because the only other caller in the whole
    // paint path is the mirror in symmetry.ts, which is always `scale(1, -1)`.
    const g = await studio(page);
    await mouseStroke(page, g, [
      [g.cssW / 2 - 50, g.cssH / 2 - 50],
      [g.cssW / 2, g.cssH / 2],
      [g.cssW / 2 + 50, g.cssH / 2 + 50],
    ]);

    const r = await page.evaluate(async () => {
      const load = (p: string): Promise<any> => import(/* @vite-ignore */ p);
      const S = await load("/src/client/state.ts");
      const scene = S.scene.value;
      const proto = CanvasRenderingContext2D.prototype;
      const real = proto.scale;
      let calls: Array<[number, number]> = [];
      proto.scale = function (x: number, y: number) {
        calls.push([x, y]);
        return real.call(this, x, y);
      };
      try {
        // Forces a full grid + art re-render without changing the drawing.
        scene.setBackground(S.bg.value);
        const identity = calls.filter((c) => c[0] === 1 && c[1] === 1).length;
        calls = [];
        scene.zoomAt(10, 10, 3);
        const zoomed = calls.filter((c) => c[0] === 3 && c[1] === 3).length;
        return { identity, zoomed };
      } finally {
        proto.scale = real;
      }
    });

    expect(r.identity).toBe(0);
    // Control: the probe does see the transform when there IS one, so the zero
    // above is a real absence rather than a broken observation.
    expect(r.zoomed).toBeGreaterThan(0);
  });

  test("the badge signals survive leaving the studio and coming back", async ({ page }) => {
    await studio(page);
    const zoomed = await zoomCentre(page, 4);
    expect(zoomed.scale).toBe(4);

    await page.evaluate(async () => {
      const load = (p: string): Promise<any> => import(/* @vite-ignore */ p);
      const S = await load("/src/client/state.ts");
      S.navigate("/gallery");
    });
    await page.waitForSelector(".canvas-host canvas", { state: "detached" });
    await page.evaluate(async () => {
      const load = (p: string): Promise<any> => import(/* @vite-ignore */ p);
      const S = await load("/src/client/state.ts");
      S.navigate("/");
    });
    await page.waitForSelector(".canvas-host canvas");

    // A new Scene starts at the identity view and never announces it (nothing
    // changed), so the mirrors have to be reset when the old engine goes. What
    // this discriminates is AGREEMENT AFTER A REMOUNT: a badge reading 400% over
    // a 1x canvas, with a reset affordance that resets nothing.
    const r = await page.evaluate(async () => {
      const load = (p: string): Promise<any> => import(/* @vite-ignore */ p);
      const S = await load("/src/client/state.ts");
      return { view: S.scene.value.getView(), scale: S.viewScale.value, isDefault: S.viewIsDefault.value };
    });
    expect(r.view).toEqual({ scale: 1, tx: 0, ty: 0 });
    expect(r.scale).toBe(1);
    expect(r.isDefault).toBe(true);
  });

  test("exports ignore the view entirely", async ({ page }) => {
    const g = await studio(page);
    await mouseStroke(page, g, [
      [g.cssW / 2 - 60, g.cssH / 2 - 60],
      [g.cssW / 2, g.cssH / 2 - 20],
      [g.cssW / 2 + 60, g.cssH / 2 + 40],
    ]);

    // True by construction today — exporters re-render from getDrawing() and
    // never read a canvas. That is exactly why it is pinned: this is what breaks
    // the day someone "helpfully" bakes the view into the render path.
    const r = await page.evaluate(async () => {
      const load = (p: string): Promise<any> => import(/* @vite-ignore */ p);
      const S = await load("/src/client/state.ts");
      const { exportPNG } = await load("/src/client/engine/export.ts");
      const scene = S.scene.value;

      const digest = async (): Promise<string> => {
        const blob = await exportPNG(scene.getDrawing(), 1);
        const buf = await blob.arrayBuffer();
        const h = await crypto.subtle.digest("SHA-256", buf);
        return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
      };

      const flat = await digest();
      scene.zoomAt(10, 10, 6);
      scene.panBy(-120, 45);
      const zoomed = await digest();
      return { flat, zoomed, view: scene.getView() };
    });

    expect(r.view.scale).toBeGreaterThan(1);
    expect(r.flat).toHaveLength(64);
    expect(r.zoomed).toBe(r.flat);
  });

  test("ctrl+wheel zooms about the pointer and keeps what is under it", async ({ page }) => {
    const g = await studio(page);
    // Whole viewport pixels: the browser delivers the wheel at an integer
    // clientX/clientY, so a fractional target would put the engine's anchor half
    // a pixel away from the point this test then probes — and at 8x half a pixel
    // of screen is a visible fraction of a drawing pixel.
    const at = {
      x: Math.round(g.left + g.cssW / 2 + 150),
      y: Math.round(g.top + g.cssH / 2 - 90),
    };

    const under = (p: Page) =>
      p.evaluate(async (c: { x: number; y: number }) => {
        const load = (q: string): Promise<any> => import(/* @vite-ignore */ q);
        const S = await load("/src/client/state.ts");
        return S.scene.value.screenToNormalized(c.x, c.y);
      }, at);

    const before = await under(page);
    await page.mouse.move(at.x, at.y);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -240);
    await page.keyboard.up("Control");

    const after = await under(page);
    const view = await page.evaluate(async () => {
      const load = (p: string): Promise<any> => import(/* @vite-ignore */ p);
      const S = await load("/src/client/state.ts");
      return S.scene.value.getView();
    });
    expect(view.scale).toBeGreaterThan(1.2);
    // The anchor property: the drawing point under the cursor did not move.
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    // And the badge's signal followed.
    const badge = await page.evaluate(async () => {
      const load = (p: string): Promise<any> => import(/* @vite-ignore */ p);
      const S = await load("/src/client/state.ts");
      return { scale: S.viewScale.value, isDefault: S.viewIsDefault.value };
    });
    expect(badge.scale).toBeCloseTo(view.scale, 9);
    expect(badge.isDefault).toBe(false);
  });

  test("space-drag pans without drawing, and resize preserves the view", async ({ page }) => {
    const g = await studio(page);
    await page.keyboard.down("Space");
    await page.mouse.move(g.left + g.cssW / 2, g.top + g.cssH / 2);
    await page.mouse.down();
    await page.mouse.move(g.left + g.cssW / 2 - 60, g.top + g.cssH / 2 + 30);
    await page.mouse.move(g.left + g.cssW / 2 - 120, g.top + g.cssH / 2 + 55);
    await page.mouse.up();
    await page.keyboard.up("Space");

    const panned = await page.evaluate(async () => {
      const load = (p: string): Promise<any> => import(/* @vite-ignore */ p);
      const S = await load("/src/client/state.ts");
      return { view: S.scene.value.getView(), strokes: S.scene.value.strokeCount };
    });
    expect(panned.strokes).toBe(0);
    expect(panned.view.tx).toBeCloseTo(-120, 0);
    expect(panned.view.ty).toBeCloseTo(55, 0);

    // A rotation / Stage Manager resize must not throw the view away. Height
    // only, so the toolbar stays at the same breakpoint and the only thing that
    // changed is the canvas geometry.
    const before = await page.evaluate(
      () =>
        (document.querySelector(".canvas-host")!.querySelectorAll("canvas")[1] as HTMLCanvasElement).height,
    );
    await page.setViewportSize({ width: 1000, height: 600 });
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (document.querySelector(".canvas-host")!.querySelectorAll("canvas")[1] as HTMLCanvasElement)
              .height,
        ),
      )
      .not.toBe(before);

    const kept = await page.evaluate(async () => {
      const load = (p: string): Promise<any> => import(/* @vite-ignore */ p);
      const S = await load("/src/client/state.ts");
      return S.scene.value.getView();
    });
    expect(kept.tx).toBeCloseTo(-120, 6);
    expect(kept.ty).toBeCloseTo(55, 6);
  });
});

// ---- touch ---------------------------------------------------------------

/**
 * Play a sequence of synthetic touch PointerEvents at the live canvas.
 *
 * Coordinates are canvas-relative; `id` selects the finger. This is the only way
 * to express two fingers — page.mouse has exactly one.
 */
async function touch(
  page: Page,
  steps: Array<{ type: "pointerdown" | "pointermove" | "pointerup"; id: number; x: number; y: number }>,
  opts: { finger?: boolean; gapMs?: number } = {},
) {
  return page.evaluate(
    async (o: { steps: typeof steps; finger: boolean; gapMs: number }) => {
      const load = (p: string): Promise<any> => import(/* @vite-ignore */ p);
      const S = await load("/src/client/state.ts");
      S.drawWithFinger.value = o.finger;

      const host = document.querySelector(".canvas-host")!;
      const live = host.querySelectorAll("canvas")[2] as HTMLCanvasElement;
      const r = live.getBoundingClientRect();
      for (const s of o.steps) {
        live.dispatchEvent(
          new PointerEvent(s.type, {
            pointerId: s.id,
            pointerType: "touch",
            pressure: s.type === "pointerup" ? 0 : 0.5,
            isPrimary: s.id === 1,
            bubbles: true,
            cancelable: true,
            clientX: r.left + s.x,
            clientY: r.top + s.y,
          }),
        );
        if (o.gapMs) await new Promise((res) => setTimeout(res, o.gapMs));
      }
      const scene = S.scene.value;
      return { view: scene.getView(), strokes: scene.strokeCount };
    },
    { steps, finger: opts.finger ?? true, gapMs: opts.gapMs ?? 0 },
  );
}

test.describe("touch gestures", () => {
  // REVIEW.md minor mE4 — a finger that crossed the canvas edge mid-pinch froze
  // the gesture.
  //
  // `abortStroke()` RELEASES the first finger's capture on its way into the
  // pinch, and only the newly-landed pointer was captured afterwards. An
  // uncaptured pointer fires `pointerleave` when it crosses the element edge,
  // and this class treats a leave as a lift — so the touch left the map,
  // `touchMetrics()` could no longer find two points, and the pinch stopped
  // responding until every finger came up.
  //
  // Asserted at the MECHANISM, because synthetic pointer ids cannot actually be
  // captured (`setPointerCapture` throws for them, which is why the call is
  // wrapped) — so a behavioural test here would pass for the wrong reason. What
  // is checkable is which ids the gesture ASKS to capture.
  test("a pinch captures every finger, not just the one that just landed", async ({ page }) => {
    const g = await studio(page);
    const cx = g.cssW / 2;
    const cy = g.cssH / 2;

    const captured = await page.evaluate(
      async (p: { cx: number; cy: number }) => {
        const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
        const S = await load("/src/client/state.ts");
        S.drawWithFinger.value = true;

        const host = document.querySelector(".canvas-host")!;
        const live = host.querySelectorAll("canvas")[2] as HTMLCanvasElement;
        const r = live.getBoundingClientRect();

        const asked: number[] = [];
        const real = live.setPointerCapture.bind(live);
        live.setPointerCapture = (id: number) => {
          asked.push(id);
          return real(id); // still throws for a synthetic id; the caller catches
        };

        const send = (type: string, id: number, x: number, y: number) =>
          live.dispatchEvent(
            new PointerEvent(type, {
              pointerId: id, pointerType: "touch",
              pressure: type === "pointerup" ? 0 : 0.5,
              isPrimary: id === 1, bubbles: true, cancelable: true,
              clientX: r.left + x, clientY: r.top + y,
            }),
          );

        // One finger draws, then a second lands and converts it to a pinch.
        send("pointerdown", 1, p.cx - 40, p.cy);
        send("pointermove", 1, p.cx - 20, p.cy);
        const beforeSecond = asked.length;
        send("pointerdown", 2, p.cx + 60, p.cy);
        const duringPinch = asked.slice(beforeSecond);
        send("pointerup", 1, p.cx - 40, p.cy);
        send("pointerup", 2, p.cx + 60, p.cy);
        return { duringPinch, firstFingerAlone: beforeSecond };
      },
      { cx, cy },
    );

    // CONTROL: the lone drawing finger takes exactly one capture, so the count
    // below is about the pinch and not about capture being called everywhere.
    expect(captured.firstFingerAlone).toBe(1);
    // BOTH fingers. Before the fix this was [2] — the first finger, whose
    // capture abortStroke had just released, was left loose.
    expect([...captured.duringPinch].sort()).toEqual([1, 2]);
  });

  test("a second finger cancels the stroke the first had started", async ({ page }) => {
    const g = await studio(page);
    const cx = g.cssW / 2;
    const cy = g.cssH / 2;

    const r = await touch(page, [
      // One finger begins a real stroke...
      { type: "pointerdown", id: 1, x: cx - 40, y: cy },
      { type: "pointermove", id: 1, x: cx - 20, y: cy + 10 },
      { type: "pointermove", id: 1, x: cx, y: cy + 20 },
      // ...and the second finger arrives. That half-stroke must be thrown away,
      // not committed: it is the stray mark a naive implementation leaves behind
      // on every pinch.
      { type: "pointerdown", id: 2, x: cx + 60, y: cy },
      { type: "pointermove", id: 1, x: cx - 60, y: cy + 20 },
      { type: "pointermove", id: 2, x: cx + 120, y: cy },
      { type: "pointerup", id: 1, x: cx - 60, y: cy + 20 },
      { type: "pointerup", id: 2, x: cx + 120, y: cy },
    ]);

    expect(r.strokes).toBe(0);
    // Fingers spread, so it zoomed in.
    expect(r.view.scale).toBeGreaterThan(1);

    // AND the canvas still draws afterwards. This half is the part that has
    // teeth: with the abort removed, nothing is committed either (the pinch
    // branch swallows every pointerup), so "0 strokes" passes — while
    // `activePointer` is left pointing at a finger that is no longer down and
    // the guard at the top of onDown refuses every future stroke. Silent, and
    // permanent until reload.
    const after = await touch(page, [
      { type: "pointerdown", id: 3, x: cx - 30, y: cy - 30 },
      { type: "pointermove", id: 3, x: cx + 10, y: cy },
      { type: "pointermove", id: 3, x: cx + 50, y: cy + 30 },
      { type: "pointerup", id: 3, x: cx + 50, y: cy + 30 },
    ]);
    expect(after.strokes).toBe(1);
  });

  test("one finger draws iff drawWithFinger, and pans otherwise", async ({ page }) => {
    const g = await studio(page);
    const cx = g.cssW / 2;
    const cy = g.cssH / 2;
    const swipe = (): Parameters<typeof touch>[1] => [
      { type: "pointerdown", id: 1, x: cx - 50, y: cy - 50 },
      { type: "pointermove", id: 1, x: cx, y: cy },
      { type: "pointermove", id: 1, x: cx + 50, y: cy + 50 },
      { type: "pointerup", id: 1, x: cx + 50, y: cy + 50 },
    ];

    const drew = await touch(page, swipe(), { finger: true });
    expect(drew.strokes).toBe(1);
    expect(drew.view).toEqual({ scale: 1, tx: 0, ty: 0 });

    await page.evaluate(async () => {
      const load = (p: string): Promise<any> => import(/* @vite-ignore */ p);
      const S = await load("/src/client/state.ts");
      S.scene.value.clear();
      S.scene.value.resetView();
    });

    const panned = await touch(page, swipe(), { finger: false });
    expect(panned.strokes).toBe(0);
    expect(panned.view.tx).toBeCloseTo(100, 0);
    expect(panned.view.ty).toBeCloseTo(100, 0);
  });

  test("double-tap restores the identity view", async ({ page }) => {
    const g = await studio(page);
    const cx = g.cssW / 2;
    const cy = g.cssH / 2;
    const zoomed = await zoomCentre(page, 5);
    expect(zoomed.scale).toBe(5);

    // Two taps that do not draw — finger drawing off, so each is a pan gesture
    // that never moved. (With finger drawing ON a double tap is two dots of ink;
    // that limitation is documented on Scene.endGestureTap.)
    const after = await touch(
      page,
      [
        { type: "pointerdown", id: 1, x: cx, y: cy },
        { type: "pointerup", id: 1, x: cx, y: cy },
        { type: "pointerdown", id: 1, x: cx + 3, y: cy - 2 },
        { type: "pointerup", id: 1, x: cx + 3, y: cy - 2 },
      ],
      { finger: false, gapMs: 20 },
    );

    expect(after.strokes).toBe(0);
    expect(after.view).toEqual({ scale: 1, tx: 0, ty: 0 });
  });

  test("two slow taps are not a double tap", async ({ page }) => {
    // Without this the test above would pass just as well with the timing
    // window ignored, i.e. with every second tap resetting the view.
    const g = await studio(page);
    const cx = g.cssW / 2;
    const cy = g.cssH / 2;
    await zoomCentre(page, 5);

    const after = await touch(
      page,
      [
        { type: "pointerdown", id: 1, x: cx, y: cy },
        { type: "pointerup", id: 1, x: cx, y: cy },
        { type: "pointerdown", id: 1, x: cx, y: cy },
        { type: "pointerup", id: 1, x: cx, y: cy },
      ],
      { finger: false, gapMs: 200 },
    );

    expect(after.view.scale).toBe(5);
  });
});
