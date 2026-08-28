// Layer operations and hit-testing.
//
// Both live behind a canvas in the app, but neither needs one: the operations
// are pure transforms on a DrawingV2 and the hit test is pure geometry. Keeping
// them testable headlessly is why the document model sits in history.ts rather
// than inside the Scene class.
//
// (The one thing that genuinely cannot be tested here is offscreen layer
// compositing, which needs a real canvas. test/e2e/v1-render.spec.ts covers it.)

import { describe, it, expect } from "vitest";
import { DrawingDoc, defaultLayerName } from "../../src/client/engine/history";
import { hitTestDrawing } from "../../src/client/engine/scene";
import {
  MAX_LAYERS,
  emptyDrawing,
  serialize,
  deserialize,
  type DrawingV2,
  type Stroke,
} from "../../src/shared/vector";

const fresh = (): DrawingV2 => emptyDrawing("light", { segments: 12, mirror: true });

const stroke = (color: string, pts: Stroke["pts"]): Stroke => ({
  tool: "solid",
  color,
  size: 10,
  opacity: 1,
  pts,
});

describe("addLayer", () => {
  it("inserts above the active layer and inherits its symmetry", () => {
    const doc = new DrawingDoc(fresh(), 8);
    doc.setLayerSym(doc.activeLayerId, { segments: 5, mirror: false });
    const id = doc.addLayer()!;

    expect(doc.layers.map((l) => l.id)).toEqual(["l1", id]);
    expect(doc.activeLayerId).toBe(id);
    expect(doc.activeLayer.sym).toEqual({ segments: 5, mirror: false });
    expect(doc.activeLayer.strokes).toHaveLength(0);
    expect(doc.activeLayer.visible).toBe(true);
    expect(doc.activeLayer.opacity).toBe(1);
  });

  it("inserts above the ACTIVE layer, not on top of the stack", () => {
    const doc = new DrawingDoc(fresh(), 8);
    doc.addLayer(); // l2 on top
    doc.setActiveLayer("l1");
    const id = doc.addLayer()!;
    expect(doc.layers.map((l) => l.id)).toEqual(["l1", id, "l2"]);
  });

  it("names a layer from its positional id", () => {
    const doc = new DrawingDoc(fresh(), 8);
    const id = doc.addLayer()!;
    expect(doc.activeLayer.name).toBe(defaultLayerName(id));
    expect(doc.activeLayer.name).toBe("Layer 2");
  });

  it("reuses the lowest free id after a removal, so ids stay positional", () => {
    const doc = new DrawingDoc(fresh(), 8);
    doc.addLayer(); // l2
    doc.addLayer(); // l3
    doc.removeLayer("l2");
    expect(doc.addLayer()).toBe("l2");
  });

  it("refuses beyond the cap passed in from state", () => {
    const doc = new DrawingDoc(fresh(), 3);
    expect(doc.addLayer()).toBe("l2");
    expect(doc.addLayer()).toBe("l3");
    expect(doc.canAddLayer).toBe(false);
    expect(doc.addLayer()).toBeNull();
    expect(doc.layers).toHaveLength(3);
  });

  it("a raised cap takes effect immediately (buying Plus mid-session)", () => {
    const doc = new DrawingDoc(fresh(), 3);
    doc.addLayer();
    doc.addLayer();
    expect(doc.addLayer()).toBeNull();
    doc.setLayerCap(8);
    expect(doc.addLayer()).toBe("l4");
  });

  it("never exceeds the format's hard limit even if the cap says otherwise", () => {
    const doc = new DrawingDoc(fresh(), 99);
    for (let i = 1; i < MAX_LAYERS; i++) expect(doc.addLayer()).not.toBeNull();
    expect(doc.layers).toHaveLength(MAX_LAYERS);
    expect(doc.addLayer()).toBeNull();
  });
});

describe("the cap gates adding only", () => {
  // PLAN §1: a free account must be able to open, edit and save a piece with
  // more layers than its cap — that is what makes remixing a Plus piece work.
  it("loads, edits and serializes an over-cap drawing", () => {
    const big = new DrawingDoc(fresh(), 8);
    for (let i = 1; i < 6; i++) big.addLayer();
    expect(big.layers).toHaveLength(6);

    const free = new DrawingDoc(deserialize(serialize(big.drawing)), 3);
    expect(free.layers).toHaveLength(6);
    expect(free.canAddLayer).toBe(false);

    // editing still works
    expect(free.setLayerOpacity(free.activeLayerId, 0.5)).toBe(true);
    expect(free.commitStroke(stroke("#111111", [[0, 0, 1]]))).toBe(true);
    expect(free.removeLayer(free.activeLayerId)).toBe(true);
    expect(deserialize(serialize(free.drawing)).layers).toHaveLength(5);
  });
});

describe("removeLayer", () => {
  it("never goes below one layer", () => {
    const doc = new DrawingDoc(fresh(), 8);
    expect(doc.removeLayer("l1")).toBe(false);
    expect(doc.layers).toHaveLength(1);
  });

  it("moves the active layer to the slot the removed one occupied", () => {
    const doc = new DrawingDoc(fresh(), 8);
    doc.addLayer(); // l2
    doc.addLayer(); // l3, active, top
    doc.setActiveLayer("l2");
    doc.removeLayer("l2");
    // l2 sat at index 1; l3 now occupies it.
    expect(doc.activeLayerId).toBe("l3");
  });

  it("falls to the new top when the removed layer was the top", () => {
    const doc = new DrawingDoc(fresh(), 8);
    doc.addLayer(); // l2, active
    doc.removeLayer("l2");
    expect(doc.activeLayerId).toBe("l1");
  });
});

describe("duplicateLayer", () => {
  it("copies strokes, symmetry and opacity above the source and activates it", () => {
    const doc = new DrawingDoc(fresh(), 8);
    doc.setLayerSym("l1", { segments: 6, mirror: false });
    doc.commitStroke(stroke("#E84A27", [[0.1, 0.1, 1], [0.4, 0.2, 1]]));
    doc.setLayerOpacity("l1", 0.4);

    const id = doc.duplicateLayer("l1")!;
    expect(doc.layers.map((l) => l.id)).toEqual(["l1", id]);
    expect(doc.activeLayerId).toBe(id);
    const copy = doc.layers[1];
    expect(copy.sym).toEqual({ segments: 6, mirror: false });
    expect(copy.opacity).toBe(0.4);
    expect(copy.strokes).toHaveLength(1);
    expect(copy.name).toBe("Layer 1 copy");
  });

  it("keeps a duplicate's name storable, however long the original", () => {
    const doc = new DrawingDoc(fresh(), 8);
    doc.setLayerName("l1", "x".repeat(40));
    const id = doc.duplicateLayer("l1")!;
    const name = doc.layers.find((l) => l.id === id)!.name;
    expect(name.length).toBeLessThanOrEqual(40);
    // and the result still round-trips through the format
    expect(deserialize(serialize(doc.drawing)).layers).toHaveLength(2);
  });

  it("is refused at the cap", () => {
    const doc = new DrawingDoc(fresh(), 1);
    expect(doc.duplicateLayer("l1")).toBeNull();
  });

  it("does not alias the original's strokes", () => {
    const doc = new DrawingDoc(fresh(), 8);
    doc.commitStroke(stroke("#111111", [[0, 0, 1]]));
    doc.duplicateLayer("l1");
    doc.commitStroke(stroke("#222222", [[0.2, 0.2, 1]]));
    expect(doc.layers[0].strokes).toHaveLength(1);
    expect(doc.layers[1].strokes).toHaveLength(2);
  });
});

describe("moveLayer", () => {
  it("reorders bottom → top and clamps out-of-range targets", () => {
    const doc = new DrawingDoc(fresh(), 8);
    doc.addLayer(); // l2
    doc.addLayer(); // l3
    expect(doc.layers.map((l) => l.id)).toEqual(["l1", "l2", "l3"]);

    doc.moveLayer("l3", 0);
    expect(doc.layers.map((l) => l.id)).toEqual(["l3", "l1", "l2"]);

    doc.moveLayer("l3", 99);
    expect(doc.layers.map((l) => l.id)).toEqual(["l1", "l2", "l3"]);
  });

  it("refuses a move that changes nothing", () => {
    const doc = new DrawingDoc(fresh(), 8);
    doc.addLayer();
    expect(doc.moveLayer("l1", 0)).toBe(false);
    expect(doc.moveLayer("nope", 0)).toBe(false);
  });
});

describe("setAllSym", () => {
  it("applies one symmetry to every layer as a single undo step", () => {
    const doc = new DrawingDoc(fresh(), 8);
    doc.addLayer();
    doc.setLayerSym("l1", { segments: 5, mirror: false });
    expect(doc.setAllSym({ segments: 9, mirror: true })).toBe(true);
    expect(doc.layers.every((l) => l.sym.segments === 9 && l.sym.mirror)).toBe(true);
    doc.undo();
    expect(doc.layers[0].sym).toEqual({ segments: 5, mirror: false });
    expect(doc.layers[1].sym).toEqual({ segments: 12, mirror: true });
  });

  it("is a no-op when every layer already agrees", () => {
    const doc = new DrawingDoc(fresh(), 8);
    doc.addLayer();
    expect(doc.setAllSym({ segments: 12, mirror: true })).toBe(false);
    expect(doc.canUndo).toBe(true); // only the addLayer
  });
});

// ---- hit testing ---------------------------------------------------------

describe("hitTestDrawing", () => {
  // A horizontal stroke on the +x axis, well away from the center so the
  // symmetry images are far apart and a hit is unambiguous.
  const bar = stroke("#111111", [
    [0.4, 0, 0.5],
    [0.7, 0, 0.5],
  ]);

  function withStroke(sym: { segments: number; mirror: boolean }, s: Stroke): DrawingV2 {
    const d = emptyDrawing("light", sym);
    d.layers[0].strokes = [s];
    return d;
  }

  it("hits the stroke as drawn", () => {
    const d = withStroke({ segments: 4, mirror: false }, bar);
    expect(hitTestDrawing(d, 0.55, 0, 0.01)).toEqual({ layerId: "l1", index: 0 });
  });

  it("hits any of the rotated images, not just the one that was drawn", () => {
    const d = withStroke({ segments: 4, mirror: false }, bar);
    // C_4: the same bar appears at 90°, 180° and 270°.
    expect(hitTestDrawing(d, 0, 0.55, 0.01)).toEqual({ layerId: "l1", index: 0 });
    expect(hitTestDrawing(d, -0.55, 0, 0.01)).toEqual({ layerId: "l1", index: 0 });
    expect(hitTestDrawing(d, 0, -0.55, 0.01)).toEqual({ layerId: "l1", index: 0 });
  });

  it("hits a reflected image under a dihedral group", () => {
    const diagonal = stroke("#111111", [
      [0.4, 0.15, 0.5],
      [0.7, 0.25, 0.5],
    ]);
    const d = withStroke({ segments: 3, mirror: true }, diagonal);
    // The mirror image of the same stroke sits at negative y.
    expect(hitTestDrawing(d, 0.55, -0.2, 0.02)).toEqual({ layerId: "l1", index: 0 });
  });

  it("misses when the point is outside the stroke's reach", () => {
    const d = withStroke({ segments: 4, mirror: false }, bar);
    expect(hitTestDrawing(d, 0.55, 0.4, 0.01)).toBeNull();
    expect(hitTestDrawing(d, 0.95, 0, 0.01)).toBeNull();
  });

  it("hits a single-point stroke (a dot)", () => {
    const d = withStroke({ segments: 4, mirror: false }, stroke("#111111", [[0.5, 0, 1]]));
    expect(hitTestDrawing(d, 0.5, 0.002, 0.01)).toEqual({ layerId: "l1", index: 0 });
  });

  it("prefers the top-most visible layer, then the newest stroke", () => {
    const doc = new DrawingDoc(fresh(), 8);
    doc.setLayerSym("l1", { segments: 4, mirror: false });
    doc.commitStroke(bar);
    doc.addLayer();
    doc.commitStroke(bar);
    expect(hitTestDrawing(doc.drawing, 0.55, 0, 0.01)).toEqual({ layerId: "l2", index: 0 });

    doc.setLayerVisible("l2", false);
    expect(hitTestDrawing(doc.drawing, 0.55, 0, 0.01)).toEqual({ layerId: "l1", index: 0 });
  });

  it("respects each layer's own symmetry when inverting", () => {
    const doc = new DrawingDoc(fresh(), 8);
    doc.setLayerSym("l1", { segments: 4, mirror: false });
    doc.commitStroke(bar);
    doc.addLayer();
    // 3-fold on top: its images sit at 120° and 240°, not 90°.
    doc.setLayerSym("l2", { segments: 3, mirror: false });
    doc.commitStroke(bar);

    // 90° is only an image of the 4-fold layer below.
    expect(hitTestDrawing(doc.drawing, 0, 0.55, 0.01)).toEqual({ layerId: "l1", index: 0 });
    // 120° is only an image of the 3-fold layer above.
    const a = (Math.PI * 2) / 3;
    const hit = hitTestDrawing(doc.drawing, Math.cos(a) * 0.55, Math.sin(a) * 0.55, 0.01);
    expect(hit).toEqual({ layerId: "l2", index: 0 });
  });

  it("gives a fatter stroke a wider reach", () => {
    const thin = withStroke({ segments: 4, mirror: false }, { ...bar, size: 2 });
    const fat = withStroke({ segments: 4, mirror: false }, { ...bar, size: 200 });
    expect(hitTestDrawing(thin, 0.55, 0.06, 0)).toBeNull();
    expect(hitTestDrawing(fat, 0.55, 0.06, 0)).not.toBeNull();
  });
});

describe("a hidden active layer refuses strokes", () => {
  // The renderer skips hidden layers and the live overlay declines to draw
  // there, so a stroke committed onto one is ink the user cannot see. Keeping it
  // means the drawing silently carries invisible strokes, they count toward the
  // piece, and it can be saved as an image that looks blank. Refusing is also
  // what lets the UI say "nothing was drawn" and have that be true — DESIGN.md
  // §3 specifies exactly that toast.
  const docWithHiddenActive = () => {
    const doc = new DrawingDoc(fresh(), 8);
    doc.setLayerVisible(doc.activeLayerId, false);
    return doc;
  };

  it("returns false and stores nothing", () => {
    const doc = docWithHiddenActive();
    const before = serialize(doc.drawing);
    expect(doc.commitStroke(stroke("#111111", [[0, 0, 1], [0.2, 0.2, 1]]))).toBe(false);
    expect(serialize(doc.drawing)).toBe(before);
    expect(doc.activeLayer.strokes).toHaveLength(0);
  });

  // A refused stroke must not become an undo step either. If it did, the user
  // would press undo and watch nothing happen — the classic symptom of a
  // history entry that holds no change.
  it("does not create an undo step", () => {
    const doc = docWithHiddenActive();
    const undoBefore = doc.canUndo;
    doc.commitStroke(stroke("#111111", [[0, 0, 1], [0.2, 0.2, 1]]));
    expect(doc.canUndo).toBe(undoBefore);
  });

  // The control. Without it, every assertion above passes just as well against
  // a commitStroke that refuses EVERYTHING, which is a different bug.
  it("...but a visible active layer still accepts them", () => {
    const doc = new DrawingDoc(fresh(), 8);
    expect(doc.activeLayer.visible).toBe(true);
    expect(doc.commitStroke(stroke("#111111", [[0, 0, 1], [0.2, 0.2, 1]]))).toBe(true);
    expect(doc.activeLayer.strokes).toHaveLength(1);
    expect(doc.canUndo).toBe(true);
  });

  it("showing the layer again makes it accept strokes", () => {
    const doc = docWithHiddenActive();
    expect(doc.commitStroke(stroke("#111111", [[0, 0, 1], [0.2, 0.2, 1]]))).toBe(false);
    doc.setLayerVisible(doc.activeLayerId, true);
    expect(doc.commitStroke(stroke("#111111", [[0, 0, 1], [0.2, 0.2, 1]]))).toBe(true);
    expect(doc.activeLayer.strokes).toHaveLength(1);
  });
});
