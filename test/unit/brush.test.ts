// The shared path builder and the two capture-time flags it serves.
//
// `strokeSegments` is the single source of geometry for every output: live
// canvas, committed canvas, PNG/WebP/OG, SVG and replay. The tests here pin
// three things in one place, because splitting them is what would let the
// outputs drift apart:
//
//   1. the smoothed control points equal test/unit/fixtures/smooth.json — the
//      SAME golden the Swift port is held to, so web and iOS cannot diverge;
//   2. a stroke WITHOUT `sm` yields coordinates copied verbatim from `pts`,
//      which is the mechanism that keeps stored v1 work rendering as its saved
//      PNG (render-trace.test.ts pins the consequence; this pins the cause);
//   3. the same cubics reach the SVG exporter as `C` commands.

import { describe, expect, it } from "vitest";
import { drawStroke, meanPressure, strokeSegments } from "../../src/client/engine/brush";
import { exportSVG } from "../../src/client/engine/export";
import { pressureAlpha, type DrawingV2, type Pt, type Stroke } from "../../src/shared/vector";
import { recordingContext } from "./helpers/record-ctx";
import { V1_FIXTURES } from "./fixtures/v1-drawings";
import { deserialize } from "../../src/shared/vector";
import smoothFixture from "./fixtures/smooth.json";

const FIXTURE_PTS = smoothFixture.points as Pt[];

function stroke(over: Partial<Stroke> = {}): Stroke {
  return {
    tool: "solid",
    color: "#E84A27",
    size: 6,
    opacity: 1,
    pts: FIXTURE_PTS.map((p) => [...p] as Pt),
    ...over,
  };
}

function oneLayer(s: Stroke): DrawingV2 {
  return {
    v: 2,
    bg: "light",
    layers: [
      {
        id: "l1",
        name: "Layer 1",
        visible: true,
        opacity: 1,
        sym: { segments: 3, mirror: false },
        strokes: [s],
      },
    ],
  };
}

/** The recording context rounds to 1e-6 to kill cross-architecture ULP noise;
 *  an expected value has to be put through the same rounding to compare. */
function traced(v: number): number {
  const r = Math.round(v * 1e6) / 1e6;
  return Object.is(r, -0) ? 0 : r;
}

/** Trace `drawStroke` in isolation, at a round `half` so numbers stay readable. */
function trace(s: Stroke, half = 100): string[] {
  const { ctx, trace: t } = recordingContext();
  drawStroke(ctx, s, half);
  return t;
}

describe("strokeSegments — the shared path builder", () => {
  // THE Bézier fixture test. These exact control points are also the golden the
  // Swift renderer reproduces, so a change here is a cross-platform break.
  it("reproduces the smooth.json golden control points for an sm stroke", () => {
    const segs = strokeSegments(stroke({ sm: 1 }));
    expect(segs).toHaveLength(smoothFixture.cubics.length);
    segs.forEach((seg, k) => {
      const want = smoothFixture.cubics[k];
      expect(seg.i).toBe(want.i);
      expect(seg.c1x).toBeCloseTo(want.c1x, 15);
      expect(seg.c1y).toBeCloseTo(want.c1y, 15);
      expect(seg.c2x).toBeCloseTo(want.c2x, 15);
      expect(seg.c2y).toBeCloseTo(want.c2y, 15);
      expect(seg.x).toBeCloseTo(want.x, 15);
      expect(seg.y).toBeCloseTo(want.y, 15);
    });
  });

  // Not "approximately equal": IDENTICAL, by Object.is. Any arithmetic on this
  // path — even a multiply by 1 — could round differently from the loop this
  // replaced and move the frozen v1 trace.
  it("copies coordinates verbatim, with no arithmetic, when sm is absent", () => {
    const s = stroke();
    const segs = strokeSegments(s);
    expect(segs).toHaveLength(s.pts.length - 1);
    segs.forEach((seg, k) => {
      expect(seg.i).toBe(k);
      expect(Object.is(seg.x, s.pts[k + 1][0])).toBe(true);
      expect(Object.is(seg.y, s.pts[k + 1][1])).toBe(true);
      expect(seg.c1x).toBeUndefined();
      expect(seg.c2x).toBeUndefined();
    });
  });

  // `sm` asks for smoothing; two points have no interior to smooth. Falling
  // through to the straight case is what stops a two-point tap from rendering
  // through a different code path than the one that draws it today.
  it("falls back to straight segments when sm is set but there is no interior", () => {
    const two = strokeSegments(stroke({ sm: 1, pts: [[0, 0, 1], [0.5, 0.25, 1]] }));
    expect(two).toHaveLength(1);
    expect(two[0].c1x).toBeUndefined();
    expect(strokeSegments(stroke({ sm: 1, pts: [[0, 0, 1]] }))).toHaveLength(0);
    expect(strokeSegments(stroke({ sm: 1, pts: [] }))).toHaveLength(0);
  });

  // Width and spectrum hue vary per SOURCE segment. Smoothing changes the shape
  // between two points, never how many there are — so both paths must agree on
  // the segment count, or a smoothed stroke would be shaded differently.
  it("keeps the same segment boundaries as the polyline", () => {
    const straight = strokeSegments(stroke());
    const smooth = strokeSegments(stroke({ sm: 1 }));
    expect(smooth.map((s) => s.i)).toEqual(straight.map((s) => s.i));
    // Endpoints are interpolated, so they coincide exactly on both paths.
    smooth.forEach((s, k) => {
      expect(s.x).toBe(straight[k].x);
      expect(s.y).toBe(straight[k].y);
    });
  });
});

describe("drawStroke on canvas", () => {
  it("emits lineTo and never bezierCurveTo without sm", () => {
    const t = trace(stroke());
    expect(t.filter((op) => op.startsWith("lineTo("))).toHaveLength(4);
    expect(t.some((op) => op.startsWith("bezierCurveTo("))).toBe(false);
  });

  it("emits one bezierCurveTo per segment with sm, each opening its own path", () => {
    const t = trace(stroke({ sm: 1 }));
    expect(t.filter((op) => op.startsWith("bezierCurveTo("))).toHaveLength(4);
    expect(t.some((op) => op.startsWith("lineTo("))).toBe(false);
    // Per-segment paths, not one chained path: that is what lets lineWidth and
    // strokeStyle change along the stroke.
    expect(t.filter((op) => op === "beginPath()")).toHaveLength(4);
    expect(t.filter((op) => op === "stroke()")).toHaveLength(4);
  });

  it("scales the control points by half, like every other coordinate", () => {
    const t = trace(stroke({ sm: 1 }), 100);
    const c0 = smoothFixture.cubics[0];
    const n = (v: number) => Math.round(v * 100 * 1e6) / 1e6;
    expect(t).toContain(
      `bezierCurveTo(${n(c0.c1x)}, ${n(c0.c1y)}, ${n(c0.c2x)}, ${n(c0.c2y)}, ${n(c0.x)}, ${n(c0.y)})`,
    );
  });

  // The frozen v1 trace records every globalAlpha write, so this assignment has
  // to be absent — not merely equal to the previous value — when po is off.
  it("writes globalAlpha once per stroke without po, and once per segment with it", () => {
    const without = trace(stroke()).filter((op) => op.startsWith("globalAlpha ="));
    expect(without).toHaveLength(1);

    const withPo = trace(stroke({ po: 1 })).filter((op) => op.startsWith("globalAlpha ="));
    expect(withPo).toHaveLength(1 + 4); // brush mode, then one per segment
  });

  it("scales alpha by the segment's mean pressure under po", () => {
    const t = trace(stroke({ po: 1, opacity: 0.8 }));
    const meanFirst = (FIXTURE_PTS[0][2] + FIXTURE_PTS[1][2]) / 2;
    expect(t).toContain(`globalAlpha = ${traced(pressureAlpha(0.8, meanFirst))}`);
  });

  // Glow's ×0.7 is folded into the base alpha before pressure scales it, so the
  // two factors compose rather than one replacing the other.
  it("composes glow's 0.7 with po", () => {
    const t = trace(stroke({ po: 1, tool: "glow", opacity: 1 }));
    const meanFirst = (FIXTURE_PTS[0][2] + FIXTURE_PTS[1][2]) / 2;
    expect(t).toContain(`globalAlpha = ${traced(pressureAlpha(0.7, meanFirst))}`);
  });

  it("applies po to a single-point dot too", () => {
    const p: Pt = [0.2, -0.1, 0.4];
    const t = trace(stroke({ po: 1, opacity: 0.5, pts: [p] }));
    expect(t).toContain(`globalAlpha = ${traced(pressureAlpha(0.5, 0.4))}`);
    // and without po the dot keeps its historic value
    const plain = trace(stroke({ opacity: 0.5, pts: [p] }));
    expect(plain).toContain("globalAlpha = 0.5");
  });
});

/** The `d` attribute of the first <path>, so assertions cannot be satisfied or
 *  broken by unrelated markup such as the layer <title>. */
function pathD(svg: string): string {
  return /<path [^>]*\bd="([^"]*)"/.exec(svg)![1];
}

describe("SVG export goes through the same builder", () => {
  it("emits C commands carrying the golden control points", () => {
    const svg = exportSVG(oneLayer(stroke({ sm: 1 })), 500);
    const c0 = smoothFixture.cubics[0];
    const f = (v: number) => (v * 500).toFixed(2);
    expect(svg).toContain(
      `C${f(c0.c1x)} ${f(c0.c1y)} ${f(c0.c2x)} ${f(c0.c2y)} ${f(c0.x)} ${f(c0.y)}`,
    );
    // Scoped to the path data: the layer <title> is "Layer 1".
    expect(pathD(svg)).not.toContain("L"); // no straight segments left
  });

  it("emits an L-only polyline without sm", () => {
    const svg = exportSVG(oneLayer(stroke()), 500);
    expect(svg).not.toContain(" C");
    expect(svg).toContain(`M${(-0.62 * 500).toFixed(2)} ${(0.18 * 500).toFixed(2)}L`);
  });

  it("uses mean pressure for stroke-opacity under po, and leaves it alone otherwise", () => {
    const plain = exportSVG(oneLayer(stroke({ opacity: 0.6 })), 500);
    expect(plain).toContain('stroke-opacity="0.6"');

    const po = exportSVG(oneLayer(stroke({ po: 1, opacity: 0.6 })), 500);
    const want = String(Number(pressureAlpha(0.6, meanPressure(FIXTURE_PTS)).toFixed(4)));
    expect(po).toContain(`stroke-opacity="${want}"`);
    expect(po).not.toContain('stroke-opacity="0.6"');
  });

  // REVIEW.md minor mE3 — the canvas dims glow by x0.7 and the SVG did not, so
  // every glow stroke exported brighter than it was painted. `0.7` is written
  // out here rather than read from the source, so changing the constant fails
  // this test and forces the decision to be made again.
  it("folds glow's x0.7 into stroke-opacity, and composes it with po", () => {
    const glow = exportSVG(oneLayer(stroke({ tool: "glow", opacity: 0.6 })), 500);
    expect(glow).toContain(`stroke-opacity="${String(Number((0.6 * 0.7).toFixed(4)))}"`);

    // With `po` the two factors COMPOSE: pressure applies to the already-dimmed
    // alpha, which is what `poAlpha` does on the canvas. Applying pressure to
    // the stored 0.6 and dimming afterwards is a different number.
    const both = exportSVG(oneLayer(stroke({ tool: "glow", po: 1, opacity: 0.6 })), 500);
    const composed = String(Number(pressureAlpha(0.6 * 0.7, meanPressure(FIXTURE_PTS)).toFixed(4)));
    expect(both).toContain(`stroke-opacity="${composed}"`);

    // CONTROL: x0.7 belongs to glow alone.
    const solid = exportSVG(oneLayer(stroke({ opacity: 0.6 })), 500);
    expect(solid).toContain('stroke-opacity="0.6"');
  });

  it("means the pressure over every point", () => {
    expect(meanPressure(FIXTURE_PTS)).toBeCloseTo((0.2 + 0.55 + 0.8 + 1 + 0.45) / 5, 15);
    expect(meanPressure([])).toBe(1);
  });
});

// render-trace.test.ts freezes the CANVAS side for stored v1 work. This is the
// same guarantee for the SVG side, which that golden cannot see: re-implement
// the pre-T04 algorithm and require the shipped exporter to still agree with it
// on GEOMETRY and OPACITY, on the same four fixtures.
//
// 🔴 What this pins CHANGED, deliberately (REVIEW S9), and the reasoning is
// worth keeping.
//
// It used to require one `<path>` per stroke carrying the whole polyline. That
// is a statement about FILE STRUCTURE, not about what the drawing looks like,
// and it blocked the very thing this guarantee exists to protect: the canvas
// has always scaled stroke width by pressure and the SVG never did, so every
// export was the HEAVIEST possible version of the picture — about 48% fatter
// than the PNG at the default pressure. A single `<path>` carries one
// `stroke-width`, so a stroke whose pressure varies along its length cannot be
// one path.
//
// The replacement is STRICTER, not looser: each segment is checked against the
// exact pair of stored points it spans, so a drift is located rather than
// merely detected, and their union is still required to trace the legacy
// polyline. Nothing stored changes — the SVG is generated in the browser at
// download time. Settled with Anmol 2026-09-01.
//
// 🔴 It has now moved TWICE, so here is the promise it makes, written down
// rather than inferred from the assertions:
//
//   A stored v1 drawing exports to the SVG that best matches the PNG the same
//   drawing renders to. Where SVG cannot express what the canvas does, the SVG
//   approximates in the direction of the canvas — never away from it — and the
//   approximation is named in `exportSVG`'s header.
//
// That is the promise the S9 width fix served (the SVG was uniformly too fat)
// and the one mE3 serves (glow was uniformly too bright). It is NOT "the bytes
// of this file never change"; that version of the promise is what kept both
// defects alive, because every fix for them changes the bytes.
describe("stored v1 drawings export to an SVG that matches the PNG", () => {
  /** The path data the exporter produced before the shared builder existed. */
  function legacyPathData(pts: readonly Pt[], S: number): string {
    if (pts.length === 1) {
      const x = (pts[0][0] * S).toFixed(2);
      const y = (pts[0][1] * S).toFixed(2);
      return `M${x} ${y} L${x} ${y}`;
    }
    let d = "";
    pts.forEach(([nx, ny], i) => {
      d += `${i === 0 ? "M" : "L"}${(nx * S).toFixed(2)} ${(ny * S).toFixed(2)}`;
    });
    return d;
  }

  for (const fx of V1_FIXTURES) {
    it(`${fx.name}`, () => {
      const drawing = deserialize(fx.json);
      const strokes = drawing.layers[0].strokes;
      const svg = exportSVG(drawing, 500);

      // One GROUP per stroke, carrying that stroke's opacity.
      const groups = [...svg.matchAll(/<g id="l\ds\d+"[^>]*stroke-opacity="([^"]*)"[^>]*>(.*?)<\/g>/g)];
      expect(groups, `${fx.name}: one <g> per stroke`).toHaveLength(strokes.length);

      groups.forEach(([, so, inner], i) => {
        // The alpha the CANVAS paints this stroke at, which is the stored value
        // for every tool except glow — dimmed by x0.7 (REVIEW.md minor mE3).
        // The factor is spelled out rather than imported, so a change to it in
        // brush.ts fails here instead of silently propagating into the promise.
        const painted = strokes[i].tool === "glow" ? strokes[i].opacity * 0.7 : strokes[i].opacity;
        expect(so, `${fx.name} stroke ${i}: stroke-opacity`).toBe(
          String(Number(painted.toFixed(4))),
        );

        const pts = strokes[i].pts;
        const seg = [...inner.matchAll(/<path d="([^"]*)"/g)].map((m) => m[1]!);
        const f = (n: number): string => (n * 500).toFixed(2);

        if (pts.length === 1) {
          expect(seg, `${fx.name} stroke ${i}: a dot is one path`).toEqual([
            `M${f(pts[0][0])} ${f(pts[0][1])} L${f(pts[0][0])} ${f(pts[0][1])}`,
          ]);
          return;
        }

        // Per-segment geometry: every path spans exactly the pair of stored
        // points it should. STRICTER than the old single concatenated string,
        // which could not say WHICH segment had drifted.
        expect(seg, `${fx.name} stroke ${i}: one path per segment`).toHaveLength(pts.length - 1);
        seg.forEach((d, k) => {
          expect(d, `${fx.name} stroke ${i} segment ${k}`).toBe(
            `M${f(pts[k][0])} ${f(pts[k][1])}L${f(pts[k + 1][0])} ${f(pts[k + 1][1])}`,
          );
        });

        // And the union still traces the legacy polyline, so the SHAPE is
        // unchanged even though the encoding is not.
        const joined = seg.map((d, k) => (k === 0 ? d : d.slice(d.indexOf("L")))).join("");
        expect(joined, `${fx.name} stroke ${i}: same curve as before`).toBe(
          legacyPathData(pts, 500),
        );
      });
    });
  }

  // A v1 fixture with no strokes would make every assertion above vacuous.
  it("the fixtures actually contain strokes", () => {
    for (const fx of V1_FIXTURES) {
      expect(deserialize(fx.json).layers[0].strokes.length, fx.name).toBeGreaterThan(0);
    }
  });
});
