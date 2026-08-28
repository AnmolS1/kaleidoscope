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
        const { deserialize, halfAxis } = await load("/src/client/engine/strokes.ts");

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
        paintStrokes(rctx, drawing.strokes, cssW, cssH, halfAxis(cssW, cssH), drawing.sym);

        return {
          scene: art.toDataURL("image/png"),
          reference: ref.toDataURL("image/png"),
          strokes: drawing.strokes.length,
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
      const { deserialize, halfAxis } = await load("/src/client/engine/strokes.ts");

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
      paintStrokes(rctx, drawing.strokes, cssW, cssH, halfAxis(cssW, cssH), {
        segments: drawing.sym.segments - 1,
        mirror: drawing.sym.mirror,
      });

      return art.toDataURL("image/png") !== ref.toDataURL("image/png");
    }, V1_FIXTURES[0].json);

    expect(differs).toBe(true);
  });
});
