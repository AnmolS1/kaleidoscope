// The pan/zoom transform, as pure arithmetic.
//
// Scene applies this by calling ctx.translate/ctx.scale and inverts it when
// reading a pointer, both of which need a browser to exercise. The maths behind
// them does not, and it is where the interesting mistakes live: an inverse
// applied in the wrong direction, a zoom that drifts off its anchor, a
// decimation threshold that multiplies where it should divide. Those are pinned
// here cheaply, and again end-to-end through the real engine in
// test/e2e/zoom-pan.spec.ts.

import { describe, expect, it } from "vitest";
import {
  IDENTITY_VIEW,
  MAX_SCALE,
  MIN_SCALE,
  clampScale,
  clampView,
  drawingToScreen,
  isIdentityView,
  minPointDistance,
  screenToDrawing,
  zoomedView,
  type View,
} from "../../src/client/engine/scene";

const W = 1000;
const H = 760;

describe("clampScale", () => {
  it("holds the 1–8x range", () => {
    expect(clampScale(0.2)).toBe(MIN_SCALE);
    expect(clampScale(1)).toBe(1);
    expect(clampScale(4)).toBe(4);
    expect(clampScale(99)).toBe(MAX_SCALE);
    expect(MIN_SCALE).toBe(1);
    expect(MAX_SCALE).toBe(8);
  });

  it("falls back to 1x on a non-finite scale", () => {
    // A pinch with two fingers in the same place divides by zero; the view must
    // not become NaN, because every later comparison against it would be false
    // and the canvas would render nothing forever.
    expect(clampScale(NaN)).toBe(1);
    expect(clampScale(Infinity)).toBe(MAX_SCALE);
    expect(clampScale(-Infinity)).toBe(MIN_SCALE);
  });
});

describe("isIdentityView", () => {
  it("is true only with no zoom AND no pan", () => {
    expect(isIdentityView(IDENTITY_VIEW)).toBe(true);
    expect(isIdentityView({ scale: 1, tx: 0, ty: 0 })).toBe(true);
    expect(isIdentityView({ scale: 1, tx: 1, ty: 0 })).toBe(false);
    expect(isIdentityView({ scale: 1, tx: 0, ty: -1 })).toBe(false);
    expect(isIdentityView({ scale: 1.0001, tx: 0, ty: 0 })).toBe(false);
  });
});

describe("screenToDrawing / drawingToScreen", () => {
  const v: View = { scale: 4, tx: -1500, ty: -1140 };

  it("round-trips", () => {
    for (const [x, y] of [[0, 0], [500, 380], [123.5, -40]] as const) {
      const d = screenToDrawing(v, x, y);
      const back = drawingToScreen(v, d.x, d.y);
      expect(back.x).toBeCloseTo(x, 9);
      expect(back.y).toBeCloseTo(y, 9);
    }
  });

  it("DIVIDES by the scale — the direction the whole feature rests on", () => {
    // Centre-anchored 4x on a 1000x760 canvas. A point 100 screen px right of
    // centre is 25 drawing px right of centre, not 400.
    const d = screenToDrawing(v, W / 2 + 100, H / 2);
    expect(d.x).toBeCloseTo(W / 2 + 25, 9);
    expect(d.y).toBeCloseTo(H / 2, 9);
    // The mistake this guards against, named so it cannot be re-introduced
    // quietly: multiplying instead would give 400.
    expect(d.x).not.toBeCloseTo(W / 2 + 400, 3);
  });

  it("is the identity at the identity view", () => {
    expect(screenToDrawing(IDENTITY_VIEW, 12, 34)).toEqual({ x: 12, y: 34 });
  });
});

describe("zoomedView", () => {
  it("pins the drawing point under the anchor", () => {
    const start: View = { scale: 1, tx: 0, ty: 0 };
    const anchor = { x: 300, y: 200 };
    const before = screenToDrawing(start, anchor.x, anchor.y);
    const after = zoomedView(start, anchor.x, anchor.y, 3);
    expect(after.scale).toBe(3);
    const now = screenToDrawing(after, anchor.x, anchor.y);
    expect(now.x).toBeCloseTo(before.x, 9);
    expect(now.y).toBeCloseTo(before.y, 9);
  });

  it("centre-anchored zoom gives the translate the e2e test asserts", () => {
    const v = zoomedView(IDENTITY_VIEW, W / 2, H / 2, 4);
    expect(v).toEqual({ scale: 4, tx: -1.5 * W, ty: -1.5 * H });
  });

  it("does not creep once the scale clamps", () => {
    const at8 = zoomedView(IDENTITY_VIEW, 100, 100, 20);
    expect(at8.scale).toBe(MAX_SCALE);
    // Pinching further must be a no-op, not a slow pan: with the scale pinned,
    // recomputing the translate from a moving anchor would drift the drawing.
    expect(zoomedView(at8, 400, 50, 4)).toEqual(at8);
    const at1 = zoomedView(IDENTITY_VIEW, 100, 100, 0.01);
    expect(at1).toEqual(IDENTITY_VIEW);
  });

  it("survives a degenerate factor", () => {
    expect(zoomedView(IDENTITY_VIEW, 10, 10, NaN).scale).toBe(1);
    expect(zoomedView(IDENTITY_VIEW, 10, 10, 0).scale).toBe(1);
  });
});

describe("clampView", () => {
  it("leaves a centre-anchored zoom alone", () => {
    // The one property the e2e coordinate test depends on: nothing adjusts the
    // view behind its back.
    for (const s of [1, 2, 4, 8]) {
      const v = zoomedView(IDENTITY_VIEW, W / 2, H / 2, s);
      expect(clampView(v, W, H)).toEqual(v);
    }
  });

  it("keeps a sliver of the drawing on screen", () => {
    const pushed = clampView({ scale: 4, tx: -1e6, ty: 1e6 }, W, H);
    expect(pushed.scale).toBe(4);
    // Right edge of the drawing rect still inside the viewport…
    expect(pushed.tx + 4 * W).toBeCloseTo(48, 9);
    // …and its left edge on the far side.
    expect(pushed.ty).toBeCloseTo(H - 48, 9);
  });

  it("does NOT clamp an off-centre zoom", () => {
    // The regression this replaced: requiring the drawing's CENTRE to stay
    // visible pulls the view back on every zoom away from the middle, which
    // breaks the anchor and makes the edges of a piece unreachable at 8x —
    // exactly what zoom is for.
    const v = zoomedView(IDENTITY_VIEW, W / 2 + 150, H / 2 - 90, 8);
    expect(v.scale).toBe(8);
    expect(clampView(v, W, H)).toEqual(v);
    const centre = drawingToScreen(v, W / 2, H / 2);
    expect(centre.x).toBeLessThan(0); // the centre IS off screen, and that is fine
  });

  it("leaves an ordinary pan alone", () => {
    const v: View = { scale: 2, tx: -400, ty: -200 };
    expect(clampView(v, W, H)).toEqual(v);
  });

  it("recovers from a non-finite translate", () => {
    expect(clampView({ scale: 2, tx: NaN, ty: 0 }, W, H).tx).toBe(0);
  });
});

describe("minPointDistance", () => {
  const half = 380; // halfAxis(1000, 760)

  it("is ~1.1 px OF SCREEN at every zoom", () => {
    for (const scale of [1, 2, 4, 8]) {
      const screenPx = minPointDistance(half, scale) * half * scale;
      expect(screenPx).toBeCloseTo(1.1, 9);
    }
  });

  it("divides by the scale rather than multiplying", () => {
    // At 8x the threshold must SHRINK in drawing space, so that a small move of
    // the hand still records detail. Multiplying would demand a 8.8 px screen
    // move before storing anything and quantise the stroke visibly.
    const at1 = minPointDistance(half, 1);
    const at8 = minPointDistance(half, 8);
    expect(at8).toBeCloseTo(at1 / 8, 12);
    expect(at8).toBeLessThan(at1);
  });
});
