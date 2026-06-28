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
  it("rejects bad version", () => {
    expect(() => deserialize(JSON.stringify({ ...sample, v: 2 }))).toThrow(DrawingParseError);
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
