// Scene-level render guard for stored v1 drawings.
//
// test/unit/render-trace.test.ts pins the canvas operations that `paintStrokes`
// issues, but it calls that function directly. The v2 rewrite (T03) changes
// something it therefore cannot see: how `Scene` COMPOSITES those operations.
// Per-layer rendering goes through an offscreen buffer at the layer's opacity,
// and a glow stroke's "lighter" blend against transparent black in a buffer is
// not the same picture as the same stroke blended against the ink already on the
// art canvas. Hence the rule that a single layer at opacity 1 must bypass the
// composite entirely.
//
// The assertion here is self-relative rather than a stored baseline PNG: render
// each fixture through the live Scene, render it again straight onto a blank
// canvas in the same page, and require the two to be pixel-identical. That needs
// no baseline file (a missing one is auto-created, so a first CI run would pass
// having compared nothing) and it is identical on every platform, while still
// failing exactly when Scene's compositing starts altering stored work.

import { expect, test } from "@playwright/test";
import { V1_FIXTURES } from "../unit/fixtures/v1-drawings";

// Fixed so the canvas backing store, and therefore the render, is deterministic.
test.use({ viewport: { width: 1000, height: 760 }, deviceScaleFactor: 1 });

test.describe("stored v1 drawings render through Scene unchanged", () => {
  for (const fx of V1_FIXTURES) {
    test(`${fx.name}`, async ({ page }) => {
      await page.goto("/");
      await page.waitForSelector(".canvas-host canvas");

      const result = await page.evaluate(async (json: string) => {
        // Dynamic import resolves through Vite's module graph to the SAME
        // instances the app already loaded, so this drives the real Scene. The
        // paths are dev-server URLs, not module specifiers tsc can resolve, so
        // they go through a variable — which also makes the result `any`.
        const load = (p: string): Promise<any> => import(/* @vite-ignore */ p);
        const S = await load("/src/client/state.ts");
        const { paintStrokes } = await load("/src/client/engine/scene.ts");
        const { deserialize, halfAxis } = await load("/src/shared/vector.ts");

        const scene = S.scene.value;
        if (!scene) return { error: "scene not mounted" };

        const drawing = deserialize(json);
        scene.loadDrawing(drawing);

        // The three stacked canvases are grid / art / live; committed strokes
        // live on the middle one.
        const host = document.querySelector(".canvas-host")!;
        const art = host.querySelectorAll("canvas")[1] as HTMLCanvasElement;

        const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
        const cssW = art.width / dpr;
        const cssH = art.height / dpr;

        // Reference: the same strokes painted onto a blank surface of identical
        // geometry, with no compositing in between.
        const ref = document.createElement("canvas");
        ref.width = art.width;
        ref.height = art.height;
        const rctx = ref.getContext("2d")!;
        rctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        // Reference side deliberately calls paintStrokes, NOT paintDrawing: that
        // function is frozen by the op-level trace golden, so comparing against
        // it is comparing new compositing against pinned painting. Pointing both
        // sides at paintDrawing would make a regression inside paintDrawing
        // invisible here. v1 fixtures always have exactly one layer.
        const layer = drawing.layers[0];
        paintStrokes(rctx, layer.strokes, cssW, cssH, halfAxis(cssW, cssH), layer.sym);

        return {
          scene: art.toDataURL("image/png"),
          reference: ref.toDataURL("image/png"),
          strokes: drawing.layers[0].strokes.length,
          size: `${art.width}x${art.height}`,
        };
      }, fx.json);

      expect(result.error).toBeUndefined();
      // Guard against comparing two blank canvases, which would agree forever.
      expect(result.strokes).toBeGreaterThan(0);
      expect(result.scene!.length).toBeGreaterThan(2000);
      expect(result.scene).toBe(result.reference);
    });
  }

  // The comparison above is only meaningful if a genuine difference would show
  // up in it. Prove the observable discriminates by rendering a drawing that
  // differs from the fixture and requiring a mismatch.
  test("the pixel comparison detects a real difference", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".canvas-host canvas");

    const differs = await page.evaluate(async (json: string) => {
      const load = (p: string): Promise<any> => import(/* @vite-ignore */ p);
      const S = await load("/src/client/state.ts");
      const { paintStrokes } = await load("/src/client/engine/scene.ts");
      const { deserialize, halfAxis } = await load("/src/shared/vector.ts");

      const drawing = deserialize(json);
      S.scene.value.loadDrawing(drawing);

      const host = document.querySelector(".canvas-host")!;
      const art = host.querySelectorAll("canvas")[1] as HTMLCanvasElement;
      const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
      const cssW = art.width / dpr;
      const cssH = art.height / dpr;

      const ref = document.createElement("canvas");
      ref.width = art.width;
      ref.height = art.height;
      const rctx = ref.getContext("2d")!;
      rctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // One fewer symmetry image — a small but real render difference.
      const layer = drawing.layers[0];
      paintStrokes(rctx, layer.strokes, cssW, cssH, halfAxis(cssW, cssH), {
        segments: layer.sym.segments - 1,
        mirror: layer.sym.mirror,
      });

      return art.toDataURL("image/png") !== ref.toDataURL("image/png");
    }, V1_FIXTURES[0].json);

    expect(differs).toBe(true);
  });

  // The bypass only protects stored work if the composite path it is avoiding
  // genuinely differs. Split the same fixture across two layers at full opacity
  // and require the result NOT to match the single-layer render — otherwise the
  // tests above would pass just as well with the bypass deleted.
  test("the offscreen composite is a different path from the bypass", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".canvas-host canvas");

    const r = await page.evaluate(async (json: string) => {
      const load = (p: string): Promise<any> => import(/* @vite-ignore */ p);
      const { paintDrawing } = await load("/src/client/engine/scene.ts");
      const { deserialize, halfAxis } = await load("/src/shared/vector.ts");

      const one = deserialize(json);
      const strokes = one.layers[0].strokes;
      // Same ink, same order, same symmetry — only the layer split differs.
      const two = {
        ...one,
        layers: [
          { ...one.layers[0], strokes: strokes.slice(0, 1) },
          { ...one.layers[0], id: "l2", name: "Layer 2", strokes: strokes.slice(1) },
        ],
      };
      const half = 0.6;
      const faded = {
        ...one,
        layers: [{ ...one.layers[0], opacity: half }],
      };

      const paint = (d: any) => {
        const c = document.createElement("canvas");
        c.width = 600;
        c.height = 600;
        const ctx = c.getContext("2d")!;
        // Fill a background, as every export does: this is where a glow stroke
        // blended inside an empty buffer diverges most from one blended against
        // what is already there.
        ctx.fillStyle = "#13202A";
        ctx.fillRect(0, 0, 600, 600);
        paintDrawing(ctx, d, 600, 600, halfAxis(600, 600));
        return c.toDataURL("image/png");
      };

      return { one: paint(one), two: paint(two), faded: paint(faded), strokes: strokes.length };
    }, V1_FIXTURES.find((f) => f.name === "cyclic-12-dark-glow")!.json);

    // The fixture must actually have several glow strokes for this to mean
    // anything.
    expect(r.strokes).toBeGreaterThan(1);
    expect(r.two).not.toBe(r.one);
    expect(r.faded).not.toBe(r.one);
  });
});

// REVIEW.md S11 — the layer compositing buffer is now reused across layers and
// frames rather than allocated fresh each time (~22MB per surface at iPad DPR,
// roughly 5GB/s of immediate garbage at 60fps with four layers).
//
// The whole risk of reusing a surface is stale pixels, so that is what this
// checks, with REAL pixels in a real browser: render a drawing, render a
// different one through the same buffer, render the first again, and require
// the two renders of it to be byte-identical.
test("the reused layer buffer leaves no residue", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector(".canvas-host canvas");

  const render = (json: string) =>
    page.evaluate(async (j: string) => {
      const load = (p: string): Promise<any> => import(/* @vite-ignore */ p);
      const S = await load("/src/client/state.ts");
      const { deserialize } = await load("/src/shared/vector.ts");
      const scene = S.scene.value;
      if (!scene) throw new Error("scene not mounted");
      scene.loadDrawing(deserialize(j));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const art = document.querySelector(".canvas-host")!.querySelectorAll("canvas")[1] as HTMLCanvasElement;
      return art.toDataURL("image/png");
    }, json);

  // Two layers at partial opacity is the case that takes the buffered path at
  // all: a single opaque layer uses the bypass and never allocates one.
  const mk = (color: string) =>
    JSON.stringify({
      v: 2,
      bg: "light",
      layers: [
        { id: "l1", name: "a", visible: true, opacity: 0.5, sym: { segments: 6, mirror: true },
          strokes: [{ tool: "solid", color, size: 8, opacity: 1, pts: [[-0.4, -0.4, 1], [0.4, 0.4, 1]] }] },
        { id: "l2", name: "b", visible: true, opacity: 0.5, sym: { segments: 4, mirror: false },
          strokes: [{ tool: "solid", color, size: 8, opacity: 1, pts: [[0.2, -0.3, 1], [-0.2, 0.3, 1]] }] },
      ],
    });

  const alone = await render(mk("#E84A27"));
  await render(mk("#1D9E75")); // dirty the shared buffer with different ink
  const after = await render(mk("#E84A27"));

  expect(after, "a reused buffer must not carry the previous drawing's pixels").toBe(alone);
  // And the control: the two drawings really do differ, so equality above means
  // something. Without this, a renderer that drew nothing would pass.
  const other = await render(mk("#1D9E75"));
  expect(other).not.toBe(alone);
});
