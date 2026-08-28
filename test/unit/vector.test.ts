import { describe, expect, it } from "vitest";
// ?raw keeps the exact stored bytes; parsing and re-stringifying would prove
// nothing about byte-for-byte fidelity.
import prodVector from "../../ios/KaleidoEngine/Tests/KaleidoEngineTests/Fixtures/prod-vector.json?raw";
import {
  contentHash,
  deserialize,
  DrawingParseError,
  emptyDrawing,
  flattenToV1,
  MAX_LAYER_NAME,
  MAX_POINTS_TOTAL,
  MAX_STROKES_TOTAL,
  nextLayerId,
  normalizeLayerName,
  paletteOf,
  serialize,
  serializeForHash,
  serializeV1,
  topSym,
  VECTOR_HARD_CAP_BYTES,
  applyPressureGamma,
  pressureAlpha,
  type DrawingV2,
  type Layer,
  type Stroke,
} from "../../src/shared/vector";

const stroke = (over: Partial<Stroke> = {}): Stroke => ({
  tool: "solid",
  color: "#E84A27",
  size: 6,
  opacity: 1,
  pts: [
    [0.1, -0.2, 0.5],
    [0.3, 0.4, 0.9],
  ],
  ...over,
});

const layer = (over: Partial<Layer> = {}): Layer => ({
  id: "l1",
  name: "Layer 1",
  visible: true,
  opacity: 1,
  sym: { segments: 12, mirror: true },
  strokes: [stroke()],
  ...over,
});

const drawing = (layers: Layer[], bg: "light" | "dark" = "dark"): DrawingV2 => ({
  v: 2,
  bg,
  layers,
});

const j = (d: DrawingV2) => serialize(d);

describe("v1 interop", () => {
  const v1 = JSON.stringify({
    v: 1,
    bg: "dark",
    sym: { segments: 12, mirror: true },
    strokes: [stroke()],
  });

  it("upgrades a v1 drawing to exactly one full-opacity visible layer", () => {
    const d = deserialize(v1);
    expect(d.v).toBe(2);
    expect(d.layers).toHaveLength(1);
    expect(d.layers[0]).toMatchObject({
      id: "l1",
      name: "Layer 1",
      visible: true,
      opacity: 1,
      sym: { segments: 12, mirror: true },
    });
  });

  it("a fresh drawing starts as the same shape a v1 upgrade produces", () => {
    const fresh = emptyDrawing("dark", { segments: 12, mirror: true });
    const upgraded = deserialize(v1);
    expect(fresh.layers[0].id).toBe(upgraded.layers[0].id);
    expect(fresh.layers[0].name).toBe(upgraded.layers[0].name);
    expect(fresh.layers[0].visible).toBe(upgraded.layers[0].visible);
    expect(fresh.layers[0].opacity).toBe(upgraded.layers[0].opacity);
  });

  // The strongest available evidence that the upgrade path is lossless: a real
  // piece from the production gallery, not one we invented to pass.
  it("round-trips the real production vector byte-for-byte", () => {
    const original = prodVector.trim();
    const flat = flattenToV1(deserialize(original));
    expect(flat).not.toBeNull();
    expect(serializeV1(flat!)).toBe(original);
  });

  it("rejects an unsupported version", () => {
    expect(() => deserialize(JSON.stringify({ v: 3, bg: "dark", layers: [] }))).toThrow(
      DrawingParseError,
    );
  });
});

describe("serialize", () => {
  it("round-trips a v2 drawing byte-stably", () => {
    const d = drawing([
      layer({ strokes: [stroke({ po: 1 }), stroke({ sm: 1, color: "spectrum" })] }),
      layer({ id: "l2", name: "Glow", opacity: 0.4, sym: { segments: 6, mirror: false } }),
    ]);
    const once = j(d);
    expect(j(deserialize(once))).toBe(once);
  });

  it("omits po and sm unless set, so a plain stroke is byte-identical to v1", () => {
    const s = j(drawing([layer()]));
    expect(s).not.toContain('"po"');
    expect(s).not.toContain('"sm"');
    expect(s).toContain('"tool":"solid","color":"#E84A27","size":6,"opacity":1,"pts"');
  });

  it("emits po and sm as the literal 1 when set", () => {
    const s = j(drawing([layer({ strokes: [stroke({ po: 1, sm: 1 })] })]));
    expect(s).toContain('"opacity":1,"po":1,"sm":1,"pts"');
  });

  it("normalizes -0 to 0", () => {
    const d = drawing([layer({ strokes: [stroke({ pts: [[-0.0001, -0.0004, 0]] })] })]);
    const s = j(d);
    expect(s).not.toContain("-0");
    expect(s).toContain("[0,0,0]");
  });

  it("rounds coords to 3dp, pressure 2dp, size 2dp, opacity 3dp", () => {
    const d = drawing([
      layer({
        opacity: 0.123456,
        strokes: [stroke({ size: 6.789, opacity: 0.987654, pts: [[0.123456, -0.654321, 0.567]] })],
      }),
    ]);
    const s = j(d);
    expect(s).toContain('"opacity":0.123'); // layer opacity, 3dp
    expect(s).toContain('"size":6.79'); // 2dp
    expect(s).toContain('"opacity":0.988'); // stroke opacity, 3dp
    expect(s).toContain("[0.123,-0.654,0.57]"); // coords 3dp, pressure 2dp
  });

  it("rejects a point that is not a 3-tuple, leaving room for a future tilt tuple", () => {
    const bad = JSON.stringify({
      v: 2,
      bg: "dark",
      layers: [{ ...layer(), strokes: [{ ...stroke(), pts: [[0.1, 0.2, 0.5, 0.1, 0.2]] }] }],
    });
    expect(() => deserialize(bad)).toThrow(DrawingParseError);
  });

  it("rejects po or sm set to anything but 1", () => {
    for (const v of [true, 0, 2, "1"]) {
      const bad = JSON.stringify({
        v: 2,
        bg: "dark",
        layers: [{ ...layer(), strokes: [{ ...stroke(), po: v }] }],
      });
      expect(() => deserialize(bad)).toThrow(DrawingParseError);
    }
  });
});

describe("flattenToV1", () => {
  it("flattens a single full-opacity layer", () => {
    expect(flattenToV1(drawing([layer()]))).not.toBeNull();
  });

  it("flattens several layers that share one symmetry at opacity 1", () => {
    const flat = flattenToV1(
      drawing([layer(), layer({ id: "l2", name: "Two", strokes: [stroke(), stroke()] })]),
    );
    expect(flat).not.toBeNull();
    // Strokes concatenate bottom → top, which is the paint order.
    expect(flat!.strokes).toHaveLength(3);
  });

  it("refuses mixed symmetry — v1 has only one sym for the whole drawing", () => {
    const d = drawing([layer(), layer({ id: "l2", sym: { segments: 6, mirror: true } })]);
    expect(flattenToV1(d)).toBeNull();
  });

  // Folding layer opacity into each stroke is NOT equivalent: per-layer
  // compositing flattens the layer once and blends the result, so overlapping
  // strokes inside it do not darken each other. Per-stroke opacity would.
  it("refuses a layer below full opacity", () => {
    expect(flattenToV1(drawing([layer({ opacity: 0.5 })]))).toBeNull();
  });

  it("refuses po or sm — an old parser knows neither flag", () => {
    expect(flattenToV1(drawing([layer({ strokes: [stroke({ po: 1 })] })]))).toBeNull();
    expect(flattenToV1(drawing([layer({ strokes: [stroke({ sm: 1 })] })]))).toBeNull();
  });

  // A hidden layer contributes nothing to the picture, so it must not block a
  // flatten — the same reasoning that makes the hash ignore it.
  it("drops hidden layers rather than refusing", () => {
    const d = drawing([
      layer(),
      layer({ id: "l2", visible: false, opacity: 0.3, sym: { segments: 6, mirror: false } }),
    ]);
    const flat = flattenToV1(d);
    expect(flat).not.toBeNull();
    expect(flat!.strokes).toHaveLength(1);
  });
});

describe("contentHash — the render-equivalent projection", () => {
  const base = drawing([layer()]);

  const hash = (d: DrawingV2) => contentHash(j(d));

  it("ignores layer id and name", async () => {
    const renamed = drawing([layer({ id: "l3", name: "Something else entirely" })]);
    expect(await hash(renamed)).toBe(await hash(base));
  });

  it("ignores hidden layers entirely", async () => {
    const withHidden = drawing([
      layer(),
      layer({ id: "l2", visible: false, strokes: [stroke({ color: "#123456" })] }),
    ]);
    expect(await hash(withHidden)).toBe(await hash(base));
  });

  it("ignores key order in the stored JSON", async () => {
    const reordered = JSON.stringify({
      bg: "dark",
      layers: [
        {
          strokes: [{ pts: stroke().pts, opacity: 1, size: 6, color: "#E84A27", tool: "solid" }],
          sym: { mirror: true, segments: 12 },
          opacity: 1,
          visible: true,
          name: "Layer 1",
          id: "l1",
        },
      ],
      v: 2,
    });
    expect(await contentHash(reordered)).toBe(await hash(base));
  });

  it("changes with bg", async () => {
    expect(await hash(drawing([layer()], "light"))).not.toBe(await hash(base));
  });

  it("changes with layer opacity", async () => {
    expect(await hash(drawing([layer({ opacity: 0.5 })]))).not.toBe(await hash(base));
  });

  it("changes with sm", async () => {
    expect(await hash(drawing([layer({ strokes: [stroke({ sm: 1 })] })]))).not.toBe(await hash(base));
  });

  it("changes with po", async () => {
    expect(await hash(drawing([layer({ strokes: [stroke({ po: 1 })] })]))).not.toBe(await hash(base));
  });

  it("changes with layer order, which changes the picture", async () => {
    const a = layer({ strokes: [stroke({ color: "#111111" })] });
    const b = layer({ id: "l2", strokes: [stroke({ color: "#222222" })] });
    expect(await hash(drawing([a, b]))).not.toBe(await hash(drawing([b, a])));
  });

  it("is 64 lowercase hex characters", async () => {
    expect(await hash(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("projects away id, name and visible", () => {
    const projected = serializeForHash(drawing([layer()]));
    expect(projected).not.toContain('"id"');
    expect(projected).not.toContain('"name"');
    expect(projected).not.toContain('"visible"');
  });
});

describe("layer names", () => {
  it("accepts ordinary text and NFC-normalizes it", () => {
    // "e" + combining acute normalizes to the single scalar "é".
    expect(normalizeLayerName("éclat")).toBe("éclat");
  });

  it("accepts 40 UTF-16 code units and rejects 41", () => {
    expect(normalizeLayerName("a".repeat(MAX_LAYER_NAME))).toBe("a".repeat(MAX_LAYER_NAME));
    expect(normalizeLayerName("a".repeat(MAX_LAYER_NAME + 1))).toBeNull();
  });

  // Emoji outside the BMP cost two code units each, so 20 of them is exactly
  // the limit — the cap is on storage, not on perceived characters.
  it("counts emoji in UTF-16 code units", () => {
    expect(normalizeLayerName("🌀".repeat(20))).toBe("🌀".repeat(20));
    expect(normalizeLayerName("🌀".repeat(21))).toBeNull();
  });

  it("accepts quotes, which must survive JSON escaping", () => {
    const d = drawing([layer({ name: 'a "quoted" name 🌀' })]);
    expect(deserialize(j(d)).layers[0].name).toBe('a "quoted" name 🌀');
  });

  it("rejects control characters", () => {
    for (const ch of [" ", "", "\n", "", "", "", ""]) {
      expect(normalizeLayerName(`bad${ch}name`)).toBeNull();
    }
  });

  // A lone surrogate is not a character. Some JSON parsers pass it through and
  // others replace it with U+FFFD, which would silently change the stored bytes
  // and therefore the content hash.
  it("rejects a lone surrogate", () => {
    expect(normalizeLayerName("bad\uD800name")).toBeNull();
    expect(normalizeLayerName("bad\uDFFFname")).toBeNull();
    // A well-formed pair is fine.
    expect(normalizeLayerName("ok🌀name")).toBe("ok🌀name");
  });

  it("rejects a non-string", () => {
    expect(normalizeLayerName(42)).toBeNull();
    expect(normalizeLayerName(null)).toBeNull();
  });

  it("refuses to deserialize a drawing with a bad name", () => {
    const bad = JSON.stringify({
      v: 2,
      bg: "dark",
      layers: [{ ...layer(), name: "no pe" }],
    });
    expect(() => deserialize(bad)).toThrow(DrawingParseError);
  });
});

describe("caps", () => {
  const many = (n: number) => Array.from({ length: n }, () => stroke());

  it("rejects more than 8 layers", () => {
    const layers = Array.from({ length: 9 }, (_, i) => layer({ id: `l${i + 1}`, strokes: [] }));
    // Ids only go to l8, so build the JSON by hand to test the layer cap itself.
    const bad = JSON.stringify({
      v: 2,
      bg: "dark",
      layers: layers.map((l, i) => ({ ...l, id: `l${Math.min(i + 1, 8)}` })),
    });
    expect(() => deserialize(bad)).toThrow(/too many layers/);
  });

  it("requires at least one layer", () => {
    expect(() => deserialize(JSON.stringify({ v: 2, bg: "dark", layers: [] }))).toThrow(
      /no layers/,
    );
  });

  it("rejects duplicate layer ids", () => {
    const bad = JSON.stringify({
      v: 2,
      bg: "dark",
      layers: [layer(), layer()],
    });
    expect(() => deserialize(bad)).toThrow(/duplicate id/);
  });

  it("rejects an id outside l1..l8", () => {
    for (const id of ["l0", "l9", "layer1", "L1", ""]) {
      const bad = JSON.stringify({ v: 2, bg: "dark", layers: [{ ...layer(), id }] });
      expect(() => deserialize(bad)).toThrow(/bad id/);
    }
  });

  // The stroke and point budgets accumulate across ALL layers rather than per
  // layer — otherwise 8 layers would raise the real ceiling eightfold.
  it("accepts a large multi-layer drawing that stays under the byte cap", () => {
    const ok = JSON.stringify({
      v: 2,
      bg: "dark",
      layers: [
        { ...layer(), id: "l1", strokes: many(800) },
        { ...layer(), id: "l2", strokes: many(800) },
      ],
    });
    expect(ok.length).toBeLessThan(256 * 1024);
    expect(() => deserialize(ok)).not.toThrow();
  });

  // The byte cap is checked first (before JSON.parse, deliberately — parsing an
  // unbounded payload is the DoS). That ordering makes the stroke and point caps
  // UNREACHABLE: the smallest legal stroke is 64 bytes, so 5001 of them is 320KB,
  // already past the 256KB limit; 200001 points is 1.6MB. They are belt-and-
  // braces, not live limits.
  //
  // Asserting that relationship rather than describing it in a comment means
  // that raising the byte cap fails HERE, where the two now-live caps get looked
  // at, instead of quietly switching on two limits nothing has ever exercised.
  it("byte cap dominates the stroke and point caps, so raising it must revisit them", () => {
    const smallestStroke = JSON.stringify({
      tool: "glow",
      color: "spectrum",
      size: 1,
      opacity: 0,
      pts: [],
    }).length;
    expect((MAX_STROKES_TOTAL + 1) * smallestStroke).toBeGreaterThan(VECTOR_HARD_CAP_BYTES);

    const smallestPoint = "[0,0,0],".length;
    expect((MAX_POINTS_TOTAL + 1) * smallestPoint).toBeGreaterThan(VECTOR_HARD_CAP_BYTES);
  });

  it("rejects an oversized payload before parsing it", () => {
    const huge = JSON.stringify({
      v: 2,
      bg: "dark",
      layers: [{ ...layer(), strokes: many(4000) }],
    });
    expect(huge.length).toBeGreaterThan(256 * 1024);
    expect(() => deserialize(huge)).toThrow(/vector too large/);
  });

  it("rejects segments outside 3..24", () => {
    for (const segments of [2, 25, 0, -1, 3.5]) {
      const bad = JSON.stringify({
        v: 2,
        bg: "dark",
        layers: [{ ...layer(), sym: { segments, mirror: true } }],
      });
      expect(() => deserialize(bad)).toThrow(DrawingParseError);
    }
  });

  it("rejects a layer opacity outside 0..1", () => {
    for (const opacity of [-0.1, 1.5]) {
      const bad = JSON.stringify({ v: 2, bg: "dark", layers: [{ ...layer(), opacity }] });
      expect(() => deserialize(bad)).toThrow(DrawingParseError);
    }
  });
});

describe("derived metadata", () => {
  it("paletteOf unions hex colors across visible layers, in first-seen order", () => {
    const d = drawing([
      layer({ strokes: [stroke({ color: "#111111" }), stroke({ color: "spectrum" })] }),
      layer({ id: "l2", strokes: [stroke({ color: "#222222" }), stroke({ color: "#111111" })] }),
    ]);
    expect(paletteOf(d)).toEqual(["#111111", "#222222"]);
  });

  it("paletteOf skips hidden layers", () => {
    const d = drawing([
      layer({ strokes: [stroke({ color: "#111111" })] }),
      layer({ id: "l2", visible: false, strokes: [stroke({ color: "#222222" })] }),
    ]);
    expect(paletteOf(d)).toEqual(["#111111"]);
  });

  it("topSym returns the shared symmetry when layers agree", () => {
    expect(topSym(drawing([layer(), layer({ id: "l2" })]))).toEqual({ segments: 12, mirror: true });
  });

  // null is what makes a piece read as "layered" in gallery copy, alt text and
  // OG descriptions instead of claiming a fold count it does not have.
  it("topSym returns null when visible layers disagree", () => {
    const d = drawing([layer(), layer({ id: "l2", sym: { segments: 6, mirror: false } })]);
    expect(topSym(d)).toBeNull();
  });

  it("topSym ignores hidden layers when deciding agreement", () => {
    const d = drawing([
      layer(),
      layer({ id: "l2", visible: false, sym: { segments: 6, mirror: false } }),
    ]);
    expect(topSym(d)).toEqual({ segments: 12, mirror: true });
  });

  it("nextLayerId takes the lowest unused slot, so ids stay positional", () => {
    expect(nextLayerId([])).toBe("l1");
    expect(nextLayerId([{ id: "l1" }, { id: "l2" }])).toBe("l3");
    // A gap left by a removed layer is reused rather than skipped.
    expect(nextLayerId([{ id: "l1" }, { id: "l3" }])).toBe("l2");
  });

  it("nextLayerId throws once all 8 slots are taken", () => {
    const full = Array.from({ length: 8 }, (_, i) => ({ id: `l${i + 1}` }));
    expect(() => nextLayerId(full)).toThrow(DrawingParseError);
  });
});

describe("pressure", () => {
  it("applies the preset gamma at capture time", () => {
    expect(applyPressureGamma(0.5, "normal")).toBe(0.5);
    // Light (γ = 0.6) lifts mid pressures; Firm (γ = 1.6) suppresses them.
    expect(applyPressureGamma(0.5, "light")).toBeGreaterThan(0.5);
    expect(applyPressureGamma(0.5, "firm")).toBeLessThan(0.5);
  });

  it("leaves the endpoints fixed under every preset", () => {
    for (const preset of ["light", "normal", "firm"] as const) {
      expect(applyPressureGamma(0, preset)).toBe(0);
      expect(applyPressureGamma(1, preset)).toBe(1);
    }
  });

  it("floors pressure-driven alpha at a quarter so a stroke never vanishes", () => {
    expect(pressureAlpha(1, 0)).toBeCloseTo(0.25, 10);
    expect(pressureAlpha(1, 1)).toBeCloseTo(1, 10);
    expect(pressureAlpha(0.5, 0.5)).toBeCloseTo(0.5 * 0.625, 10);
  });
});
