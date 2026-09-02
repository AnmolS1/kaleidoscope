// The undoable document: a v2 drawing (layers, per-layer symmetry) plus the
// undo/redo stack over it, plus which layer is active.
//
// v1 kept a stroke list and snapshotted the array. v2 has to snapshot the WHOLE
// drawing, because a layer reorder or an opacity change is undoable and neither
// is expressible as a stroke list. That is only affordable because nothing here
// ever mutates a drawing in place: every operation rebuilds the objects on the
// path it touched and shares the rest by reference, so a snapshot of an 8-layer
// piece after adding one stroke costs one array, one layer object and one stroke
// array — not a copy of the strokes.
//
// What is and is not undoable is a product decision, recorded in PLAN §4/T03:
//
//   in history      stroke commit, stroke delete, clear, add/remove/reorder/
//                   duplicate layer, layer opacity (COALESCED per gesture),
//                   layer symmetry change
//   not in history  layer visibility toggle, layer rename, active-layer change
//
// Visibility and rename are "view/label" edits a user flips constantly while
// working; burying real work under twenty eye-toggles in the undo stack is worse
// than not being able to undo them. Remove-layer IS undoable, which is why the
// UI needs no confirm dialog for it.

import {
  MAX_LAYERS,
  clampSegments,
  emptyDrawing,
  nextLayerId,
  normalizeLayerName,
  type Background,
  type DrawingV2,
  type Layer,
  type Stroke,
  type Symmetry,
} from "../../shared/vector";

const MAX_DEPTH = 250;

// ---- pure drawing operations ---------------------------------------------
//
// Each returns a NEW drawing and never touches the input. They are exported so
// they can be tested without a canvas; Scene reaches them through DrawingDoc.

export function layerIndex(d: DrawingV2, id: string): number {
  return d.layers.findIndex((l) => l.id === id);
}

export function findLayer(d: DrawingV2, id: string): Layer | undefined {
  return d.layers.find((l) => l.id === id);
}

/** Replace one layer via a mapper, sharing every other layer by reference. */
export function withLayer(
  d: DrawingV2,
  id: string,
  fn: (layer: Layer) => Layer,
): DrawingV2 | null {
  const i = layerIndex(d, id);
  if (i < 0) return null;
  const layers = d.layers.slice();
  layers[i] = fn(layers[i]);
  return { ...d, layers };
}

/** Default name for a layer, derived from its positional id ("l3" → "Layer 3"). */
export function defaultLayerName(id: string): string {
  return `Layer ${id.slice(1)}`;
}

/**
 * A duplicate's name. Truncated to whatever the shared validator accepts, so a
 * 40-unit name duplicated repeatedly can never produce an unsaveable drawing.
 */
function copyName(name: string): string {
  const candidate = `${name} copy`;
  for (let cut = candidate.length; cut >= 0; cut--) {
    const n = normalizeLayerName(candidate.slice(0, cut));
    if (n !== null) return n;
  }
  return "";
}

export function addStrokeTo(d: DrawingV2, layerId: string, stroke: Stroke): DrawingV2 | null {
  return withLayer(d, layerId, (l) => ({ ...l, strokes: [...l.strokes, stroke] }));
}

export function deleteStrokeFrom(d: DrawingV2, layerId: string, index: number): DrawingV2 | null {
  const layer = findLayer(d, layerId);
  if (!layer || index < 0 || index >= layer.strokes.length) return null;
  return withLayer(d, layerId, (l) => ({
    ...l,
    strokes: l.strokes.filter((_, i) => i !== index),
  }));
}

/**
 * Empty every layer's strokes, keeping the layer structure.
 *
 * "Clear canvas" is about the ink, not the document: a user who has set up four
 * layers with different symmetries and wants a blank start keeps that setup.
 * Returns null when there is nothing to clear, so the caller can skip the
 * history entry.
 */
export function clearStrokesIn(d: DrawingV2): DrawingV2 | null {
  if (d.layers.every((l) => l.strokes.length === 0)) return null;
  return { ...d, layers: d.layers.map((l) => (l.strokes.length ? { ...l, strokes: [] } : l)) };
}

/** Insert a new empty layer directly above `aboveId`, inheriting its symmetry. */
export function addLayerAbove(d: DrawingV2, aboveId: string): { drawing: DrawingV2; id: string } | null {
  if (d.layers.length >= MAX_LAYERS) return null;
  const i = layerIndex(d, aboveId);
  const at = i < 0 ? d.layers.length - 1 : i;
  const source = d.layers[at];
  const id = nextLayerId(d.layers);
  const layer: Layer = {
    id,
    name: defaultLayerName(id),
    visible: true,
    opacity: 1,
    sym: { ...source.sym },
    strokes: [],
  };
  const layers = d.layers.slice();
  layers.splice(at + 1, 0, layer);
  return { drawing: { ...d, layers }, id };
}

export function duplicateLayerIn(d: DrawingV2, id: string): { drawing: DrawingV2; id: string } | null {
  if (d.layers.length >= MAX_LAYERS) return null;
  const i = layerIndex(d, id);
  if (i < 0) return null;
  const source = d.layers[i];
  const newId = nextLayerId(d.layers);
  // Strokes are never mutated, so the copy shares the array.
  const layer: Layer = {
    ...source,
    id: newId,
    name: copyName(source.name),
    sym: { ...source.sym },
    strokes: source.strokes,
  };
  const layers = d.layers.slice();
  layers.splice(i + 1, 0, layer);
  return { drawing: { ...d, layers }, id: newId };
}

/** Remove a layer. Never goes below one — a drawing always has a layer. */
export function removeLayerFrom(d: DrawingV2, id: string): DrawingV2 | null {
  if (d.layers.length <= 1) return null;
  const i = layerIndex(d, id);
  if (i < 0) return null;
  return { ...d, layers: d.layers.filter((_, j) => j !== i) };
}

/** Move a layer to a new index in the bottom → top order. */
export function moveLayerIn(d: DrawingV2, id: string, toIndex: number): DrawingV2 | null {
  const from = layerIndex(d, id);
  if (from < 0) return null;
  const to = Math.max(0, Math.min(d.layers.length - 1, Math.round(toIndex)));
  if (to === from) return null;
  const layers = d.layers.slice();
  const [layer] = layers.splice(from, 1);
  layers.splice(to, 0, layer);
  return { ...d, layers };
}

// ---- snapshot stack ------------------------------------------------------

export class History {
  private past: DrawingV2[] = [];
  private future: DrawingV2[] = [];
  private cur: DrawingV2;

  /**
   * The key of the gesture the top entry belongs to, or null. Two commits with
   * the same key in a row collapse into one undo step — that is what makes an
   * opacity drag a single undo rather than forty.
   */
  private coalesceKey: string | null = null;

  constructor(initial: DrawingV2) {
    this.cur = initial;
  }

  get current(): DrawingV2 {
    return this.cur;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  /** Push a new undoable state. */
  commit(next: DrawingV2, coalesceKey?: string): void {
    if (coalesceKey !== undefined && coalesceKey === this.coalesceKey) {
      // Same gesture: overwrite the state without deepening the stack.
      this.cur = next;
      this.future = [];
      return;
    }
    this.past.push(this.cur);
    if (this.past.length > MAX_DEPTH) this.past.shift();
    this.cur = next;
    this.future = [];
    this.coalesceKey = coalesceKey ?? null;
  }

  /** Seal the current gesture so the next change starts a new undo step. */
  endCoalesce(): void {
    this.coalesceKey = null;
  }

  /**
   * Change the state WITHOUT an undo entry (visibility, rename).
   *
   * 🔴 Applied to the WHOLE stack, not just to `cur` (S7).
   *
   * Keeping these off the undo stack is right — nobody expects ⌘Z to re-hide a
   * layer they just showed. But writing them to `cur` alone left every snapshot
   * in `past` still carrying the OLD value, so the next unrelated undo restored
   * one: hide a layer, press ⌘Z for a stroke, and the layer comes back — and it
   * is in the saved picture, because the save reads `cur`. Same for renames.
   *
   * Mapping over `past` and `future` too makes the change genuinely outside the
   * timeline, which is what "not undoable" was supposed to mean.
   */
  replaceAll(map: (d: DrawingV2) => DrawingV2): void {
    this.cur = map(this.cur);
    this.past = this.past.map(map);
    this.future = this.future.map(map);
    // A non-undoable edit still ends a gesture: coalescing an opacity drag into
    // a state the user has since renamed would undo the rename too.
    this.coalesceKey = null;
  }

  undo(): boolean {
    const prev = this.past.pop();
    if (prev === undefined) return false;
    this.future.push(this.cur);
    this.cur = prev;
    this.coalesceKey = null;
    return true;
  }

  redo(): boolean {
    const next = this.future.pop();
    if (next === undefined) return false;
    this.past.push(this.cur);
    this.cur = next;
    this.coalesceKey = null;
    return true;
  }

  /** Replace the document and drop history — loading or remixing. */
  reset(d: DrawingV2): void {
    this.past = [];
    this.future = [];
    this.cur = d;
    this.coalesceKey = null;
  }
}

// ---- the document --------------------------------------------------------

/** What panels need to render a layer row, without handing out the strokes. */
export interface LayerSummary {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  sym: Symmetry;
  strokeCount: number;
}

/**
 * The drawing plus its history plus the active layer. Headless: no canvas, no
 * DOM, so every layer rule and undo rule is unit-testable directly.
 *
 * `layerCap` is passed in from app state (3 free / 8 Plus). It gates ADDING
 * layers only. Opening, editing and saving a piece that already has more layers
 * than the cap must keep working — a free user remixing a Plus piece is an
 * explicitly supported flow (PLAN §1).
 */
export class DrawingDoc {
  private hist: History;
  private active: string;
  private cap: number;

  constructor(drawing?: DrawingV2, layerCap = 3) {
    const d = drawing ?? emptyDrawing("light", { segments: 8, mirror: true });
    this.hist = new History(d);
    this.active = topVisibleLayerId(d);
    this.cap = clampCap(layerCap);
  }

  // --- reads ---
  get drawing(): DrawingV2 {
    return this.hist.current;
  }
  get layers(): readonly Layer[] {
    return this.hist.current.layers;
  }
  get activeLayerId(): string {
    return this.active;
  }
  get activeLayer(): Layer {
    return findLayer(this.hist.current, this.active) ?? this.hist.current.layers[0];
  }
  get layerCap(): number {
    return this.cap;
  }
  get canUndo(): boolean {
    return this.hist.canUndo;
  }
  get canRedo(): boolean {
    return this.hist.canRedo;
  }
  /** Total strokes across every layer, hidden ones included. */
  get totalStrokes(): number {
    let n = 0;
    for (const l of this.hist.current.layers) n += l.strokes.length;
    return n;
  }
  /**
   * Strokes on VISIBLE layers — i.e. how much of the drawing is actually a
   * picture.
   *
   * Distinct from `totalStrokes` on purpose. Undo and the clear button care
   * about everything the document holds; anything that asks "is there something
   * here to save/export" must not count ink on a hidden layer, or a drawing
   * whose only strokes are hidden saves as a blank image while every guard says
   * it is fine. iOS calls the same idea `visibleStrokes`.
   */
  get visibleStrokes(): number {
    let n = 0;
    for (const l of this.hist.current.layers) if (l.visible) n += l.strokes.length;
    return n;
  }
  /** Whether another layer may be added under the current cap. */
  get canAddLayer(): boolean {
    return this.hist.current.layers.length < Math.min(this.cap, MAX_LAYERS);
  }

  summaries(): LayerSummary[] {
    return this.hist.current.layers.map((l) => ({
      id: l.id,
      name: l.name,
      visible: l.visible,
      opacity: l.opacity,
      sym: { ...l.sym },
      strokeCount: l.strokes.length,
    }));
  }

  // --- document-level ---
  setLayerCap(n: number): void {
    this.cap = clampCap(n);
  }

  load(d: DrawingV2): void {
    this.hist.reset(d);
    this.active = topVisibleLayerId(d);
  }

  setBackground(bg: Background): boolean {
    if (this.hist.current.bg === bg) return false;
    // Background is a property of the drawing but not an ink edit; it rides
    // outside history the same way the theme toggle always has.
    this.hist.replaceAll((d) => ({ ...d, bg }));
    return true;
  }

  undo(): boolean {
    if (!this.hist.undo()) return false;
    this.reseatActive();
    return true;
  }
  redo(): boolean {
    if (!this.hist.redo()) return false;
    this.reseatActive();
    return true;
  }

  // --- strokes ---
  /**
   * Commit a stroke to the active layer.
   *
   * Returns false and commits NOTHING when that layer is hidden. The stroke was
   * never rendered — `paintDrawing` skips hidden layers and the live overlay
   * declines to draw there — so accepting it would store ink the user has no way
   * to see, which then counts toward the drawing and can be saved as a picture
   * that looks blank. Refusing is what lets the UI say "nothing was drawn" and
   * have that be true.
   *
   * The caller is expected to tell the user which layer refused; silently
   * dropping a stroke is only marginally better than silently keeping one.
   */
  commitStroke(stroke: Stroke): boolean {
    if (!this.activeLayerVisible()) return false;
    const next = addStrokeTo(this.hist.current, this.active, stroke);
    if (!next) return false;
    this.hist.commit(next);
    return true;
  }

  private activeLayerVisible(): boolean {
    return this.activeLayer.visible;
  }

  deleteStroke(layerId: string, index: number): boolean {
    const next = deleteStrokeFrom(this.hist.current, layerId, index);
    if (!next) return false;
    this.hist.commit(next);
    return true;
  }

  clearStrokes(): boolean {
    const next = clearStrokesIn(this.hist.current);
    if (!next) return false;
    this.hist.commit(next);
    return true;
  }

  // --- layers ---
  /** Add a layer above the active one, inheriting its symmetry. Null at the cap. */
  addLayer(): string | null {
    if (!this.canAddLayer) return null;
    const r = addLayerAbove(this.hist.current, this.active);
    if (!r) return null;
    this.hist.commit(r.drawing);
    this.active = r.id;
    return r.id;
  }

  duplicateLayer(id: string = this.active): string | null {
    if (!this.canAddLayer) return null;
    const r = duplicateLayerIn(this.hist.current, id);
    if (!r) return null;
    this.hist.commit(r.drawing);
    this.active = r.id;
    return r.id;
  }

  removeLayer(id: string = this.active): boolean {
    const i = layerIndex(this.hist.current, id);
    const next = removeLayerFrom(this.hist.current, id);
    if (!next) return false;
    this.hist.commit(next);
    if (this.active === id) {
      // Fall to whatever now occupies that slot, or the new top — but never to
      // a HIDDEN layer (S8). Landing there makes the next stroke get silently
      // refused with a toast naming a layer the user never chose, which reads
      // as the app ignoring them.
      const fallback = next.layers[Math.min(i, next.layers.length - 1)]!;
      this.active = fallback.visible ? fallback.id : topVisibleLayerId(next);
    }
    return true;
  }

  moveLayer(id: string, toIndex: number): boolean {
    const next = moveLayerIn(this.hist.current, id, toIndex);
    if (!next) return false;
    this.hist.commit(next);
    return true;
  }

  setActiveLayer(id: string): boolean {
    if (id === this.active || layerIndex(this.hist.current, id) < 0) return false;
    this.active = id;
    return true;
  }

  /** Visibility is deliberately NOT undoable — see the file header. */
  setLayerVisible(id: string, visible: boolean): boolean {
    const layer = findLayer(this.hist.current, id);
    if (!layer || layer.visible === visible) return false;
    this.hist.replaceAll((d) => withLayer(d, id, (l) => ({ ...l, visible })) ?? d);
    return true;
  }

  /** Rename is deliberately NOT undoable. Rejects names the format won't store. */
  setLayerName(id: string, raw: string): boolean {
    const name = normalizeLayerName(raw);
    if (name === null) return false;
    const layer = findLayer(this.hist.current, id);
    if (!layer || layer.name === name) return false;
    this.hist.replaceAll((d) => withLayer(d, id, (l) => ({ ...l, name })) ?? d);
    return true;
  }

  /**
   * Layer opacity. `coalesce` merges consecutive changes to the same layer into
   * one undo step, so a slider drag is one entry; call `endOpacityGesture` on
   * pointer-up to seal it.
   */
  setLayerOpacity(id: string, value: number, coalesce = false): boolean {
    const opacity = Math.max(0, Math.min(1, value));
    const layer = findLayer(this.hist.current, id);
    if (!layer || layer.opacity === opacity) return false;
    this.hist.commit(
      withLayer(this.hist.current, id, (l) => ({ ...l, opacity }))!,
      coalesce ? `opacity:${id}` : undefined,
    );
    return true;
  }

  endOpacityGesture(): void {
    this.hist.endCoalesce();
  }

  /**
   * Layer symmetry. `coalesce` works exactly as it does for opacity: consecutive
   * changes to the same layer merge into one undo step, sealed by
   * `endSymGesture`.
   *
   * The dial needs this more than the slider did. Its ring crosses the whole
   * 3..24 span in a single gesture, so an uncoalesced drag from one end to the
   * other left 22 undo entries — enough that Undo stopped meaning "take back
   * what I just did" and became "step back through a gesture I experienced as
   * one motion".
   *
   * Keying on the LAYER id, not just "sym", is what stops a change of active
   * layer mid-sequence from folding two layers' edits into a single entry: a
   * different id is a different key, so it opens a new step on its own.
   */
  setLayerSym(id: string, sym: Symmetry, coalesce = false): boolean {
    const segments = clampSegments(sym.segments);
    const layer = findLayer(this.hist.current, id);
    if (!layer || (layer.sym.segments === segments && layer.sym.mirror === sym.mirror)) return false;
    this.hist.commit(
      withLayer(this.hist.current, id, (l) => ({ ...l, sym: { segments, mirror: sym.mirror } }))!,
      coalesce ? `sym:${id}` : undefined,
    );
    return true;
  }

  endSymGesture(): void {
    this.hist.endCoalesce();
  }

  /** Apply one symmetry to every layer (the popover's "Apply to all layers"). */
  setAllSym(sym: Symmetry): boolean {
    const segments = clampSegments(sym.segments);
    const d = this.hist.current;
    if (d.layers.every((l) => l.sym.segments === segments && l.sym.mirror === sym.mirror)) {
      return false;
    }
    this.hist.commit({
      ...d,
      layers: d.layers.map((l) => ({ ...l, sym: { segments, mirror: sym.mirror } })),
    });
    return true;
  }

  /** After undo/redo the active layer may no longer exist. */
  private reseatActive(): void {
    if (layerIndex(this.hist.current, this.active) < 0) {
      this.active = topVisibleLayerId(this.hist.current);
    }
  }
}

function clampCap(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(MAX_LAYERS, Math.floor(n)));
}

/**
 * The layer a freshly loaded drawing should start on: the top-most visible one.
 * Starting on a hidden layer would silently swallow the first stroke.
 */
export function topVisibleLayerId(d: DrawingV2): string {
  for (let i = d.layers.length - 1; i >= 0; i--) {
    if (d.layers[i].visible) return d.layers[i].id;
  }
  return d.layers[d.layers.length - 1].id;
}
