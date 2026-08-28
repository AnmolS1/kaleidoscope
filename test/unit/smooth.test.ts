import { describe, expect, it } from "vitest";
import { smoothStroke, type Cubic } from "../../src/shared/smooth";
import smoothFixture from "./fixtures/smooth.json";

type P = [number, number, number];

const near = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol;

/** Unit vector, or null for a degenerate (zero-length) tangent. */
function dir(dx: number, dy: number): [number, number] | null {
  const m = Math.hypot(dx, dy);
  return m < 1e-12 ? null : [dx / m, dy / m];
}

describe("smoothStroke", () => {
  // Smoothing is opt-in per stroke precisely so v1 work is untouched; a stroke
  // with too few points has no interior to smooth and must fall back.
  it("returns null below 3 points, so the caller draws a polyline", () => {
    expect(smoothStroke([])).toBeNull();
    expect(smoothStroke([[0, 0, 1]])).toBeNull();
    expect(smoothStroke([[0, 0, 1], [1, 1, 1]])).toBeNull();
  });

  it("emits one cubic per source segment, tagged with its start index", () => {
    const pts: P[] = [
      [0, 0, 1],
      [0.2, 0.3, 1],
      [0.5, 0.1, 1],
      [0.8, 0.4, 1],
    ];
    const cubics = smoothStroke(pts)!;
    expect(cubics).toHaveLength(3);
    expect(cubics.map((c) => c.i)).toEqual([0, 1, 2]);
  });

  // The whole point of interpolating (rather than approximating) splines: the
  // curve goes THROUGH the recorded points. If it did not, a smoothed stroke
  // would drift away from where the user drew.
  it("passes exactly through every recorded point", () => {
    const pts: P[] = [
      [-0.5, 0.2, 0.3],
      [-0.1, -0.3, 0.6],
      [0.25, 0.15, 0.9],
      [0.6, -0.2, 0.5],
      [0.9, 0.35, 0.2],
    ];
    const cubics = smoothStroke(pts)!;
    for (const c of cubics) {
      expect(near(c.x, pts[c.i + 1][0])).toBe(true);
      expect(near(c.y, pts[c.i + 1][1])).toBe(true);
    }
  });

  // Centripetal Catmull-Rom converted per-segment to Bézier is G1 continuous:
  // the tangent DIRECTION is shared at each junction, while the magnitude is
  // not (each segment is reparameterized to [0,1], scaling the tangent by its
  // own knot span). Direction continuity is what makes a join look smooth, so
  // that is the property worth asserting — asserting C1 here would be wrong.
  it("is tangent-direction continuous at interior joins", () => {
    const pts: P[] = [
      [0, 0, 1],
      [0.3, 0.4, 1],
      [0.55, 0.05, 1],
      [0.9, 0.3, 1],
      [1.2, -0.1, 1],
    ];
    const cubics = smoothStroke(pts)!;
    for (let k = 0; k < cubics.length - 1; k++) {
      const a = cubics[k];
      const b = cubics[k + 1];
      // Incoming tangent at the shared point, and outgoing from it.
      const incoming = dir(a.x - a.c2x, a.y - a.c2y);
      const outgoing = dir(b.c1x - a.x, b.c1y - a.y);
      expect(incoming).not.toBeNull();
      expect(outgoing).not.toBeNull();
      expect(near(incoming![0], outgoing![0], 1e-9)).toBe(true);
      expect(near(incoming![1], outgoing![1], 1e-9)).toBe(true);
    }
  });

  // Collinear input has no curvature to invent. A spline that bulged here would
  // visibly bend a deliberately straight stroke.
  it("keeps a straight stroke straight", () => {
    const pts: P[] = [
      [0, 0, 1],
      [0.25, 0.25, 1],
      [0.5, 0.5, 1],
      [0.75, 0.75, 1],
    ];
    for (const c of smoothStroke(pts)!) {
      // On the line y = x.
      expect(near(c.c1x, c.c1y, 1e-9)).toBe(true);
      expect(near(c.c2x, c.c2y, 1e-9)).toBe(true);
    }
  });

  // Centripetal parameterization (α = 0.5) is chosen over uniform precisely
  // because uniform overshoots and loops when spacing is uneven. Pin that:
  // control points must stay inside the bounding box of the points they span,
  // which a cusp or loop would leave.
  it("does not overshoot on very uneven spacing", () => {
    const pts: P[] = [
      [0, 0, 1],
      [0.02, 0.01, 1], // almost coincident with the previous point
      [0.9, 0.05, 1], // then a long jump
      [0.95, 0.9, 1],
    ];
    const cubics = smoothStroke(pts)!;
    const pad = 0.15;
    for (const c of cubics) {
      const [x0, y0] = pts[c.i];
      const [x1, y1] = pts[c.i + 1];
      const minX = Math.min(x0, x1) - pad;
      const maxX = Math.max(x0, x1) + pad;
      const minY = Math.min(y0, y1) - pad;
      const maxY = Math.max(y0, y1) + pad;
      for (const [cx, cy] of [
        [c.c1x, c.c1y],
        [c.c2x, c.c2y],
      ]) {
        expect(cx).toBeGreaterThanOrEqual(minX);
        expect(cx).toBeLessThanOrEqual(maxX);
        expect(cy).toBeGreaterThanOrEqual(minY);
        expect(cy).toBeLessThanOrEqual(maxY);
      }
    }
  });

  // Exactly coincident points make every knot span zero. Without the epsilon
  // guard this divides by zero and the whole stroke renders as NaN — i.e. not
  // at all. Uniform-spacing formulas hit this constantly; ours must not.
  it("stays finite when points coincide", () => {
    const pts: P[] = [
      [0.1, 0.1, 1],
      [0.1, 0.1, 1],
      [0.1, 0.1, 1],
      [0.4, 0.2, 1],
    ];
    const cubics = smoothStroke(pts)!;
    for (const c of cubics) {
      for (const n of [c.c1x, c.c1y, c.c2x, c.c2y, c.x, c.y]) {
        expect(Number.isFinite(n)).toBe(true);
      }
    }
  });

  // The golden the Swift port is held to. Regenerate with
  // `node --experimental-strip-types ios/tools/gen-smooth-fixture.ts` only when
  // the algorithm changes on purpose — Swift compares against these numbers.
  it("matches the shared golden fixture", () => {
    const cubics = smoothStroke(smoothFixture.points as P[])!;
    expect(cubics).toHaveLength(smoothFixture.cubics.length);
    cubics.forEach((c: Cubic, k: number) => {
      const want = smoothFixture.cubics[k];
      expect(c.i).toBe(want.i);
      for (const key of ["c1x", "c1y", "c2x", "c2y", "x", "y"] as const) {
        expect(near(c[key], want[key], 1e-12)).toBe(true);
      }
    });
  });
});
