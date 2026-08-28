// The live drawing engine: three stacked canvases (grid / art / live), DPR-aware
// sizing, a requestAnimationFrame render loop, and pointer input with coalesced
// events + pressure. Framework-free — the Preact <Canvas> just mounts it into a
// host element and forwards tool changes. All rendering goes through the shared
// symmetry + brush modules so the screen matches every exporter exactly.
//
// v2 adds layers. The document (layers, per-layer symmetry, undo) lives in
// DrawingDoc; this class owns pixels, input and the render loop only.

import {
  forEachImage,
  applyImageTransform,
  inverseTransformPoint,
} from "./symmetry";
import {
  drawStroke,
} from "./brush";
import { DrawingDoc, type LayerSummary } from "./history";
import {
  REFERENCE_HALF,
  clampSegments,
  emptyDrawing,
  halfAxis,
  toNormalized,
  type Background,
  type BrushTool,
  type DrawingV2,
  type Layer,
  type Pt,
  type Stroke,
  type Symmetry,
} from "../../shared/vector";

export interface ToolState {
  tool: BrushTool;
  color: string;
  size: number;
  opacity: number;
  /** The ACTIVE layer's symmetry, mirrored here for readers of `toolState`. */
  segments: number;
  mirror: boolean;
  bg: Background;
  showGuides: boolean;
}

export interface SceneCallbacks {
  onHistoryChange?: (canUndo: boolean, canRedo: boolean, count: number) => void;
  /** Fires whenever the layer list, a layer's fields, or the active layer change. */
  onLayersChange?: (layers: LayerSummary[], activeLayerId: string) => void;
}

export interface SceneOptions {
  /** Max layers this account may ADD. Never limits loading or editing. */
  layerCap?: number;
}

const MAX_DPR = 3;
const DEFAULT_PRESSURE = 0.5;
/** Extra tap slack for hit-testing, in CSS px on top of the stroke's own width. */
const HIT_SLACK_PX = 8;

// Self-contained canvas palette (mirrors tokens.css) so the engine never depends
// on <html data-theme> being applied first.
const THEME: Record<Background, { bg: string; fine: string; bold: string; guide: string }> = {
  light: {
    bg: "#EEF0EC",
    fine: "rgba(46,94,140,.07)",
    bold: "rgba(46,94,140,.13)",
    guide: "rgba(46,94,140,.28)",
  },
  dark: {
    bg: "#13202A",
    fine: "rgba(130,169,206,.08)",
    bold: "rgba(130,169,206,.16)",
    guide: "rgba(130,169,206,.30)",
  },
};

export class Scene {
  private host: HTMLElement;
  private grid: HTMLCanvasElement;
  private art: HTMLCanvasElement;
  private live: HTMLCanvasElement;
  private gctx: CanvasRenderingContext2D;
  private actx: CanvasRenderingContext2D;
  private lctx: CanvasRenderingContext2D;

  private doc: DrawingDoc;
  private state: ToolState;
  private cb: SceneCallbacks;

  private dpr = 1;
  private cssW = 0;
  private cssH = 0;

  private drawingStroke: Stroke | null = null;
  private activePointer: number | null = null;
  private liveDirty = false;
  private rafId = 0;
  private ro: ResizeObserver | null = null;

  constructor(host: HTMLElement, initial: ToolState, cb: SceneCallbacks = {}, opts: SceneOptions = {}) {
    this.host = host;
    this.state = { ...initial, segments: clampSegments(initial.segments) };
    this.cb = cb;
    this.doc = new DrawingDoc(
      emptyDrawing(this.state.bg, { segments: this.state.segments, mirror: this.state.mirror }),
      opts.layerCap ?? 3,
    );

    this.grid = this.makeCanvas(0);
    this.art = this.makeCanvas(1);
    this.live = this.makeCanvas(2);
    this.gctx = this.grid.getContext("2d")!;
    this.actx = this.art.getContext("2d")!;
    this.lctx = this.live.getContext("2d")!;

    this.live.style.touchAction = "none";
    this.live.style.cursor = "crosshair";

    this.bindInput();

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();
    this.loop();
  }

  private makeCanvas(z: number): HTMLCanvasElement {
    const c = document.createElement("canvas");
    c.style.position = "absolute";
    c.style.inset = "0";
    c.style.width = "100%";
    c.style.height = "100%";
    c.style.zIndex = String(z);
    this.host.appendChild(c);
    return c;
  }

  // ---- sizing ----
  private resize(): void {
    const rect = this.host.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    this.dpr = Math.min(MAX_DPR, Math.max(1, window.devicePixelRatio || 1));
    this.cssW = w;
    this.cssH = h;
    for (const [c, ctx] of [
      [this.grid, this.gctx],
      [this.art, this.actx],
      [this.live, this.lctx],
    ] as const) {
      c.width = Math.floor(w * this.dpr);
      c.height = Math.floor(h * this.dpr);
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }
    this.renderGrid();
    this.renderArt();
  }

  private get half(): number {
    return halfAxis(this.cssW, this.cssH);
  }

  // ---- grid + guides ----
  private renderGrid(): void {
    const ctx = this.gctx;
    const w = this.cssW;
    const h = this.cssH;
    ctx.clearRect(0, 0, w, h);

    const theme = THEME[this.state.bg];
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, w, h);

    // graph-paper grid
    const fine = theme.fine;
    const bold = theme.bold;
    const step = 24;
    ctx.lineWidth = 1;
    ctx.strokeStyle = fine;
    ctx.beginPath();
    for (let x = (w / 2) % step; x < w; x += step) {
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, h);
    }
    for (let y = (h / 2) % step; y < h; y += step) {
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(w, Math.round(y) + 0.5);
    }
    ctx.stroke();
    ctx.strokeStyle = bold;
    ctx.beginPath();
    for (let x = (w / 2) % (step * 5); x < w; x += step * 5) {
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, h);
    }
    for (let y = (h / 2) % (step * 5); y < h; y += step * 5) {
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(w, Math.round(y) + 0.5);
    }
    ctx.stroke();

    if (this.state.showGuides) this.renderGuides();
  }

  // Guides show the ACTIVE layer's symmetry — they are drawing aids for the
  // stroke about to be made, not a description of the whole piece.
  private renderGuides(): void {
    const ctx = this.gctx;
    const sym = this.doc.activeLayer.sym;
    const n = sym.segments;
    const r = Math.max(this.cssW, this.cssH);
    const color = THEME[this.state.bg].guide;
    ctx.save();
    ctx.translate(this.cssW / 2, this.cssH / 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const step = (Math.PI * 2) / n;
    for (let i = 0; i < n; i++) {
      const a = i * step;
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    if (sym.mirror) {
      // mirror axes bisect the wedges
      for (let i = 0; i < n; i++) {
        const a = i * step + step / 2;
        ctx.moveTo(0, 0);
        ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
    }
    ctx.stroke();
    ctx.restore();
  }

  // ---- committed art ----

  /**
   * Whether the in-progress stroke can live on the separate overlay canvas.
   *
   * It can only when painting it there is the same picture as compositing it
   * into its layer: the active layer must be the top-most VISIBLE one and sit at
   * full opacity. Otherwise the stroke has to be rendered in its true position
   * in the stack, which means repainting the art canvas each frame.
   *
   * When the active layer is hidden this is false and the stroke is not drawn at
   * all — deliberately, so what you see while drawing is what you get when the
   * stroke commits.
   */
  private get liveOnOverlay(): boolean {
    const active = this.doc.activeLayer;
    if (!active.visible || active.opacity !== 1) return false;
    const layers = this.doc.layers;
    for (let i = layers.length - 1; i >= 0; i--) {
      if (layers[i].visible) return layers[i].id === active.id;
    }
    return false;
  }

  private renderArt(): void {
    this.actx.clearRect(0, 0, this.cssW, this.cssH);
    const live =
      !this.liveOnOverlay && this.drawingStroke && this.drawingStroke.pts.length > 0
        ? this.drawingStroke
        : null;
    paintDrawing(this.actx, this.doc.drawing, this.cssW, this.cssH, this.half, {
      liveStroke: live,
      liveLayerId: this.doc.activeLayerId,
    });
  }

  private renderLive(): void {
    const ctx = this.lctx;
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    if (!this.liveOnOverlay) return;
    if (this.drawingStroke && this.drawingStroke.pts.length > 0) {
      paintStrokes(
        ctx,
        [this.drawingStroke],
        this.cssW,
        this.cssH,
        this.half,
        this.doc.activeLayer.sym,
      );
    }
  }

  private loop = (): void => {
    if (this.liveDirty) {
      this.liveDirty = false;
      this.renderLive();
      // Not on the overlay → the stroke is part of the stack, so the whole art
      // canvas has to be rebuilt for this frame.
      if (!this.liveOnOverlay) this.renderArt();
    }
    this.rafId = requestAnimationFrame(this.loop);
  };

  // ---- input ----
  private bindInput(): void {
    this.live.addEventListener("pointerdown", this.onDown);
    this.live.addEventListener("pointermove", this.onMove);
    this.live.addEventListener("pointerup", this.onUp);
    this.live.addEventListener("pointercancel", this.onUp);
    this.live.addEventListener("pointerleave", this.onUp);
  }

  private pointFromEvent(e: PointerEvent): Pt {
    const rect = this.live.getBoundingClientRect();
    const { x, y } = toNormalized(e.clientX - rect.left, e.clientY - rect.top, this.cssW, this.cssH);
    const pressure = e.pressure > 0 ? e.pressure : DEFAULT_PRESSURE;
    return [x, y, pressure];
  }

  private onDown = (e: PointerEvent): void => {
    if (this.activePointer !== null) return;
    e.preventDefault();
    this.activePointer = e.pointerId;
    try {
      this.live.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic events / unsupported */
    }
    this.drawingStroke = {
      tool: this.state.tool,
      color: this.state.color,
      size: this.state.size,
      opacity: this.state.opacity,
      pts: [this.pointFromEvent(e)],
    };
    this.liveDirty = true;
  };

  private onMove = (e: PointerEvent): void => {
    if (this.activePointer !== e.pointerId || !this.drawingStroke) return;
    e.preventDefault();
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    const minDist = 1.1 / this.half;
    const pts = this.drawingStroke.pts;
    for (const ev of events.length ? events : [e]) {
      const p = this.pointFromEvent(ev);
      const prev = pts[pts.length - 1];
      if (!prev || Math.hypot(p[0] - prev[0], p[1] - prev[1]) >= minDist) pts.push(p);
    }
    this.liveDirty = true;
  };

  private onUp = (e: PointerEvent): void => {
    if (this.activePointer !== e.pointerId || !this.drawingStroke) return;
    e.preventDefault();
    try {
      this.live.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    this.activePointer = null;
    const stroke = this.drawingStroke;
    this.drawingStroke = null;
    this.lctx.clearRect(0, 0, this.cssW, this.cssH);
    if (stroke.pts.length > 0) {
      this.doc.commitStroke(stroke);
      this.renderArt();
      this.notify();
    }
  };

  private notify(): void {
    this.cb.onHistoryChange?.(this.doc.canUndo, this.doc.canRedo, this.doc.totalStrokes);
    this.cb.onLayersChange?.(this.doc.summaries(), this.doc.activeLayerId);
  }

  /** Re-render everything a layer change can affect, then report upward. */
  private afterDocChange(): void {
    this.syncSymFromActive();
    this.renderGrid();
    this.renderArt();
    this.notify();
  }

  /** Keep `toolState`'s mirror of the active layer's symmetry truthful. */
  private syncSymFromActive(): void {
    const sym = this.doc.activeLayer.sym;
    this.state.segments = sym.segments;
    this.state.mirror = sym.mirror;
  }

  // ---- public API ----
  setTool(t: BrushTool): void {
    this.state.tool = t;
  }
  setColor(c: string): void {
    this.state.color = c;
  }
  setSize(n: number): void {
    this.state.size = n;
  }
  setOpacity(n: number): void {
    this.state.opacity = Math.max(0, Math.min(1, n));
  }

  /**
   * Segments and mirror edit the ACTIVE LAYER.
   *
   * Both are no-ops when the value already matches, and that is load-bearing:
   * Canvas.tsx pushes the signals into the engine through effects that run once
   * at mount and again whenever switching the active layer writes the new
   * layer's symmetry back to those signals. Without the guard, mounting would
   * open a spurious undo entry and the active-layer switch would loop.
   */
  setSegments(n: number): void {
    const segments = clampSegments(n);
    if (this.doc.activeLayer.sym.segments === segments) return;
    if (this.doc.setLayerSym(this.doc.activeLayerId, { segments, mirror: this.doc.activeLayer.sym.mirror })) {
      this.afterDocChange();
    }
  }
  setMirror(m: boolean): void {
    if (this.doc.activeLayer.sym.mirror === m) return;
    if (this.doc.setLayerSym(this.doc.activeLayerId, { segments: this.doc.activeLayer.sym.segments, mirror: m })) {
      this.afterDocChange();
    }
  }
  /** The symmetry popover's "Apply to all layers". */
  setAllSym(sym: Symmetry): void {
    if (this.doc.setAllSym(sym)) this.afterDocChange();
  }

  setBackground(bg: Background): void {
    this.state.bg = bg;
    this.doc.setBackground(bg);
    this.renderGrid();
    this.renderArt();
  }
  setShowGuides(s: boolean): void {
    this.state.showGuides = s;
    this.renderGrid();
  }

  undo(): void {
    if (this.doc.undo()) this.afterDocChange();
  }
  redo(): void {
    if (this.doc.redo()) this.afterDocChange();
  }
  clear(): void {
    if (this.doc.clearStrokes()) {
      this.renderArt();
      this.notify();
    }
  }

  // ---- layers ----
  setLayerCap(n: number): void {
    this.doc.setLayerCap(n);
    this.notify();
  }
  get layerCap(): number {
    return this.doc.layerCap;
  }
  get canAddLayer(): boolean {
    return this.doc.canAddLayer;
  }
  get layers(): LayerSummary[] {
    return this.doc.summaries();
  }
  get activeLayerId(): string {
    return this.doc.activeLayerId;
  }

  /** Add a layer above the active one, inheriting its symmetry. Null at the cap. */
  addLayer(): string | null {
    const id = this.doc.addLayer();
    if (id) this.afterDocChange();
    return id;
  }
  duplicateLayer(id?: string): string | null {
    const newId = this.doc.duplicateLayer(id);
    if (newId) this.afterDocChange();
    return newId;
  }
  removeLayer(id?: string): boolean {
    const ok = this.doc.removeLayer(id);
    if (ok) this.afterDocChange();
    return ok;
  }
  moveLayer(id: string, toIndex: number): boolean {
    const ok = this.doc.moveLayer(id, toIndex);
    if (ok) this.afterDocChange();
    return ok;
  }
  setActiveLayer(id: string): boolean {
    const ok = this.doc.setActiveLayer(id);
    if (ok) this.afterDocChange();
    return ok;
  }
  setLayerVisible(id: string, visible: boolean): boolean {
    const ok = this.doc.setLayerVisible(id, visible);
    if (ok) this.afterDocChange();
    return ok;
  }
  setLayerName(id: string, name: string): boolean {
    const ok = this.doc.setLayerName(id, name);
    if (ok) this.notify();
    return ok;
  }
  setLayerOpacity(id: string, value: number, coalesce = false): boolean {
    const ok = this.doc.setLayerOpacity(id, value, coalesce);
    if (ok) {
      this.renderArt();
      this.notify();
    }
    return ok;
  }
  /** Seal an opacity drag so the next change starts a fresh undo step. */
  endLayerOpacityGesture(): void {
    this.doc.endOpacityGesture();
  }
  setLayerSym(id: string, sym: Symmetry): boolean {
    const ok = this.doc.setLayerSym(id, sym);
    if (ok) this.afterDocChange();
    return ok;
  }

  /**
   * Find the stroke under a point given in NORMALIZED canvas coordinates.
   * Searches visible layers top-first and, within a layer, the newest stroke
   * first — the same order a user reads the stack.
   */
  hitTestStroke(x: number, y: number): StrokeHit | null {
    return hitTestDrawing(this.doc.drawing, x, y, HIT_SLACK_PX / this.half);
  }

  deleteStroke(layerId: string, index: number): boolean {
    const ok = this.doc.deleteStroke(layerId, index);
    if (ok) {
      this.renderArt();
      this.notify();
    }
    return ok;
  }

  get canUndo(): boolean {
    return this.doc.canUndo;
  }
  get canRedo(): boolean {
    return this.doc.canRedo;
  }
  get strokeCount(): number {
    return this.doc.totalStrokes;
  }
  get toolState(): Readonly<ToolState> {
    return this.state;
  }

  /** Snapshot the current drawing as the vector model. */
  getDrawing(): DrawingV2 {
    return this.doc.drawing;
  }

  /** Load a drawing (also sets background from it). Drops history. */
  loadDrawing(d: DrawingV2): void {
    this.state.bg = d.bg;
    this.doc.load(d);
    this.syncSymFromActive();
    this.renderGrid();
    this.renderArt();
    this.notify();
  }

  destroy(): void {
    cancelAnimationFrame(this.rafId);
    this.ro?.disconnect();
    this.live.removeEventListener("pointerdown", this.onDown);
    this.live.removeEventListener("pointermove", this.onMove);
    this.live.removeEventListener("pointerup", this.onUp);
    this.live.removeEventListener("pointercancel", this.onUp);
    this.live.removeEventListener("pointerleave", this.onUp);
    this.grid.remove();
    this.art.remove();
    this.live.remove();
  }
}

type AnyCtx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/**
 * Paint a list of strokes across all symmetry images into a 2D context whose
 * coordinate space is CSS pixels with the top-left at (0,0). Exported so the
 * PNG/replay exporters can reuse the exact same draw path at any resolution.
 *
 * FROZEN by test/unit/render-trace.test.ts: the operation sequence this issues
 * for a stored v1 drawing is the golden that pins every existing gallery piece
 * to its rasterized PNG. Change it and that snapshot moves.
 */
export function paintStrokes(
  ctx: AnyCtx,
  strokes: readonly Stroke[],
  width: number,
  height: number,
  half: number,
  sym: { segments: number; mirror: boolean },
): void {
  // Note: callers clear (live/art canvases) or fill a background (exports)
  // before calling this — we do not clear here, so an export's bg survives.
  const cx = width / 2;
  const cy = height / 2;
  for (const stroke of strokes) {
    forEachImage(sym.segments, sym.mirror, (image) => {
      ctx.save();
      ctx.translate(cx, cy);
      applyImageTransform(ctx, image);
      drawStroke(ctx, stroke, half);
      ctx.restore();
    });
  }
}

export interface PaintDrawingOptions {
  /** An in-progress stroke to render as if it were already in its layer. */
  liveStroke?: Stroke | null;
  /** Which layer the live stroke belongs to. */
  liveLayerId?: string | null;
}

/**
 * Paint a whole v2 drawing: visible layers bottom → top, each under its own
 * symmetry, each flattened and then composited at its layer opacity.
 *
 * THE ONE RULE THAT MATTERS: a single visible layer at opacity 1 bypasses the
 * offscreen buffer entirely and paints straight into `ctx`. This is not an
 * optimization. `glow` sets `globalCompositeOperation = "lighter"`, so it blends
 * additively against whatever is already on the destination — the export's
 * background fill, or ink from an earlier stroke. Routed through an offscreen
 * buffer it would instead blend against transparent black and come out a
 * different picture. Every piece in the live gallery is a single-layer v1
 * drawing whose stored PNG came off the direct path, so the bypass is what keeps
 * them all rendering as they were saved.
 *
 * A consequence worth knowing rather than smoothing over: hiding one of two
 * layers moves a drawing onto the bypass path, so a glow stroke can shift
 * slightly when you toggle the other layer's eye. That falls out of the rule.
 */
export function paintDrawing(
  ctx: AnyCtx,
  drawing: DrawingV2,
  width: number,
  height: number,
  half: number,
  opts: PaintDrawingOptions = {},
): void {
  const visible = drawing.layers.filter((l) => l.visible);
  if (visible.length === 0) return;
  const bypass = visible.length === 1 && visible[0].opacity === 1;

  for (const layer of visible) {
    const strokes = strokesFor(layer, opts);
    if (strokes.length === 0) continue;

    if (bypass) {
      paintStrokes(ctx, strokes, width, height, half, layer.sym);
      continue;
    }

    const buf = makeLayerBuffer(ctx);
    paintStrokes(buf.ctx, strokes, width, height, half, layer.sym);
    ctx.save();
    // The buffer matches the destination's backing store exactly, so composite
    // it in device pixels: any CSS-unit drawImage would resample by the DPR
    // rounding difference between ceil(w*dpr) and the canvas's floor(w*dpr).
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = layer.opacity;
    ctx.globalCompositeOperation = "source-over";
    ctx.drawImage(buf.canvas, 0, 0);
    ctx.restore();
  }
}

function strokesFor(layer: Layer, opts: PaintDrawingOptions): readonly Stroke[] {
  const live = opts.liveStroke;
  if (!live || opts.liveLayerId !== layer.id) return layer.strokes;
  return [...layer.strokes, live];
}

/**
 * An offscreen surface with the destination's exact backing-store geometry and
 * transform, so compositing it back is a 1:1 device-pixel copy.
 */
function makeLayerBuffer(ctx: AnyCtx): { canvas: HTMLCanvasElement | OffscreenCanvas; ctx: AnyCtx } {
  const dest = ctx.canvas as { width?: number; height?: number } | undefined;
  const w = Math.max(1, Math.floor(dest?.width ?? 1));
  const h = Math.max(1, Math.floor(dest?.height ?? 1));

  let canvas: HTMLCanvasElement | OffscreenCanvas;
  if (typeof OffscreenCanvas !== "undefined") {
    canvas = new OffscreenCanvas(w, h);
  } else if (typeof document !== "undefined") {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    canvas = c;
  } else {
    throw new Error("layer compositing needs OffscreenCanvas or a DOM canvas");
  }

  const bctx = canvas.getContext("2d") as AnyCtx | null;
  if (!bctx) throw new Error("layer compositing: no 2d context");
  if (typeof ctx.getTransform === "function") bctx.setTransform(ctx.getTransform());
  return { canvas, ctx: bctx };
}

// ---- hit testing ---------------------------------------------------------

export interface StrokeHit {
  layerId: string;
  index: number;
}

/**
 * The stroke under a normalized point, or null.
 *
 * A symmetric drawing shows each stroke N (or 2N) times, and the user expects to
 * be able to tap ANY of those images. Rather than expanding every stroke into
 * its images, the point is inverse-transformed into each image's frame and
 * tested against the single stored polyline — N cheap transforms instead of N
 * copies of the geometry.
 *
 * `tolerance` is extra slack in normalized units, added to the stroke's own
 * half-width so a fat stroke is easier to hit than a hairline.
 */
export function hitTestDrawing(
  drawing: DrawingV2,
  x: number,
  y: number,
  tolerance: number,
): StrokeHit | null {
  for (let li = drawing.layers.length - 1; li >= 0; li--) {
    const layer = drawing.layers[li];
    if (!layer.visible) continue;

    // Precompute the point in every image frame once for the whole layer.
    const probes: Array<{ x: number; y: number }> = [];
    forEachImage(layer.sym.segments, layer.sym.mirror, (image) => {
      probes.push(inverseTransformPoint(image, x, y));
    });

    for (let si = layer.strokes.length - 1; si >= 0; si--) {
      const stroke = layer.strokes[si];
      const reach = stroke.size / 2 / REFERENCE_HALF + tolerance;
      for (const p of probes) {
        if (strokeContains(stroke, p.x, p.y, reach)) return { layerId: layer.id, index: si };
      }
    }
  }
  return null;
}

function strokeContains(stroke: Stroke, x: number, y: number, reach: number): boolean {
  const pts = stroke.pts;
  if (pts.length === 0) return false;
  if (pts.length === 1) {
    return Math.hypot(x - pts[0][0], y - pts[0][1]) <= reach;
  }
  for (let i = 1; i < pts.length; i++) {
    if (distToSegment(x, y, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) <= reach) {
      return true;
    }
  }
  return false;
}

function distToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
