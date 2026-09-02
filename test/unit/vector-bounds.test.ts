// REVIEW.md M6 and M8 — numbers the parser waved through that the OTHER
// platform could not survive, and one that destroyed the drawing on re-save.

import { describe, it, expect } from "vitest";
import { deserialize, serialize, contentHash, MIN_SIZE, MAX_COORD } from "../../src/shared/vector";

const stroke = (over: Record<string, unknown> = {}) => ({
  tool: "solid",
  color: "#E84A27",
  size: 6,
  opacity: 1,
  pts: [[0, 0, 1], [0.1, 0.1, 1]],
  ...over,
});
const doc = (s: Record<string, unknown>) =>
  JSON.stringify({
    v: 2,
    bg: "light",
    layers: [{ id: "l1", name: "Layer 1", visible: true, opacity: 1, sym: { segments: 6, mirror: true }, strokes: [s] }],
  });

describe("coordinates and pressure are bounded on parse (M6)", () => {
  // Swift's `Int(...)` conversion TRAPS — uncatchably — above ~9.2e15, and the
  // worker stored the caller's bytes verbatim and served them back. So a single
  // POST published a gallery item that crash-looped every iOS client.
  for (const [name, pts] of [
    ["x beyond range", [[1e30, 0, 1]]],
    ["y beyond range", [[0, 1e30, 1]]],
    ["x at -1e30", [[-1e30, 0, 1]]],
    ["a huge value late in the stroke", [[0, 0, 1], [0.1, 0.1, 1], [0, 1e21, 1]]],
  ] as Array<[string, number[][]]>) {
    it(`rejects ${name}`, () => {
      expect(() => deserialize(doc(stroke({ pts })))).toThrow();
    });
  }

  it("rejects pressure outside 0..1, which was never range-checked at all", () => {
    expect(() => deserialize(doc(stroke({ pts: [[0, 0, 2]] })))).toThrow();
    expect(() => deserialize(doc(stroke({ pts: [[0, 0, -0.5]] })))).toThrow();
  });

  it("CONTROL: ordinary normalized coordinates still parse", () => {
    const d = deserialize(doc(stroke({ pts: [[-1, -1, 0], [0.5, 0.5, 1], [1, 1, 0.25]] })));
    expect(d.layers[0]!.strokes[0]!.pts).toHaveLength(3);
    // And the bound is not so tight it rejects a legitimately zoomed-out stroke.
    expect(() => deserialize(doc(stroke({ pts: [[MAX_COORD - 1, 0, 1]] })))).not.toThrow();
  });
});

describe("a stroke size below the rounding grid is refused (M8)", () => {
  // size serializes to 2dp. 0.004 is accepted, stored, and the first client to
  // re-save it writes `"size":0` — after which deserialize throws, /vector
  // 500s, iOS throws, and the hash backfill can never process it. Data loss,
  // from a value the parser said was fine.
  it("rejects a size that would serialize to zero", () => {
    expect(() => deserialize(doc(stroke({ size: 0.004 })))).toThrow();
    expect(() => deserialize(doc(stroke({ size: 0.0001 })))).toThrow();
  });

  it("CONTROL: the smallest representable size is still accepted", () => {
    expect(() => deserialize(doc(stroke({ size: MIN_SIZE })))).not.toThrow();
  });

  // The property the bound exists to guarantee, stated directly: serializing is
  // a FIXED POINT. Anything that parses can be written and re-read forever.
  it("serialize(deserialize(serialize(d))) === serialize(d) at the boundary", () => {
    for (const size of [MIN_SIZE, 0.01, 0.015, 6, 999]) {
      const once = serialize(deserialize(doc(stroke({ size }))));
      const twice = serialize(deserialize(once));
      expect(twice, `size ${size} must survive a re-save`).toBe(once);
    }
  });

  it("and the same for pressure, which shares the 2dp grid", () => {
    for (const p of [0, 0.004999999999999999, 0.005, 0.5, 1]) {
      const once = serialize(deserialize(doc(stroke({ pts: [[0, 0, p], [0.1, 0.1, p]] }))));
      expect(serialize(deserialize(once))).toBe(once);
    }
  });
});

// REVIEW.md S16 + S17 — two things that are the same picture must hash the
// same. Both required the content_hash re-backfill in migration 0006.
describe("the hash projection merges what the renderer cannot tell apart", () => {
  const layered = (over: Partial<{ opacity: number; sym2: number; po: 1; sm: 1 }> = {}) =>
    JSON.stringify({
      v: 2,
      bg: "light",
      layers: [
        { id: "l1", name: "a", visible: true, opacity: 1, sym: { segments: 6, mirror: true },
          strokes: [{ tool: "solid", color: "#E84A27", size: 6, opacity: 1,
                      pts: [[0, 0, 1], [0.1, 0.1, 1]], ...(over.po ? { po: 1 } : {}) }] },
        { id: "l2", name: "b", visible: true, opacity: over.opacity ?? 1,
          sym: { segments: over.sym2 ?? 6, mirror: true },
          strokes: [{ tool: "solid", color: "#1D9E75", size: 4, opacity: 1,
                      pts: [[0.2, 0.2, 1], [0.3, 0.3, 1]], ...(over.sm ? { sm: 1 } : {}) }] },
      ],
    });

  /** The same picture as `layered()`, drawn as one layer. */
  const flat = JSON.stringify({
    v: 2,
    bg: "light",
    layers: [
      { id: "l1", name: "only", visible: true, opacity: 1, sym: { segments: 6, mirror: true },
        strokes: [
          { tool: "solid", color: "#E84A27", size: 6, opacity: 1, pts: [[0, 0, 1], [0.1, 0.1, 1]] },
          { tool: "solid", color: "#1D9E75", size: 4, opacity: 1, pts: [[0.2, 0.2, 1], [0.3, 0.3, 1]] },
        ] },
    ],
  });

  it("S16: a stack that flattens hashes the same as its flattened form", async () => {
    expect(await contentHash(layered())).toBe(await contentHash(flat));
  });

  it("S16: and the conditions come from flattenToV1, so they move together", async () => {
    // Each of these is a reason flattenToV1 refuses, and each must therefore
    // keep the layered form distinct from the flat one.
    for (const [why, json] of [
      ["a different symmetry", layered({ sym2: 12 })],
      ["a layer below full opacity", layered({ opacity: 0.5 })],
      ["a pressure-opacity stroke", layered({ po: 1 })],
      ["a smoothed stroke", layered({ sm: 1 })],
    ] as Array<[string, string]>) {
      expect(await contentHash(json), why).not.toBe(await contentHash(flat));
    }
  });

  it("S17: hex colour case does not split a drawing in two", async () => {
    const upper = flat;
    const lower = flat.replace("#E84A27", "#e84a27").replace("#1D9E75", "#1d9e75");
    expect(await contentHash(upper)).toBe(await contentHash(lower));
  });

  it("CONTROL: genuinely different pictures still hash differently", async () => {
    const other = flat.replace("#1D9E75", "#1D9E76");
    expect(await contentHash(flat)).not.toBe(await contentHash(other));
  });

  it("CONTROL: the WIRE format is untouched — stored bytes keep their case", () => {
    expect(serialize(deserialize(flat))).toContain("#E84A27");
  });
});
