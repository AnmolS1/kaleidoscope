// Undo semantics for the v2 document.
//
// The interesting content here is not "undo undoes" — it is the *policy* of what
// enters the stack at all (PLAN §4/T03). Visibility and rename are deliberately
// outside it, and an opacity drag must land as ONE entry rather than forty. Both
// are the kind of rule that quietly regresses, so each is pinned by a test that
// would fail if the rule flipped.

import { describe, it, expect } from "vitest";
import { DrawingDoc, History, topVisibleLayerId } from "../../src/client/engine/history";
import { emptyDrawing, type DrawingV2, type Stroke } from "../../src/shared/vector";

const mk = (color: string): Stroke => ({
  tool: "solid",
  color,
  size: 4,
  opacity: 1,
  pts: [[0, 0, 1]],
});

const fresh = (): DrawingV2 => emptyDrawing("light", { segments: 12, mirror: true });

/** The colors on one layer, so assertions read as the picture, not the shape. */
function colorsOf(d: DrawingV2, layerId: string): string[] {
  return (d.layers.find((l) => l.id === layerId)?.strokes ?? []).map((s) => s.color);
}

describe("History (snapshot stack)", () => {
  it("starts with the given drawing and nothing to undo/redo", () => {
    const h = new History(fresh());
    expect(h.canUndo).toBe(false);
    expect(h.canRedo).toBe(false);
    expect(h.undo()).toBe(false);
    expect(h.redo()).toBe(false);
  });

  it("commit then undo then redo", () => {
    const a = fresh();
    const b: DrawingV2 = { ...a, bg: "dark" };
    const h = new History(a);
    h.commit(b);
    expect(h.current).toBe(b);
    expect(h.undo()).toBe(true);
    expect(h.current).toBe(a);
    expect(h.redo()).toBe(true);
    expect(h.current).toBe(b);
  });

  it("committing after undo clears the redo branch", () => {
    const a = fresh();
    const h = new History(a);
    h.commit({ ...a, bg: "dark" });
    h.undo();
    h.commit({ ...a, bg: "light" });
    expect(h.canRedo).toBe(false);
  });

  it("replace() changes the state without an undo entry", () => {
    const a = fresh();
    const h = new History(a);
    h.replace({ ...a, bg: "dark" });
    expect(h.current.bg).toBe("dark");
    expect(h.canUndo).toBe(false);
  });

  it("coalesces consecutive commits with the same key into one entry", () => {
    const a = fresh();
    const h = new History(a);
    for (let i = 1; i <= 5; i++) h.commit({ ...a, bg: i % 2 ? "dark" : "light" }, "drag");
    expect(h.canUndo).toBe(true);
    h.undo();
    expect(h.current).toBe(a);
    expect(h.canUndo).toBe(false);
  });

  it("endCoalesce splits one gesture from the next", () => {
    const a = fresh();
    const h = new History(a);
    h.commit({ ...a, bg: "dark" }, "drag");
    h.endCoalesce();
    h.commit({ ...a, bg: "light" }, "drag");
    h.undo();
    expect(h.current.bg).toBe("dark");
    expect(h.canUndo).toBe(true);
  });
});

describe("DrawingDoc — what is undoable", () => {
  it("a freshly loaded drawing has nothing to undo", () => {
    const doc = new DrawingDoc();
    doc.load(fresh());
    expect(doc.canUndo).toBe(false);
    expect(doc.canRedo).toBe(false);
  });

  it("stroke commit is undoable", () => {
    const doc = new DrawingDoc();
    doc.commitStroke(mk("#111111"));
    doc.commitStroke(mk("#222222"));
    expect(doc.totalStrokes).toBe(2);
    expect(doc.undo()).toBe(true);
    expect(colorsOf(doc.drawing, doc.activeLayerId)).toEqual(["#111111"]);
    expect(doc.redo()).toBe(true);
    expect(doc.totalStrokes).toBe(2);
  });

  it("stroke delete is undoable and removes the right one", () => {
    const doc = new DrawingDoc();
    doc.commitStroke(mk("#111111"));
    doc.commitStroke(mk("#222222"));
    doc.commitStroke(mk("#333333"));
    expect(doc.deleteStroke(doc.activeLayerId, 1)).toBe(true);
    expect(colorsOf(doc.drawing, doc.activeLayerId)).toEqual(["#111111", "#333333"]);
    doc.undo();
    expect(colorsOf(doc.drawing, doc.activeLayerId)).toEqual(["#111111", "#222222", "#333333"]);
  });

  it("deleting a stroke that isn't there is refused, not silently absorbed", () => {
    const doc = new DrawingDoc();
    doc.commitStroke(mk("#111111"));
    expect(doc.deleteStroke(doc.activeLayerId, 7)).toBe(false);
    expect(doc.deleteStroke("l8", 0)).toBe(false);
    expect(doc.canUndo).toBe(true); // only the commit
    doc.undo();
    expect(doc.canUndo).toBe(false);
  });

  it("clear empties every layer, keeps the layer structure, and is undoable", () => {
    const doc = new DrawingDoc();
    doc.commitStroke(mk("#111111"));
    const second = doc.addLayer()!;
    doc.commitStroke(mk("#222222"));
    expect(doc.totalStrokes).toBe(2);

    expect(doc.clearStrokes()).toBe(true);
    expect(doc.totalStrokes).toBe(0);
    expect(doc.layers).toHaveLength(2);
    expect(doc.layers.map((l) => l.id)).toContain(second);

    doc.undo();
    expect(doc.totalStrokes).toBe(2);
  });

  it("clear on an empty drawing is a no-op", () => {
    const doc = new DrawingDoc();
    expect(doc.clearStrokes()).toBe(false);
    expect(doc.canUndo).toBe(false);
  });

  it("add, remove, reorder and duplicate layer are each undoable", () => {
    const doc = new DrawingDoc(fresh(), 8);

    doc.addLayer();
    expect(doc.layers).toHaveLength(2);
    doc.undo();
    expect(doc.layers).toHaveLength(1);
    doc.redo();

    doc.duplicateLayer(doc.activeLayerId);
    expect(doc.layers).toHaveLength(3);
    doc.undo();
    expect(doc.layers).toHaveLength(2);
    doc.redo();

    const bottom = doc.layers[0].id;
    doc.moveLayer(bottom, 2);
    expect(doc.layers[2].id).toBe(bottom);
    doc.undo();
    expect(doc.layers[0].id).toBe(bottom);
    doc.redo();

    doc.removeLayer(doc.layers[0].id);
    expect(doc.layers).toHaveLength(2);
    doc.undo();
    expect(doc.layers).toHaveLength(3);
  });

  it("a layer symmetry change is undoable", () => {
    const doc = new DrawingDoc();
    const id = doc.activeLayerId;
    expect(doc.setLayerSym(id, { segments: 7, mirror: false })).toBe(true);
    expect(doc.activeLayer.sym).toEqual({ segments: 7, mirror: false });
    doc.undo();
    expect(doc.activeLayer.sym).toEqual({ segments: 12, mirror: true });
  });

  it("setting the symmetry a layer already has does nothing at all", () => {
    const doc = new DrawingDoc();
    expect(doc.setLayerSym(doc.activeLayerId, { segments: 12, mirror: true })).toBe(false);
    expect(doc.canUndo).toBe(false);
  });

  it("an opacity gesture is ONE undo step; the next gesture is another", () => {
    const doc = new DrawingDoc();
    const id = doc.activeLayerId;

    // drag one
    for (const v of [0.9, 0.8, 0.7, 0.6, 0.5]) doc.setLayerOpacity(id, v, true);
    doc.endOpacityGesture();
    // drag two
    for (const v of [0.4, 0.3]) doc.setLayerOpacity(id, v, true);
    doc.endOpacityGesture();

    expect(doc.activeLayer.opacity).toBeCloseTo(0.3);
    doc.undo();
    expect(doc.activeLayer.opacity).toBeCloseTo(0.5);
    doc.undo();
    expect(doc.activeLayer.opacity).toBe(1);
    expect(doc.canUndo).toBe(false);
  });

  it("a dial sweep is ONE undo step, and undo lands on the value before it", () => {
    const doc = new DrawingDoc();
    const id = doc.activeLayerId;
    const before = doc.activeLayer.sym.segments; // 12

    // Every integer the ring crosses on the way from 12 to 24 — the shape that
    // produced 22 undo entries before coalescing.
    for (let v = 13; v <= 24; v++) doc.setLayerSym(id, { segments: v, mirror: true }, true);
    doc.endSymGesture();

    expect(doc.activeLayer.sym.segments).toBe(24);
    doc.undo();
    // The assertion that matters. Depth alone would also pass if the FIRST step
    // of the sweep had opened its own entry and the rest had merged behind it —
    // that lands on 13, not 12, and leaves a stray entry the user must undo
    // twice to escape.
    expect(doc.activeLayer.sym.segments).toBe(before);
    expect(doc.canUndo).toBe(false);
  });

  it("two dial sweeps are two undo steps", () => {
    const doc = new DrawingDoc();
    const id = doc.activeLayerId;

    for (const v of [13, 14, 15]) doc.setLayerSym(id, { segments: v, mirror: true }, true);
    doc.endSymGesture();
    for (const v of [16, 17]) doc.setLayerSym(id, { segments: v, mirror: true }, true);
    doc.endSymGesture();

    expect(doc.activeLayer.sym.segments).toBe(17);
    doc.undo();
    expect(doc.activeLayer.sym.segments).toBe(15);
    doc.undo();
    expect(doc.activeLayer.sym.segments).toBe(12);
  });

  it("discrete symmetry changes stay separate steps", () => {
    const doc = new DrawingDoc();
    const id = doc.activeLayerId;
    // Three arrow presses, each sealed — the control for the sweep above. If
    // coalescing leaked into the uncoalesced path, these would collapse into
    // one and undo would jump straight back to 12.
    for (const v of [13, 14, 15]) doc.setLayerSym(id, { segments: v, mirror: true });
    doc.undo();
    expect(doc.activeLayer.sym.segments).toBe(14);
    doc.undo();
    expect(doc.activeLayer.sym.segments).toBe(13);
  });

  it("a sweep on one layer never merges into a sweep on another", () => {
    const doc = new DrawingDoc();
    const first = doc.activeLayerId;
    doc.addLayer();
    const second = doc.activeLayerId;
    expect(second).not.toBe(first);

    // No endSymGesture between them: only the per-layer key separates these.
    doc.setLayerSym(first, { segments: 20, mirror: true }, true);
    doc.setLayerSym(second, { segments: 6, mirror: true }, true);

    doc.undo();
    expect(doc.layers.find((l) => l.id === second)!.sym.segments).toBe(12);
    expect(doc.layers.find((l) => l.id === first)!.sym.segments).toBe(20);
  });

  it("an uncoalesced opacity change is its own step", () => {
    const doc = new DrawingDoc();
    const id = doc.activeLayerId;
    doc.setLayerOpacity(id, 0.5);
    doc.setLayerOpacity(id, 0.25);
    doc.undo();
    expect(doc.activeLayer.opacity).toBe(0.5);
  });
});

describe("DrawingDoc — what is NOT undoable", () => {
  it("visibility toggles stay out of history", () => {
    const doc = new DrawingDoc();
    doc.commitStroke(mk("#111111"));
    const id = doc.activeLayerId;

    expect(doc.setLayerVisible(id, false)).toBe(true);
    expect(doc.setLayerVisible(id, true)).toBe(true);
    expect(doc.setLayerVisible(id, false)).toBe(true);

    // The only undoable thing that happened was the stroke.
    doc.undo();
    expect(doc.totalStrokes).toBe(0);
    expect(doc.canUndo).toBe(false);
  });

  it("renames stay out of history, and an unstorable name is refused", () => {
    const doc = new DrawingDoc();
    doc.commitStroke(mk("#111111"));
    const id = doc.activeLayerId;

    expect(doc.setLayerName(id, "Petals")).toBe(true);
    expect(doc.activeLayer.name).toBe("Petals");
    // Control characters are rejected by the shared format, so the doc must
    // refuse them here rather than storing a drawing that will not serialize.
    expect(doc.setLayerName(id, "badname")).toBe(false);
    expect(doc.setLayerName(id, "x".repeat(41))).toBe(false);
    expect(doc.activeLayer.name).toBe("Petals");

    doc.undo();
    expect(doc.totalStrokes).toBe(0);
    expect(doc.canUndo).toBe(false);
  });

  it("switching the active layer is not an edit", () => {
    const doc = new DrawingDoc(fresh(), 8);
    const first = doc.activeLayerId;
    const second = doc.addLayer()!;
    expect(doc.activeLayerId).toBe(second);

    expect(doc.setActiveLayer(first)).toBe(true);
    expect(doc.setActiveLayer(first)).toBe(false); // already active

    // The only undoable thing that happened was the add.
    doc.undo();
    expect(doc.layers).toHaveLength(1);
    expect(doc.canUndo).toBe(false);
  });

  it("undo reseats the active layer only when it stopped existing", () => {
    const doc = new DrawingDoc(fresh(), 8);
    const first = doc.activeLayerId;
    const second = doc.addLayer()!;

    // Undo removes the layer that was active, so the selection has to move.
    doc.undo();
    expect(doc.activeLayerId).toBe(first);

    // Redo brings it back but does NOT restore the selection: which layer is
    // active is a view state, not part of the document being undone.
    doc.redo();
    expect(doc.layers.map((l) => l.id)).toEqual([first, second]);
    expect(doc.activeLayerId).toBe(first);
  });
});

describe("topVisibleLayerId", () => {
  it("picks the top-most visible layer so the first stroke is never swallowed", () => {
    const d = fresh();
    const doc = new DrawingDoc(d, 8);
    const upper = doc.addLayer()!;
    doc.setLayerVisible(upper, false);
    const reloaded = new DrawingDoc(doc.drawing, 8);
    expect(reloaded.activeLayerId).not.toBe(upper);
    expect(topVisibleLayerId(doc.drawing)).toBe(doc.layers[0].id);
  });

  it("falls back to the top layer when everything is hidden", () => {
    const doc = new DrawingDoc(fresh(), 8);
    const upper = doc.addLayer()!;
    doc.setLayerVisible(doc.layers[0].id, false);
    doc.setLayerVisible(upper, false);
    expect(topVisibleLayerId(doc.drawing)).toBe(upper);
  });
});
