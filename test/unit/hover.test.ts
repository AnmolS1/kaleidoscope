// The pen-hover ring's geometry (T07, DESIGN.md §3 "Hover ring").
//
// THE VACUOUS-PASS TRAP this file exists to close: "a ring appeared" is
// satisfied by drawing exactly one ring, and "N rings appeared" is satisfied by
// drawing N rings all stacked on top of each other at the pen. Both look right
// in a screenshot of a 1-fold drawing and are wrong everywhere else. So every
// count assertion below is paired with a DISTINCT-POSITION count, and the
// mirrored and unmirrored cases are checked together so the expected number
// actually differs between them.
//
// The DOM side — that these numbers reach real <circle> elements, and that
// hovering commits no ink — is test/e2e/hover.spec.ts.

import { describe, expect, it } from "vitest";
import {
  IDENTITY_VIEW,
  MIN_HOVER_RING_R,
  hoverRingsFor,
  type View,
} from "../../src/client/engine/scene";
import { imageCount } from "../../src/client/engine/symmetry";

const W = 1000;
const H = 760; // half-axis 380
const HALF = 380;

// Off-centre AND off every mirror axis. At (0, 0) all 2n images coincide, and
// anywhere on y = 0 each reflected image lands on its own rotation — either
// would make "distinct positions" collapse for reasons that have nothing to do
// with the code under test.
const P = { x: 0.31, y: 0.17 };

const key = (r: { x: number; y: number }) => `${r.x.toFixed(6)},${r.y.toFixed(6)}`;
const distinct = (rs: { x: number; y: number }[]) => new Set(rs.map(key)).size;

describe("hoverRingsFor — one ring per symmetry image", () => {
  const cases: [number, boolean][] = [
    [3, false],
    [3, true],
    [12, false],
    [12, true],
    [24, true],
  ];

  it.each(cases)("segments=%i mirror=%s emits imageCount rings", (segments, mirror) => {
    const rings = hoverRingsFor(P, { segments, mirror }, 24, IDENTITY_VIEW, W, H);
    expect(rings).toHaveLength(imageCount(segments, mirror));
  });

  it.each(cases)("segments=%i mirror=%s puts them in imageCount PLACES", (segments, mirror) => {
    const rings = hoverRingsFor(P, { segments, mirror }, 24, IDENTITY_VIEW, W, H);
    // The assertion the count alone cannot make: N rings drawn at one point
    // would pass the test above and fail this one.
    expect(distinct(rings)).toBe(imageCount(segments, mirror));
  });

  it("mirroring doubles the ring count — the two cases genuinely differ", () => {
    const c = hoverRingsFor(P, { segments: 12, mirror: false }, 24, IDENTITY_VIEW, W, H);
    const d = hoverRingsFor(P, { segments: 12, mirror: true }, 24, IDENTITY_VIEW, W, H);
    expect(c).toHaveLength(12);
    expect(d).toHaveLength(24);
    // A ring count that ignored `mirror` would satisfy either assertion above
    // on its own if the expected value were computed the same wrong way.
    expect(d.length).toBe(c.length * 2);
  });

  it("does NOT dedupe images that coincide on a mirror axis", () => {
    // On y = 0 every reflected image lands exactly on its rotation, so there
    // are 12 places for 24 images. The count still has to be 24: the ring set
    // describes the symmetry, not the pixels, and collapsing it here would make
    // the e2e count assertion silently position-dependent.
    const rings = hoverRingsFor({ x: 0.4, y: 0 }, { segments: 12, mirror: true }, 24, IDENTITY_VIEW, W, H);
    expect(rings).toHaveLength(24);
    expect(distinct(rings)).toBe(12);
  });
});

describe("hoverRingsFor — the ring under the pen", () => {
  it("marks exactly one ring primary, at the pen's own position", () => {
    const rings = hoverRingsFor(P, { segments: 12, mirror: true }, 24, IDENTITY_VIEW, W, H);
    const primary = rings.filter((r) => r.primary);
    expect(primary).toHaveLength(1);
    // Image 0 is the identity, so the opaque ring sits exactly where the nib is.
    expect(primary[0].x).toBeCloseTo(P.x * HALF + W / 2, 9);
    expect(primary[0].y).toBeCloseTo(P.y * HALF + H / 2, 9);
  });

  it("keeps the primary under the pen at a panned, zoomed view", () => {
    const view: View = { scale: 3, tx: -140, ty: 60 };
    const rings = hoverRingsFor(P, { segments: 6, mirror: false }, 24, view, W, H);
    const primary = rings.find((r) => r.primary)!;
    expect(primary.x).toBeCloseTo(view.tx + view.scale * (P.x * HALF + W / 2), 9);
    expect(primary.y).toBeCloseTo(view.ty + view.scale * (P.y * HALF + H / 2), 9);
  });
});

describe("hoverRingsFor — radius", () => {
  const radius = (size: number, view: Readonly<View> = IDENTITY_VIEW) =>
    hoverRingsFor(P, { segments: 4, mirror: false }, size, view, W, H)[0].r;

  it("is half the brush's on-screen width", () => {
    // drawStroke: width = size * (half / REFERENCE_HALF). Ring radius = half of
    // that, so the ring outlines the mark the brush is about to make.
    expect(radius(100)).toBeCloseTo((100 * (HALF / 1000)) / 2, 9);
  });

  it("scales with the zoom", () => {
    expect(radius(100, { scale: 4, tx: 0, ty: 0 })).toBeCloseTo(radius(100) * 4, 9);
  });

  it("floors small brushes so the ring is still a ring", () => {
    // The default brush is 6 → a 1.14px radius, thinner than the 1px stroke
    // drawing it. Documented deviation from a literal "brush-size ring".
    expect((6 * (HALF / 1000)) / 2).toBeLessThan(MIN_HOVER_RING_R);
    expect(radius(6)).toBe(MIN_HOVER_RING_R);
    // ...and the floor is a floor, not a constant.
    expect(radius(100)).toBeGreaterThan(MIN_HOVER_RING_R);
  });
});
