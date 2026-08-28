import { describe, it, expect } from "vitest";
import {
  serialize,
  deserialize,
  toNormalized,
  toPixel,
  shouldKeepPoint,
  emptyDrawing,
  paletteOf,
  DrawingParseError,
  type Drawing,
  type Pt,
} from "../../src/client/engine/strokes";

const sample: Drawing = {
  v: 1,
  bg: "dark",
  sym: { segments: 12, mirror: true },
  strokes: [
    {
      tool: "solid",
      color: "#E84A27",
      size: 4,
      opacity: 1,
      pts: [
        [0.123456, -0.654321, 0.5],
        [0.2, 0.2, 0.9],
      ],
    },
    {
      tool: "glow",
      color: "spectrum",
      size: 8.5,
      opacity: 0.6,
      pts: [[0, 0, 1]],
    },
  ],
};

describe("serialize / deserialize round-trip", () => {
  it("round-trips structurally, rounding coords to 3 decimals", () => {
    const back = deserialize(serialize(sample));
    expect(back.bg).toBe("dark");
    expect(back.sym).toEqual({ segments: 12, mirror: true });
    expect(back.strokes).toHaveLength(2);
    // coords rounded
    expect(back.strokes[0].pts[0]).toEqual([0.123, -0.654, 0.5]);
    expect(back.strokes[1].color).toBe("spectrum");
  });

  it("is idempotent (serialize∘deserialize∘serialize == serialize)", () => {
    const once = serialize(sample);
    const twice = serialize(deserialize(once));
    expect(twice).toBe(once);
  });
});

describe("deserialize validation", () => {
  it("rejects invalid JSON", () => {
    expect(() => deserialize("{not json")).toThrow(DrawingParseError);
  });
  it("rejects an unknown version", () => {
    expect(() => deserialize(JSON.stringify({ ...sample, v: 3 }))).toThrow(DrawingParseError);
  });

  // The v1 surface now sits on the shared v2 format, so a v2 document that
  // flattens faithfully is readable through it. One layer at opacity 1 with no
  // `sm`/`po` strokes is exactly that case.
  it("accepts a v2 drawing that flattens to v1", () => {
    const v2 = JSON.stringify({
      v: 2,
      bg: "dark",
      layers: [
        {
          id: "l1",
          name: "Layer 1",
          visible: true,
          opacity: 1,
          sym: { segments: 12, mirror: true },
          strokes: sample.strokes,
        },
      ],
    });
    const back = deserialize(v2);
    expect(back.v).toBe(1);
    expect(back.sym).toEqual({ segments: 12, mirror: true });
    expect(back.strokes).toHaveLength(2);
  });

  // ...and one that cannot be represented in v1 must fail loudly rather than
  // hand back a drawing that would render differently from what was stored.
  it("rejects a v2 drawing that cannot flatten (mixed symmetry)", () => {
    const layer = (id: string, segments: number) => ({
      id,
      name: `Layer ${id}`,
      visible: true,
      opacity: 1,
      sym: { segments, mirror: true },
      strokes: sample.strokes,
    });
    const v2 = JSON.stringify({ v: 2, bg: "dark", layers: [layer("l1", 12), layer("l2", 6)] });
    expect(() => deserialize(v2)).toThrow(DrawingParseError);
  });
  it("rejects bad bg", () => {
    expect(() => deserialize(JSON.stringify({ ...sample, bg: "blue" }))).toThrow(DrawingParseError);
  });
  it("rejects bad color", () => {
    const bad = { ...sample, strokes: [{ ...sample.strokes[0], color: "red" }] };
    expect(() => deserialize(JSON.stringify(bad))).toThrow(DrawingParseError);
  });
  it("rejects malformed points", () => {
    const bad = { ...sample, strokes: [{ ...sample.strokes[0], pts: [[1, 2]] }] };
    expect(() => deserialize(JSON.stringify(bad))).toThrow(DrawingParseError);
  });
  it("rejects out-of-range opacity", () => {
    const bad = { ...sample, strokes: [{ ...sample.strokes[0], opacity: 2 }] };
    expect(() => deserialize(JSON.stringify(bad))).toThrow(DrawingParseError);
  });
});

describe("coordinate transforms", () => {
  it("normalizes center to origin", () => {
    expect(toNormalized(500, 400, 1000, 800)).toEqual({ x: 0, y: 0 });
  });
  it("uses the shorter half-axis", () => {
    // width 1000, height 800 -> half = 400. Point at x=900 -> (900-500)/400 = 1.0
    expect(toNormalized(900, 400, 1000, 800).x).toBeCloseTo(1.0);
  });
  it("round-trips pixel <-> normalized", () => {
    const { x, y } = toNormalized(720, 310, 1280, 720);
    const back = toPixel(x, y, 1280, 720);
    expect(back.x).toBeCloseTo(720);
    expect(back.y).toBeCloseTo(310);
  });
});

describe("shouldKeepPoint", () => {
  it("always keeps the first point", () => {
    expect(shouldKeepPoint(undefined, [0, 0, 1], 0.01)).toBe(true);
  });
  it("drops points closer than the threshold", () => {
    const prev: Pt = [0, 0, 1];
    expect(shouldKeepPoint(prev, [0.005, 0, 1], 0.01)).toBe(false);
    expect(shouldKeepPoint(prev, [0.02, 0, 1], 0.01)).toBe(true);
  });
});

describe("helpers", () => {
  it("emptyDrawing has no strokes", () => {
    expect(emptyDrawing("light", { segments: 6, mirror: false }).strokes).toHaveLength(0);
  });
  it("paletteOf collects hex colors, excludes spectrum", () => {
    expect(paletteOf(sample)).toEqual(["#E84A27"]);
  });
});
