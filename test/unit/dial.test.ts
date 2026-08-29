// The symmetry dial's angle mapping, both directions.
//
// These import the SAME functions the component renders with, so a mapping
// that drifts here drifts on screen. The coordinates in `ARTBOARD` are copied
// off `kaleidoscope-plan/design/src/Dial.dc.html` rather than computed from
// `angleFor`, which is the whole point: a test that derived its expectations
// from the code under test would agree with any self-consistent mapping,
// including a mirrored or rotated one.

import { describe, it, expect } from "vitest";
import {
  MIN_SEGMENTS,
  MAX_SEGMENTS,
  angleFor,
  pointFor,
  valueForAngle,
  valueForPoint,
} from "../../src/client/ui/SymmetryDial";

const ALL = Array.from({ length: MAX_SEGMENTS - MIN_SEGMENTS + 1 }, (_, i) => MIN_SEGMENTS + i);

/** Outer tick ends (r = 80) lifted verbatim from the `Dial` artboard. */
const ARTBOARD: [number, number, number][] = [
  [3, -40.0, 69.3],
  [6, -76.4, 23.6],
  [9, -72.1, -34.7],
  [12, -29.2, -74.5],
  [15, 29.2, -74.5],
  [18, 72.1, -34.7],
  [21, 76.4, 23.6],
  [24, 40.0, 69.3],
];

describe("dial geometry — forward (value → position)", () => {
  it("puts every labelled tick where the artboard puts it", () => {
    for (const [v, x, y] of ARTBOARD) {
      const p = pointFor(v, 80);
      expect(p.x, `x for ${v}`).toBeCloseTo(x, 1);
      expect(p.y, `y for ${v}`).toBeCloseTo(y, 1);
    }
  });

  it("sweeps 300° from −240°, so 3 is bottom-left and 24 bottom-right", () => {
    expect(angleFor(MIN_SEGMENTS)).toBe(-240);
    expect(angleFor(MAX_SEGMENTS)).toBe(60);
    // Bottom-left / bottom-right: both below the centre (y > 0 in SVG), on
    // opposite sides, and the gap between them is at the bottom.
    expect(pointFor(3, 80).y).toBeGreaterThan(0);
    expect(pointFor(24, 80).y).toBeGreaterThan(0);
    expect(pointFor(3, 80).x).toBeLessThan(0);
    expect(pointFor(24, 80).x).toBeGreaterThan(0);
  });

  it("is monotonic — the handle never doubles back as the count rises", () => {
    const angles = ALL.map(angleFor);
    for (let i = 1; i < angles.length; i++) expect(angles[i]).toBeGreaterThan(angles[i - 1]);
  });
});

describe("dial geometry — inverse (position → value)", () => {
  it("round-trips every one of the 22 counts", () => {
    for (const v of ALL) {
      const p = pointFor(v, 80);
      expect(valueForPoint(p.x, p.y), `round-trip ${v}`).toBe(v);
    }
  });

  it("reads the artboard's own tick coordinates back as their own value", () => {
    for (const [v, x, y] of ARTBOARD) {
      expect(valueForPoint(x, y), `artboard tick ${v}`).toBe(v);
    }
  });

  it("is radius-independent — the ring is a direction, not a distance", () => {
    for (const r of [34, 70, 80, 97, 400]) {
      const p = pointFor(15, r);
      expect(valueForPoint(p.x, p.y), `at r=${r}`).toBe(15);
    }
  });

  it("snaps the 60° gap below the dial to the nearer end, never across it", () => {
    // The gap runs from 24's angle (+60°) round to 3's (−240° ≡ +120°).
    expect(valueForAngle(61)).toBe(MAX_SEGMENTS);
    expect(valueForAngle(89)).toBe(MAX_SEGMENTS);
    expect(valueForAngle(91)).toBe(MIN_SEGMENTS);
    expect(valueForAngle(119)).toBe(MIN_SEGMENTS);
    // Straight down (+90°) is the midpoint; it must resolve, not produce NaN.
    expect([MIN_SEGMENTS, MAX_SEGMENTS]).toContain(valueForAngle(90));
  });

  it("never leaves the legal range, for any angle at all", () => {
    for (let deg = -720; deg <= 720; deg += 0.5) {
      const v = valueForAngle(deg);
      expect(Number.isInteger(v), `integer at ${deg}`).toBe(true);
      expect(v).toBeGreaterThanOrEqual(MIN_SEGMENTS);
      expect(v).toBeLessThanOrEqual(MAX_SEGMENTS);
    }
  });

  it("is unchanged by a full turn — the reading depends on direction only", () => {
    for (const deg of [-240, -180, -90, 0, 45, 60]) {
      expect(valueForAngle(deg + 360)).toBe(valueForAngle(deg));
      expect(valueForAngle(deg - 360)).toBe(valueForAngle(deg));
    }
  });
});

describe("dial geometry — the label radius clears the handle radially", () => {
  // A FLOOR ON `LABEL_R`, and nothing more. It works out to the same constant
  // at every tick (the two radii are concentric), so it is blind to which label
  // and to how wide its glyphs are — which is why "24" can still be the tight
  // one. The clearance that actually decides the question is measured against
  // real glyph boxes with the real face loaded, in `test/e2e/dial.spec.ts`.
  const HANDLE_PAINTED_R = 9 + 2 / 2; // r=9 plus half the 2px crane ring

  it("puts the labels far enough out that the handle cannot reach their centres", () => {
    for (const [v] of ARTBOARD) {
      const h = pointFor(v, 80);
      const l = pointFor(v, 101);
      const gap = Math.hypot(l.x - h.x, l.y - h.y) - HANDLE_PAINTED_R;
      expect(gap, `clearance to label ${v}`).toBeGreaterThan(5);
    }
  });
});
