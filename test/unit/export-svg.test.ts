import { describe, it, expect } from "vitest";
import { exportSVG } from "../../src/client/engine/export";
import { imageCount } from "../../src/client/engine/symmetry";
import type { DrawingV2 } from "../../src/shared/vector";

const drawing: DrawingV2 = {
  v: 2,
  bg: "light",
  layers: [
    {
      id: "l1",
      name: "Layer 1",
      visible: true,
      opacity: 1,
      sym: { segments: 6, mirror: true },
      strokes: [
        { tool: "solid", color: "#E84A27", size: 4, opacity: 1, pts: [[0.1, 0.1, 1], [0.5, 0.2, 1]] },
        { tool: "glow", color: "spectrum", size: 8, opacity: 0.6, pts: [[0, 0, 1], [0.3, -0.3, 1]] },
      ],
    },
  ],
};

describe("exportSVG", () => {
  const svg = exportSVG(drawing);

  it("is a well-formed svg with a viewBox and background", () => {
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.includes('viewBox="-500 -500 1000 1000"')).toBe(true);
    expect(svg.includes('fill="#EEF0EC"')).toBe(true); // light bg rect
    expect(svg.trim().endsWith("</svg>")).toBe(true);
  });

  it("emits one <path> per stroke in defs", () => {
    const paths = svg.match(/<path /g) ?? [];
    expect(paths).toHaveLength(2);
  });

  it("emits one <use> per (stroke × symmetry image)", () => {
    const uses = svg.match(/<use /g) ?? [];
    expect(uses).toHaveLength(2 * imageCount(6, true)); // 2 * 12 = 24
  });

  it("resolves spectrum to a concrete hex (a path can't gradient)", () => {
    expect(svg.includes('stroke="spectrum"')).toBe(false);
  });

  it("marks glow strokes with screen blending", () => {
    expect(svg.includes("mix-blend-mode:screen")).toBe(true);
  });

  it("transforms mirrored images with scale(1,-1)", () => {
    expect(svg.includes("scale(1,-1)")).toBe(true);
  });
});

// ---- layers --------------------------------------------------------------

const layered: DrawingV2 = {
  v: 2,
  bg: "dark",
  layers: [
    {
      id: "l1",
      name: "Base",
      visible: true,
      opacity: 1,
      sym: { segments: 4, mirror: false },
      strokes: [
        { tool: "solid", color: "#1D9E75", size: 6, opacity: 1, pts: [[0.2, 0, 1], [0.6, 0.1, 0.5]] },
      ],
    },
    {
      id: "l2",
      // Names are user text: quotes and & must survive as XML metadata, not
      // break the document.
      name: 'Petals & "spikes"',
      visible: true,
      opacity: 0.5,
      sym: { segments: 7, mirror: true },
      strokes: [
        { tool: "glow", color: "#E84A27", size: 12, opacity: 0.8, pts: [[0, 0.3, 0.4], [0.25, 0.55, 1]] },
      ],
    },
    {
      id: "l3",
      name: "Hidden",
      visible: false,
      opacity: 1,
      sym: { segments: 3, mirror: false },
      strokes: [
        { tool: "solid", color: "#2A2A6E", size: 5, opacity: 1, pts: [[-0.4, -0.4, 1], [-0.1, -0.2, 1]] },
      ],
    },
  ],
};

describe("exportSVG with layers", () => {
  const svg = exportSVG(layered);

  it("matches the recorded structure for a 2-layer mixed-symmetry drawing", () => {
    expect(svg).toMatchSnapshot();
  });

  it("gives each visible layer a group carrying its opacity", () => {
    expect(svg.includes('<g opacity="1"')).toBe(true);
    expect(svg.includes('<g opacity="0.5"')).toBe(true);
  });

  // REVIEW.md minor mE2 — `<g opacity="1">` creates NO stacking context, so a
  // glow stroke in a multi-layer drawing blended through to the layers beneath
  // it. The canvas never allows that: anything but a single visible layer at
  // opacity 1 goes through a per-layer offscreen buffer.
  it("isolates every layer group when the canvas would use a buffer", () => {
    const groups = svg.match(/<g opacity="[^"]*"[^>]*>/g) ?? [];
    // Two visible layers here, so BOTH are isolated — including the one at
    // opacity 1, which is exactly the case that had no stacking context.
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.includes("isolation:isolate"))).toBe(true);
  });

  it("CONTROL: a single visible layer at opacity 1 is NOT isolated", () => {
    // The bypass. `paintDrawing` paints this drawing straight into the
    // destination so its glow blends against the background fill; isolating it
    // in the SVG would make the export differ from the PNG in the one case that
    // covers every piece in the live gallery.
    const single = exportSVG({ ...layered, layers: [layered.layers[0]] });
    expect(single.includes("isolation:isolate")).toBe(false);
  });

  it("CONTROL: one visible layer at opacity 0.9 IS isolated", () => {
    // Same layer count, different opacity — so the discriminator is the
    // predicate and not "how many layers are there".
    const dimmed = exportSVG({
      ...layered,
      layers: [{ ...layered.layers[0], opacity: 0.9 }],
    });
    expect(dimmed.includes("isolation:isolate")).toBe(true);
  });

  // REVIEW.md minor mE3 — the canvas dims glow by x0.7 and the SVG did not.
  it("glow carries the alpha the canvas paints it at, not the stored one", () => {
    // The glow stroke is stored at opacity 0.8; the canvas paints 0.8 * 0.7.
    expect(svg.includes('stroke-opacity="0.56"')).toBe(true);
    expect(svg.includes('stroke-opacity="0.8"')).toBe(false);
    // And formatted: 0.8 * 0.7 is 0.5600000000000001 in binary floating point.
    expect(svg.includes("0.5600000000000001")).toBe(false);
  });

  it("CONTROL: a solid stroke keeps its stored opacity character for character", () => {
    // x0.7 is glow's, not everyone's. The solid stroke on the base layer is
    // stored at 1 and must still say 1.
    expect(svg.includes('stroke-opacity="1"')).toBe(true);
  });

  it("uses each layer's own symmetry, not one global one", () => {
    const uses = svg.match(/<use /g) ?? [];
    // 1 stroke × C_4 on the base, 1 stroke × D_7 on the upper layer.
    expect(uses).toHaveLength(imageCount(4, false) + imageCount(7, true));
  });

  it("omits hidden layers entirely — path, group and all", () => {
    expect(svg.includes("#2A2A6E")).toBe(false);
    expect(svg.includes("Hidden")).toBe(false);
    expect(svg.includes('id="l3s0"')).toBe(false);
  });

  it("carries the layer name in a <title> only, XML-escaped", () => {
    expect(svg.includes("<title>Petals &amp; &quot;spikes&quot;</title>")).toBe(true);
    // The raw characters must not leak into the markup.
    expect(svg.includes('Petals & "spikes"')).toBe(false);
  });

  it("namespaces path ids per layer so two layers cannot collide", () => {
    expect(svg.includes('id="l1s0"')).toBe(true);
    expect(svg.includes('id="l2s0"')).toBe(true);
  });
});

// REVIEW.md S9 — the SVG ignored pressure entirely, so every export was the
// heaviest possible version of the drawing (~48% fatter than the PNG at the
// default pressure of 0.5). The PNG is unchanged; only the SVG moves.
describe("SVG stroke width follows pressure, like the canvas (S9)", () => {
  const pressured = (pts: Array<[number, number, number]>): DrawingV2 => ({
    v: 2,
    bg: "light",
    layers: [
      {
        id: "l1", name: "L", visible: true, opacity: 1,
        sym: { segments: 4, mirror: false },
        strokes: [{ tool: "solid", color: "#111111", size: 10, opacity: 1, pts }],
      },
    ],
  });
  const widths = (svg: string) =>
    [...svg.matchAll(/stroke-width="([\d.]+)"/g)].map((m) => Number(m[1]));

  it("a light stroke is thinner than a firm one of the same size", () => {
    const light = widths(exportSVG(pressured([[0, 0, 0.1], [0.2, 0, 0.1]])))[0]!;
    const firm = widths(exportSVG(pressured([[0, 0, 1], [0.2, 0, 1]])))[0]!;
    expect(light).toBeLessThan(firm);
  });

  it("width varies ALONG a stroke whose pressure changes", () => {
    const w = widths(exportSVG(pressured([[0, 0, 0.1], [0.1, 0, 0.5], [0.2, 0, 1]])));
    expect(w, "one width per segment").toHaveLength(2);
    expect(w[0]!).toBeLessThan(w[1]!);
  });

  it("matches the canvas formula 0.35 + 0.65p, which is what makes them agree", () => {
    const full = widths(exportSVG(pressured([[0, 0, 1], [0.2, 0, 1]])))[0]!;
    const none = widths(exportSVG(pressured([[0, 0, 0], [0.2, 0, 0]])))[0]!;
    expect(none / full).toBeCloseTo(0.35, 2);
  });
});
