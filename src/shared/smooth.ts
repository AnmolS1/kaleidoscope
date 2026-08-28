// Stroke smoothing — centripetal Catmull-Rom converted to cubic Béziers.
//
// Compiled by BOTH tsconfig.app.json and tsconfig.worker.json, so it may use
// only globals present in both runtimes: no DOM, no node builtins. This file
// needs nothing but Math.
//
// Why centripetal (α = 0.5) rather than uniform (α = 0) or chordal (α = 1):
// pointer sampling is uneven — a fast flick leaves points far apart, a slow
// curl leaves them bunched. Uniform Catmull-Rom reacts to that unevenness by
// overshooting and, where two points nearly coincide, forming a visible cusp or
// self-intersecting loop. Centripetal parameterization is the variant proven to
// produce neither, for any input spacing, which is what makes it safe to apply
// to strokes we did not sample ourselves.
//
// The output is deliberately per-segment: one cubic from pts[i] to pts[i+1],
// tagged with i. Width and spectrum hue already vary per segment in the polyline
// renderer and must keep varying identically, so the smoothed path preserves the
// same segment boundaries rather than collapsing the stroke into one long path.

/** A cubic Bézier from source point `i` to source point `i + 1`. */
export interface Cubic {
  /** Index of the source point this segment starts at. */
  i: number;
  /** First control point. */
  c1x: number;
  c1y: number;
  /** Second control point. */
  c2x: number;
  c2y: number;
  /** End point — equals the source point at `i + 1`. */
  x: number;
  y: number;
}

/** Centripetal exponent. α = 0.5 is the whole point; see the header. */
export const ALPHA = 0.5;

// Knot spans below this are treated as a coincident point. Coordinates are
// normalized to ~[-1,1] and capture already drops moves under ~1.1px, so this
// only fires on hand-authored or pathological input — where its only job is to
// keep the arithmetic finite instead of producing NaN, which renders as nothing
// at all.
const EPS = 1e-9;

/** Centripetal knot span between two points: |P1 - P0|^α, with α = 0.5. */
function knotSpan(ax: number, ay: number, bx: number, by: number): number {
  const d = Math.sqrt(Math.hypot(bx - ax, by - ay));
  return d < EPS ? EPS : d;
}

/**
 * Build the smoothed path for a stroke's points.
 *
 * Returns one cubic per source segment, in order. Fewer than 3 points has no
 * interior to smooth, so it returns `null` and the caller draws the polyline it
 * would have drawn anyway — matching the rule that v1 strokes, which never carry
 * `sm`, keep rendering as polylines forever.
 *
 * Tangents are computed once per POINT, as the knot-weighted average of the two
 * adjoining chord velocities, then scaled into each segment by that segment's
 * own knot span. Neighbouring segments therefore share a tangent direction while
 * having their own magnitude: the curve is G1 (visually smooth at every join)
 * rather than C1. Asserting C1 here would be asserting something false.
 *
 * The first and last points have only one neighbour, so they take the one-sided
 * chord velocity. NOTE: the plan specified "endpoints duplicated" instead.
 * Duplicating a point makes its knot span zero, which turns the interior tangent
 * formula into 0/0; clamping that with an epsilon yields a tangent of
 * approximately-but-not-exactly zero, so the first control point lands on
 * -0.6199999998797687 where it should be -0.62. That residue is both a flat
 * start to every stroke and a cross-platform parity hazard for the Swift port.
 * The one-sided chord is exact, non-degenerate, and the standard end condition.
 * Flagged for M1.
 */
export function smoothStroke(
  pts: ReadonlyArray<readonly [number, number, ...number[]]>,
): Cubic[] | null {
  const n = pts.length;
  if (n < 3) return null;

  // Knot span for each segment k → k+1.
  const span: number[] = new Array(n - 1);
  for (let k = 0; k < n - 1; k++) {
    span[k] = knotSpan(pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1]);
  }

  // Velocity (tangent per unit knot) at each point.
  const vx: number[] = new Array(n);
  const vy: number[] = new Array(n);

  vx[0] = (pts[1][0] - pts[0][0]) / span[0];
  vy[0] = (pts[1][1] - pts[0][1]) / span[0];
  vx[n - 1] = (pts[n - 1][0] - pts[n - 2][0]) / span[n - 2];
  vy[n - 1] = (pts[n - 1][1] - pts[n - 2][1]) / span[n - 2];

  for (let k = 1; k < n - 1; k++) {
    const dPrev = span[k - 1];
    const dNext = span[k];
    // Chord velocities either side of the point.
    const inX = (pts[k][0] - pts[k - 1][0]) / dPrev;
    const inY = (pts[k][1] - pts[k - 1][1]) / dPrev;
    const outX = (pts[k + 1][0] - pts[k][0]) / dNext;
    const outY = (pts[k + 1][1] - pts[k][1]) / dNext;
    // Weighted toward the SHORTER side, which is what keeps a tight corner from
    // being smoothed into a bulge that leaves the points' bounding box.
    const total = dPrev + dNext;
    vx[k] = (inX * dNext + outX * dPrev) / total;
    vy[k] = (inY * dNext + outY * dPrev) / total;
  }

  const out: Cubic[] = new Array(n - 1);
  for (let k = 0; k < n - 1; k++) {
    const d = span[k] / 3;
    out[k] = {
      i: k,
      c1x: pts[k][0] + vx[k] * d,
      c1y: pts[k][1] + vy[k] * d,
      c2x: pts[k + 1][0] - vx[k + 1] * d,
      c2y: pts[k + 1][1] - vy[k + 1] * d,
      x: pts[k + 1][0],
      y: pts[k + 1][1],
    };
  }
  return out;
}
