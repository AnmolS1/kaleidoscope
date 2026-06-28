import { describe, it, expect } from "vitest";
import { exportSVG } from "../../src/client/engine/export";
import { imageCount } from "../../src/client/engine/symmetry";
import type { Drawing } from "../../src/client/engine/strokes";

const drawing: Drawing = {
  v: 1,
  bg: "light",
  sym: { segments: 6, mirror: true },
  strokes: [
    { tool: "solid", color: "#E84A27", size: 4, opacity: 1, pts: [[0.1, 0.1, 1], [0.5, 0.2, 1]] },
    { tool: "glow", color: "spectrum", size: 8, opacity: 0.6, pts: [[0, 0, 1], [0.3, -0.3, 1]] },
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
    expect(uses).toHaveLength(drawing.strokes.length * imageCount(6, true)); // 2 * 12 = 24
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
