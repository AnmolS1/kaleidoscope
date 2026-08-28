// Frozen v1 drawings used as render goldens across the v2 / layers migration.
//
// These exist to pin down ONE property: a drawing stored in the v1 format must
// render through exactly the same canvas operations after the layers rewrite as
// it did before it. Every existing gallery piece is v1 and its stored PNG was
// produced by the pre-rewrite path, so any drift here is a visible regression on
// real user work.
//
// Do not edit these fixtures. Adding a case is fine; changing one invalidates
// the golden it was captured against.

/** Serialized exactly as the v1 writer emits it (key order, rounding). */
export interface V1Fixture {
  name: string;
  /** Why this case is here — what would break if the render path drifted. */
  covers: string;
  json: string;
}

// Points are [x, y, pressure], normalized to the shorter half-axis, origin
// center. Pressure varies within strokes so the per-segment width modulation in
// brush.ts is exercised rather than a constant line width.
const solidArc = {
  tool: "solid",
  color: "#E84A27",
  size: 8,
  opacity: 1,
  pts: [
    [0.12, -0.62, 0.2],
    [0.2, -0.44, 0.45],
    [0.31, -0.28, 0.8],
    [0.4, -0.09, 1],
    [0.44, 0.12, 0.6],
    [0.39, 0.3, 0.25],
  ],
};

const spectrumSweep = {
  tool: "solid",
  color: "spectrum",
  size: 14,
  opacity: 0.85,
  pts: [
    [-0.55, -0.2, 0.5],
    [-0.36, -0.31, 0.7],
    [-0.14, -0.36, 0.9],
    [0.09, -0.3, 0.7],
    [0.28, -0.15, 0.5],
  ],
};

const glowRibbon = {
  tool: "glow",
  color: "#1D9E75",
  size: 22,
  opacity: 0.9,
  pts: [
    [-0.05, 0.7, 0.3],
    [0.14, 0.58, 0.65],
    [0.3, 0.4, 1],
    [0.41, 0.19, 0.65],
    [0.46, -0.03, 0.3],
  ],
};

// Overlaps glowRibbon deliberately: "lighter" compositing is only observable
// where a glow stroke crosses existing ink, which is what an offscreen
// per-layer buffer would silently change.
const glowCrossing = {
  tool: "glow",
  color: "#D9A521",
  size: 18,
  opacity: 0.75,
  pts: [
    [0.45, 0.55, 0.5],
    [0.26, 0.45, 0.8],
    [0.06, 0.42, 0.8],
    [-0.14, 0.48, 0.5],
  ],
};

const singleDot = {
  tool: "solid",
  color: "#2A2A6E",
  size: 30,
  opacity: 1,
  pts: [[-0.4, 0.4, 0.9]],
};

const v1 = (bg: string, segments: number, mirror: boolean, strokes: unknown[]) =>
  JSON.stringify({ v: 1, bg, sym: { segments, mirror }, strokes });

export const V1_FIXTURES: V1Fixture[] = [
  {
    name: "dihedral-9-light",
    covers:
      "D_9 (odd n, mirrored → 18 images), hex + spectrum strokes, per-segment " +
      "width from pressure, per-segment hue from position",
    json: v1("light", 9, true, [solidArc, spectrumSweep]),
  },
  {
    name: "cyclic-12-dark-glow",
    covers:
      "C_12 (no mirror), two overlapping glow strokes over a solid one — the " +
      '"lighter" composite against existing ink is the case an offscreen ' +
      "per-layer buffer would change",
    json: v1("dark", 12, false, [solidArc, glowRibbon, glowCrossing]),
  },
  {
    name: "dot-and-min-segments",
    covers:
      "the single-point dot path (arc/fill, not stroke) at the minimum segment " +
      "count, mirrored",
    json: v1("light", 3, true, [singleDot, solidArc]),
  },
  {
    name: "max-segments-24",
    covers: "C_24, the upper clamp bound, with a translucent spectrum stroke",
    json: v1("dark", 24, false, [spectrumSweep]),
  },
];
