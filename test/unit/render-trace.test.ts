// RENDER GOLDEN — captured 2026-08-28, before the v2 / layers rewrite (T03).
//
// Every piece in the live gallery is stored in the v1 vector format, and the PNG
// each one shows was rasterized by the pre-rewrite render path. So the v2
// migration has exactly one hard constraint on rendering: a v1 drawing must
// still issue the identical sequence of canvas operations afterwards. If that
// holds, every existing piece renders exactly as its stored PNG.
//
// The snapshots in __snapshots__/render-trace.test.ts.snap were recorded against
// the pre-rewrite engine. THEY ARE THE BASELINE AND MUST NOT BE REGENERATED to
// make a failing test pass — once overwritten, the pre-rewrite behavior cannot
// be recovered. A diff here means the rewrite changed how stored work renders;
// fix the renderer, not the snapshot.
//
// After T03 the only line that may change is the body of `renderV1`, which is
// re-pointed at the layer-aware painter (a v1 drawing upgrades to a single layer
// at opacity 1, which must bypass the offscreen composite). The trace it
// produces must not move.

import { describe, expect, it } from "vitest";
import { paintStrokes } from "../../src/client/engine/scene";
import { deserialize, halfAxis } from "../../src/client/engine/strokes";
import { V1_FIXTURES } from "./fixtures/v1-drawings";
import { recordingContext } from "./helpers/record-ctx";

// Fixed surface so the trace is independent of any real canvas.
const W = 800;
const H = 600;

/**
 * Render a stored v1 drawing and return the operation trace.
 *
 * THIS IS THE MIGRATION SEAM. T03 re-points the body at the layer-aware
 * renderer; the returned trace must stay byte-identical.
 */
function renderV1(json: string): string[] {
  const d = deserialize(json);
  const { ctx, trace } = recordingContext();
  paintStrokes(ctx, d.strokes, W, H, halfAxis(W, H), d.sym);
  return trace;
}

describe("v1 render golden (pre-v2-rewrite baseline)", () => {
  for (const fx of V1_FIXTURES) {
    it(`${fx.name} — ${fx.covers}`, () => {
      expect(renderV1(fx.json).join("\n")).toMatchSnapshot();
    });
  }

  // A trace that recorded nothing would snapshot as "" and match forever after,
  // which is a golden that verifies nothing. Assert each fixture actually drew.
  it("every fixture produces a non-trivial trace", () => {
    for (const fx of V1_FIXTURES) {
      const trace = renderV1(fx.json);
      expect(trace.length, `${fx.name} issued no operations`).toBeGreaterThan(50);
      expect(trace.some((op) => op.startsWith("stroke(") || op.startsWith("fill(")))
        .toBe(true);
    }
  });

  // The symmetry group determines how many times each stroke is painted; if that
  // count drifts the trace diff is enormous and hard to read, so name it here.
  it("paints each stroke once per symmetry image", () => {
    const cases: Array<[string, number]> = [
      ["dihedral-9-light", 9 * 2],
      ["cyclic-12-dark-glow", 12],
      ["dot-and-min-segments", 3 * 2],
      ["max-segments-24", 24],
    ];
    for (const [name, images] of cases) {
      const fx = V1_FIXTURES.find((f) => f.name === name)!;
      const strokes = deserialize(fx.json).strokes.length;
      const trace = renderV1(fx.json);
      // Two saves per (stroke × image) pair: paintStrokes opens one to scope the
      // image transform, and drawStroke opens a second to scope the brush mode.
      expect(trace.filter((op) => op === "save()").length).toBe(strokes * images * 2);
    }
  });
});
