// The live drawing engine: three stacked canvases (grid / art / live), DPR-aware
// sizing, a requestAnimationFrame render loop, and pointer input with coalesced
// events + pressure. Framework-free — the Preact <Canvas> just mounts it into a
// host element and forwards tool changes. All rendering goes through the shared
// symmetry + brush modules so the screen matches every exporter exactly.
//
// v2 adds layers. The document (layers, per-layer symmetry, undo) lives in
// DrawingDoc; this class owns pixels, input and the render loop only.
//
// It also owns the VIEW — a 1–8× zoom plus a pan, applied when painting and
// inverted when reading a pointer. The view is not part of the document: the
// symmetry centre is the drawing's centre wherever that has been panned to, and
// every export re-renders from `getDrawing()`, so what is on screen has no say
// in what gets saved.

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
  applyPressureGamma,
  clampSegments,
  emptyDrawing,
  halfAxis,
  toNormalized,
  type Background,
  type BrushTool,
  type DrawingV2,
  type Layer,
  type PressurePreset,
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
  /** Fires whenever zoom or pan changes. Drives the zoom badge (T06b). */
  onViewChange?: (view: Readonly<View>) => void;
  /**
   * Fires the first time this Scene sees a pen, and not again.
   *
   * The brush popover keeps its pressure section hidden until a pen has been
   * seen, because a preset that shapes nothing is a control that lies. Only the
   * engine knows — `pointerType` never reaches the UI — so it has to be
   * announced rather than derived.
   */
  onPenSeen?: () => void;
  /**
   * Fires when a finished stroke was DISCARDED because the active layer is
   * hidden. Carries that layer's name so the UI can say which one.
   *
   * The engine refuses rather than storing invisible ink; the nudge that tells
   * the user is the UI's job, and without it the stroke just vanishes.
   */
  onHiddenLayerRefusal?: (layerName: string) => void;
}

export interface SceneOptions {
  /** Max layers this account may ADD. Never limits loading or editing. */
  layerCap?: number;
  /** Whether a bare finger draws. Off means one finger pans. */
  drawWithFinger?: boolean;
}

const MAX_DPR = 3;
const DEFAULT_PRESSURE = 0.5;
/** Extra tap slack for hit-testing, in CSS px on top of the stroke's own width. */
const HIT_SLACK_PX = 8;

/** A non-drawing gesture counts as a tap below this much movement / duration. */
const TAP_SLOP_PX = 10;
const TAP_MS = 300;
/** How far apart two taps may be, in time and space, and still be a double tap. */
const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_SLOP_PX = 32;

// ---- view transform -------------------------------------------------------
//
// The view is a pan/zoom applied at PAINT time only. It never touches the
// document: stored coordinates are always in the drawing's own normalized space,
// so exports, hashes and the symmetry centre are all completely unaware of it.
//
// Screen (CSS px, canvas top-left) and drawing (CSS px, canvas top-left) space
// relate by `screen = translate + scale * drawing`, which is exactly what
// `ctx.translate(tx, ty); ctx.scale(s, s)` does. Everything that consumes a
// pointer position therefore inverts it: `drawing = (screen - translate) / scale`.

export interface View {
  /** 1 = fit, MAX_SCALE = fully zoomed in. */
  scale: number;
  /** Screen-space offset in CSS px, applied BEFORE the scale. */
  tx: number;
  ty: number;
}

export const MIN_SCALE = 1;
export const MAX_SCALE = 8;

/** The view a fresh canvas starts at, and what double-tap restores. */
export const IDENTITY_VIEW: Readonly<View> = { scale: 1, tx: 0, ty: 0 };

/**
 * The screen-space move below which a captured point is dropped, in CSS px.
 * Small enough to keep a deliberate curve, big enough to throw away the jitter
 * a 240 Hz digitiser reports while the hand is still.
 */
const MIN_POINT_DIST_PX = 1.1;

export function clampScale(s: number): number {
  // NaN only: it survives Math.max/min and would poison the whole view, where
  // ±Infinity clamps to the ends perfectly well. A pinch with both fingers in
  // the same place is the way this actually arrives.
  if (Number.isNaN(s)) return MIN_SCALE;
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));
}

export function isIdentityView(v: Readonly<View>): boolean {
  return v.scale === 1 && v.tx === 0 && v.ty === 0;
}

/** Screen CSS px (canvas-relative) → drawing CSS px. The inverse of the paint transform. */
export function screenToDrawing(
  v: Readonly<View>,
  sx: number,
  sy: number,
): { x: number; y: number } {
  return { x: (sx - v.tx) / v.scale, y: (sy - v.ty) / v.scale };
}

/** Drawing CSS px → screen CSS px (canvas-relative). */
export function drawingToScreen(
  v: Readonly<View>,
  dx: number,
  dy: number,
): { x: number; y: number } {
  return { x: v.tx + v.scale * dx, y: v.ty + v.scale * dy };
}

/**
 * Scale by `factor` while pinning the drawing point currently under
 * (`ax`, `ay`) to that same screen position — the behaviour every pinch and
 * ctrl+wheel expects. When the scale clamps, the translate is left alone
 * (`s' === s` makes the formula the identity), so a pinch past the limit does
 * not creep.
 */
export function zoomedView(
  v: Readonly<View>,
  ax: number,
  ay: number,
  factor: number,
): View {
  const scale = clampScale(v.scale * factor);
  const d = screenToDrawing(v, ax, ay);
  return { scale, tx: ax - scale * d.x, ty: ay - scale * d.y };
}

/** How much of the drawing must stay on screen, in CSS px, per axis. */
const MIN_VISIBLE_PX = 48;

/**
 * The only pan limit: some of the drawing has to stay on screen, so a piece can
 * never be panned into nothing.
 *
 * Deliberately weak, and weaker than the first version of this function, which
 * required the drawing's CENTRE to stay visible. That sounds reasonable and is
 * wrong: at 8x it makes every region away from the middle unreachable, which is
 * the one thing zoom exists for. It also silently broke the anchor of any zoom
 * that was not centred, so a ctrl+wheel at the edge crept.
 *
 * A tighter rule would also participate in the coordinate arithmetic of every
 * gesture, and double-tap already restores the identity view, so there is little
 * to rescue the user from.
 */
export function clampView(v: Readonly<View>, cssW: number, cssH: number): View {
  const scale = clampScale(v.scale);
  return {
    scale,
    tx: clampAxis(v.tx, scale * cssW, cssW),
    ty: clampAxis(v.ty, scale * cssH, cssH),
  };
}

/** Keep [t, t + extent] overlapping [0, viewport] by at least MIN_VISIBLE_PX. */
function clampAxis(t: number, extent: number, viewport: number): number {
  if (!Number.isFinite(t)) return 0;
  const m = Math.min(MIN_VISIBLE_PX, extent, viewport);
  return Math.max(m - extent, Math.min(viewport - m, t));
}

/**
 * Minimum stored move, in NORMALIZED units, for a point to be kept.
 *
 * Divided by the view scale, which is the whole point: at 8× a 1.1 px twitch of
 * the hand is an eighth of a drawing pixel, and dropping it would quantise the
 * stroke to a visible staircase exactly where the user zoomed in to get detail.
 * Dividing keeps the threshold at a constant ~1.1 px OF SCREEN at every zoom.
 */
export function minPointDistance(half: number, scale: number): number {
  return MIN_POINT_DIST_PX / (half * scale);
}

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
  /** Capture-time pressure curve. Applied to `p` before it is stored, so a
   *  drawing never changes appearance when this setting later changes. */
  private pressurePreset: PressurePreset = "normal";
  /** Whether pen pressure also drives alpha (`po`). Pen input only. */
  private pressureOpacity = false;
  /** New strokes carry `sm` unless this is off. Mirrors S.smoothStrokes. */
  private smoothStrokes = true;
  /** Latches on the first pen event; see SceneCallbacks.onPenSeen. */
  private penSeen = false;
  private liveDirty = false;
  private rafId = 0;
  private ro: ResizeObserver | null = null;

  // ---- view / gesture state ----
  private viewState: View = { ...IDENTITY_VIEW };
  /** Whether a bare finger draws. Off means one finger pans instead. */
  private drawWithFinger = true;
  /** Space held with the canvas (not a control) focused → drag pans. */
  private spaceHeld = false;
  /** Pointer currently panning with one finger / space-drag, if any. */
  private panPointer: number | null = null;
  private panLast: { x: number; y: number } | null = null;
  /** Live touch points, keyed by pointerId — the source of truth for "two fingers". */
  private touches = new Map<number, { x: number; y: number }>();
  /** Set while two or more fingers are down. Non-null means NOTHING draws. */
  private pinch: { dist: number; midX: number; midY: number } | null = null;
  /** Where and when a non-drawing gesture started, for tap detection. */
  private tapStart: { x: number; y: number; t: number; moved: number } | null = null;
  private lastTap: { x: number; y: number; t: number } | null = null;

  constructor(host: HTMLElement, initial: ToolState, cb: SceneCallbacks = {}, opts: SceneOptions = {}) {
    this.host = host;
    this.drawWithFinger = opts.drawWithFinger ?? true;
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
    // The view SURVIVES a resize — rotating an iPad must not throw away the zoom
    // the user set. Only re-clamp it, because the new viewport may no longer
    // contain the drawing centre. At the identity view this is a no-op, so a
    // fresh mount never moves.
    this.setViewInternal(this.viewState, false);
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

    // Graph-paper grid. The paper belongs to the DRAWING, so it zooms and pans
    // with it — but it is drawn in SCREEN space rather than under the view
    // transform, because the whole point of the `Math.round(x) + 0.5` phase is a
    // crisp one-device-pixel line. Snapping in drawing space and then scaling by
    // a fractional zoom lands the line back off the pixel grid and it goes soft.
    // So: the spacing is scaled, the position is snapped, the width stays 1.
    const step = 24;
    ctx.lineWidth = 1;
    this.strokeGridLines(step, theme.fine);
    this.strokeGridLines(step * 5, theme.bold);

    if (this.state.showGuides) this.renderGuides();
  }

  /** Screen x/y of the drawing's centre — the origin every grid line is phased from. */
  private get centerScreen(): { x: number; y: number } {
    return drawingToScreen(this.viewState, this.cssW / 2, this.cssH / 2);
  }

  private strokeGridLines(stepDrawing: number, color: string): void {
    const ctx = this.gctx;
    const w = this.cssW;
    const h = this.cssH;
    const step = stepDrawing * this.viewState.scale;
    // Fully zoomed out the step is 24 px; there is no zoom level where this is
    // small enough to matter, but a non-finite view would spin forever.
    if (!(step > 0.5)) return;
    const origin = this.centerScreen;

    ctx.strokeStyle = color;
    ctx.beginPath();
    // First line at or after the left/top edge: origin + k*step >= 0.
    for (let x = origin.x + Math.ceil(-origin.x / step) * step; x < w; x += step) {
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, h);
    }
    for (let y = origin.y + Math.ceil(-origin.y / step) * step; y < h; y += step) {
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(w, Math.round(y) + 0.5);
    }
    ctx.stroke();
  }

  // Guides show the ACTIVE layer's symmetry — they are drawing aids for the
  // stroke about to be made, not a description of the whole piece.
  private renderGuides(): void {
    const ctx = this.gctx;
    const sym = this.doc.activeLayer.sym;
    const n = sym.segments;
    // The guides radiate from the DRAWING's centre, which the view can push off
    // screen, so the rays have to be long enough to still cross the viewport
    // from wherever that centre now is. They are clipped, so over-reaching costs
    // nothing; falling short would leave a visible stub.
    const origin = this.centerScreen;
    const r =
      Math.hypot(this.cssW, this.cssH) + Math.hypot(origin.x, origin.y) + Math.max(this.cssW, this.cssH);
    const color = THEME[this.state.bg].guide;
    ctx.save();
    ctx.translate(origin.x, origin.y);
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

  /**
   * Run `paint` with the view transform in effect.
   *
   * At the identity view this issues NOTHING: no save, no translate, no scale.
   * Same shape as T04's guard on `globalAlpha`.
   *
   * Honest note on why, because the obvious justification is wrong and someone
   * will eventually check: `translate(0, 0); scale(1, 1)` is a bit-exact no-op
   * in canvas 2D, so removing this guard does NOT break `v1-render.spec.ts`
   * (verified by deleting it — all six tests still pass). What it buys is that
   * the engine's paint path stays literally the pre-view path at 1x, with no
   * matrix multiply between `paintDrawing` and the pixels that render-trace
   * pins, and no room for a future non-integer view state to round. That is
   * pinned directly by "the engine adds no transform of its own at 1x" in
   * test/e2e/zoom-pan.spec.ts rather than left to the goldens, which cannot see
   * it.
   *
   * Callers clear the canvas BEFORE calling this, at the base DPR transform:
   * a `clearRect(0, 0, cssW, cssH)` under a pan would miss most of the canvas.
   */
  private withView(ctx: AnyCtx, paint: () => void): void {
    if (isIdentityView(this.viewState)) {
      paint();
      return;
    }
    ctx.save();
    ctx.translate(this.viewState.tx, this.viewState.ty);
    ctx.scale(this.viewState.scale, this.viewState.scale);
    paint();
    ctx.restore();
  }

  private renderArt(): void {
    this.actx.clearRect(0, 0, this.cssW, this.cssH);
    const live =
      !this.liveOnOverlay && this.drawingStroke && this.drawingStroke.pts.length > 0
        ? this.drawingStroke
        : null;
    this.withView(this.actx, () => {
      paintDrawing(this.actx, this.doc.drawing, this.cssW, this.cssH, this.half, {
        liveStroke: live,
        liveLayerId: this.doc.activeLayerId,
      });
    });
  }

  private renderLive(): void {
    const ctx = this.lctx;
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    if (!this.liveOnOverlay) return;
    if (this.drawingStroke && this.drawingStroke.pts.length > 0) {
      this.withView(ctx, () => {
        paintStrokes(
          ctx,
          [this.drawingStroke!],
          this.cssW,
          this.cssH,
          this.half,
          this.doc.activeLayer.sym,
        );
      });
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
    // passive:false — a zoom gesture that also scrolls the page is unusable, and
    // the default for wheel on a listener like this is passive in every engine.
    this.live.addEventListener("wheel", this.onWheel, { passive: false });
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    // Space is a held modifier, so a lost window is a stuck one.
    window.addEventListener("blur", this.onWindowBlur);
  }

  /** Canvas-relative screen position of an event, in CSS px. */
  private screenOf(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const rect = this.live.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private pointFromEvent(e: PointerEvent): Pt {
    const s = this.screenOf(e);
    // Un-apply the view before normalizing. Everything downstream — the stored
    // point, the symmetry centre, the content hash — is in the drawing's space,
    // which is what makes a stroke drawn at 8× land in the same place it would
    // have at 1×.
    const d = screenToDrawing(this.viewState, s.x, s.y);
    const { x, y } = toNormalized(d.x, d.y, this.cssW, this.cssH);
    // Gamma is applied HERE, at capture, and the adjusted value is what gets
    // stored — so the preset is a property of the hand that drew, not of the
    // document.
    //
    // PEN ONLY, like `po`. A mouse or finger reports no pressure and falls back
    // to a flat DEFAULT_PRESSURE, which has no dynamics for a preset to shape —
    // it would just scale every stroke's width by a constant (Firm made a mouse
    // draw ~16% thinner) from a control the UI never shows, since the brush
    // popover hides the pressure section until a pen has been seen.
    // Settled with Anmol 2026-08-28.
    if (e.pointerType !== "pen" || !(e.pressure > 0)) return [x, y, DEFAULT_PRESSURE];
    return [x, y, applyPressureGamma(e.pressure, this.pressurePreset)];
  }

  /** Latch and announce the first pen. Cheap enough to call on every event. */
  private notePointer(e: PointerEvent): void {
    if (this.penSeen || e.pointerType !== "pen") return;
    this.penSeen = true;
    this.cb.onPenSeen?.();
  }

  private onDown = (e: PointerEvent): void => {
    this.notePointer(e);
    const s = this.screenOf(e);
    if (e.pointerType === "touch") this.touches.set(e.pointerId, s);

    // A second finger converts whatever was happening into a pinch, and the
    // stroke the first finger had started is THROWN AWAY rather than committed.
    // Two-finger gestures never draw — including the half-stroke that precedes
    // one, which is the part a naive implementation leaves behind as a stray
    // mark every time the user zooms.
    if (this.touches.size >= 2) {
      this.abortStroke();
      this.endPan();
      this.beginPinch();
      this.capture(e.pointerId);
      e.preventDefault();
      return;
    }
    if (this.pinch) return;

    // Space-drag, or one finger when finger-drawing is off. Pen and mouse always
    // draw: `drawWithFinger` is about the hand resting on an iPad, and gating on
    // anything other than "touch" would disable the mouse.
    if (this.spaceHeld || (e.pointerType === "touch" && !this.drawWithFinger)) {
      if (this.activePointer !== null || this.panPointer !== null) return;
      e.preventDefault();
      this.beginPan(e.pointerId, s);
      return;
    }

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
      // Below 3 points there is no interior to smooth and the renderer falls
      // back to the polyline anyway, so the flag is harmless on a tap.
      // Omitted entirely when the toggle is off, which renders exactly as a v1
      // stroke does — the two kinds coexist in one drawing.
      ...(this.smoothStrokes ? { sm: 1 as const } : {}),
      // Pressure-to-opacity is pen-only: a mouse or finger reports a constant
      // 0.5, so honouring it there would just dim every stroke by a fixed
      // amount for no expressive gain.
      ...(this.pressureOpacity && e.pointerType === "pen" ? { po: 1 as const } : {}),
      pts: [this.pointFromEvent(e)],
    };
    this.liveDirty = true;
  };

  private onMove = (e: PointerEvent): void => {
    // Also here, not only on pointerdown: a pen HOVERING over the canvas is
    // very much a pen having been seen, and on iPad that happens before the
    // user ever touches down.
    this.notePointer(e);
    if (e.pointerType === "touch" && this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, this.screenOf(e));
    }
    if (this.pinch) {
      e.preventDefault();
      this.updatePinch();
      return;
    }
    if (this.panPointer === e.pointerId) {
      e.preventDefault();
      this.updatePan(this.screenOf(e));
      return;
    }

    if (this.activePointer !== e.pointerId || !this.drawingStroke) return;
    e.preventDefault();
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    const minDist = minPointDistance(this.half, this.viewState.scale);
    const pts = this.drawingStroke.pts;
    for (const ev of events.length ? events : [e]) {
      const p = this.pointFromEvent(ev);
      const prev = pts[pts.length - 1];
      if (!prev || Math.hypot(p[0] - prev[0], p[1] - prev[1]) >= minDist) pts.push(p);
    }
    this.liveDirty = true;
  };

  private onUp = (e: PointerEvent): void => {
    if (e.pointerType === "touch") this.touches.delete(e.pointerId);

    if (this.pinch) {
      // Hold the gesture until EVERY finger is up. Ending it at the first lift
      // would hand the remaining finger back to the drawing path mid-pinch and
      // leave a mark across the piece.
      if (this.touches.size === 0) {
        this.pinch = null;
        this.endGestureTap();
      }
      this.release(e.pointerId);
      return;
    }
    if (this.panPointer === e.pointerId) {
      this.endPan();
      this.endGestureTap();
      this.release(e.pointerId);
      return;
    }

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
      const active = this.doc.activeLayer;
      if (!this.doc.commitStroke(stroke)) {
        // Refused: the active layer is hidden, so this stroke was never visible
        // and is not kept. Tell the UI which layer so it can offer to show it.
        this.cb.onHiddenLayerRefusal?.(active.name);
        this.renderArt();
        this.notify();
        return;
      }
      this.renderArt();
      this.notify();
    }
  };

  private notify(): void {
    this.cb.onHistoryChange?.(this.doc.canUndo, this.doc.canRedo, this.doc.totalStrokes);
    this.cb.onLayersChange?.(this.doc.summaries(), this.doc.activeLayerId);
  }

  // ---- gestures ------------------------------------------------------------

  private capture(id: number): void {
    try {
      this.live.setPointerCapture(id);
    } catch {
      /* synthetic events / unsupported */
    }
  }
  private release(id: number): void {
    try {
      this.live.releasePointerCapture(id);
    } catch {
      /* ignore */
    }
  }

  /**
   * Discard the in-progress stroke without committing it.
   *
   * Every field the drawing path reads is reset, so the `pointerup` that will
   * still arrive for that pointer finds nothing to resurrect: `activePointer` no
   * longer matches and `drawingStroke` is null, which is what the guard at the
   * top of `onUp`'s drawing branch tests.
   */
  private abortStroke(): void {
    if (this.activePointer !== null) this.release(this.activePointer);
    this.activePointer = null;
    const had = this.drawingStroke !== null;
    this.drawingStroke = null;
    this.lctx.clearRect(0, 0, this.cssW, this.cssH);
    // The stroke may have been rendered into the stack rather than the overlay.
    if (had && !this.liveOnOverlay) this.renderArt();
  }

  private beginPan(id: number, at: { x: number; y: number }): void {
    this.panPointer = id;
    this.panLast = at;
    this.tapStart = { x: at.x, y: at.y, t: Date.now(), moved: 0 };
    this.capture(id);
    this.live.style.cursor = "grabbing";
  }

  private updatePan(at: { x: number; y: number }): void {
    if (!this.panLast) return;
    const dx = at.x - this.panLast.x;
    const dy = at.y - this.panLast.y;
    this.panLast = at;
    if (this.tapStart) this.tapStart.moved += Math.hypot(dx, dy);
    this.panBy(dx, dy);
  }

  private endPan(): void {
    if (this.panPointer === null) return;
    this.panPointer = null;
    this.panLast = null;
    this.live.style.cursor = this.spaceHeld ? "grab" : "crosshair";
  }

  private beginPinch(): void {
    const m = this.touchMetrics();
    if (!m) return;
    this.pinch = m;
    this.tapStart = { x: m.midX, y: m.midY, t: Date.now(), moved: 0 };
  }

  private updatePinch(): void {
    const m = this.touchMetrics();
    if (!m || !this.pinch) return;
    const prev = this.pinch;
    this.pinch = m;
    const dx = m.midX - prev.midX;
    const dy = m.midY - prev.midY;
    if (this.tapStart) this.tapStart.moved += Math.hypot(dx, dy) + Math.abs(m.dist - prev.dist);
    // Pan by the midpoint's move, then scale about the NEW midpoint, so the two
    // parts of a pinch compose the way the fingers do.
    let next = { ...this.viewState, tx: this.viewState.tx + dx, ty: this.viewState.ty + dy };
    if (prev.dist > 0 && m.dist > 0) next = zoomedView(next, m.midX, m.midY, m.dist / prev.dist);
    this.setViewInternal(next);
  }

  /** Midpoint and spread of the first two live touches. */
  private touchMetrics(): { dist: number; midX: number; midY: number } | null {
    const it = this.touches.values();
    const a = it.next();
    const b = it.next();
    if (a.done || b.done) return null;
    return {
      dist: Math.hypot(b.value.x - a.value.x, b.value.y - a.value.y),
      midX: (a.value.x + b.value.x) / 2,
      midY: (a.value.y + b.value.y) / 2,
    };
  }

  /**
   * A pan/pinch that was really a tap. Two of them in quick succession reset the
   * view.
   *
   * KNOWN LIMIT, deliberate: this only sees gestures that did not draw — a
   * two-finger tap, or a one-finger tap while finger-drawing is off. With finger
   * drawing on, a double tap is two dots of ink and resetting the view under
   * them would be worse than not resetting. `resetView()` is public for the zoom
   * badge (T06b) so there is always a pointer-free way out.
   */
  private endGestureTap(): void {
    const start = this.tapStart;
    this.tapStart = null;
    if (!start) return;
    const now = Date.now();
    if (start.moved > TAP_SLOP_PX || now - start.t > TAP_MS) {
      this.lastTap = null;
      return;
    }
    const prev = this.lastTap;
    if (
      prev &&
      now - prev.t <= DOUBLE_TAP_MS &&
      Math.hypot(start.x - prev.x, start.y - prev.y) <= DOUBLE_TAP_SLOP_PX
    ) {
      this.lastTap = null;
      this.resetView();
      return;
    }
    this.lastTap = { x: start.x, y: start.y, t: now };
  }

  private onWheel = (e: WheelEvent): void => {
    // A trackpad pinch is delivered as a wheel event with ctrlKey set — that is
    // the ONLY way the platform exposes it — so this one branch covers both the
    // documented ctrl/⌘+wheel shortcut and a real two-finger pinch on a Mac.
    e.preventDefault();
    const at = this.screenOf(e);
    // deltaMode 1 is lines, 2 is pages; normalize both to something px-like.
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.cssH : 1;
    if (e.ctrlKey || e.metaKey) {
      this.zoomAt(at.x, at.y, Math.exp((-e.deltaY * unit) / 100));
    } else {
      this.panBy(-e.deltaX * unit, -e.deltaY * unit);
    }
  };

  /**
   * Space engages pan-on-drag, but only when the canvas has focus.
   *
   * Space is also how a keyboard user activates a focused button, so swallowing
   * it globally would break every control in the toolbar. Requiring the body or
   * the canvas host to be the active element is the cheap, honest test.
   */
  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.code !== "Space" || e.repeat || this.spaceHeld) return;
    const el = document.activeElement;
    if (el && el !== document.body && !this.host.contains(el)) return;
    e.preventDefault();
    this.spaceHeld = true;
    if (this.panPointer === null) this.live.style.cursor = "grab";
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (e.code !== "Space") return;
    this.spaceHeld = false;
    if (this.panPointer === null) this.live.style.cursor = "crosshair";
  };

  private onWindowBlur = (): void => {
    this.spaceHeld = false;
    if (this.panPointer === null) this.live.style.cursor = "crosshair";
  };

  /** Store a view, clamp it, re-render what it affects, and report upward. */
  private setViewInternal(next: Readonly<View>, render = true): void {
    const v = clampView(next, this.cssW, this.cssH);
    const cur = this.viewState;
    if (v.scale === cur.scale && v.tx === cur.tx && v.ty === cur.ty) return;
    this.viewState = v;
    if (render) {
      this.renderGrid();
      this.renderArt();
      this.renderLive();
    }
    this.cb.onViewChange?.(this.viewState);
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
  /** Capture-time pressure curve for SUBSEQUENT strokes. Never retroactive. */
  /** Whether new strokes carry `sm`. Does not affect strokes already drawn. */
  setSmoothStrokes(on: boolean): void {
    this.smoothStrokes = on;
  }
  setPressurePreset(p: PressurePreset): void {
    this.pressurePreset = p;
  }
  /** Whether a pen's pressure also drives alpha on subsequent strokes. */
  setPressureOpacity(on: boolean): void {
    this.pressureOpacity = on;
  }
  /** Whether a bare finger draws. Off means a single finger pans instead. */
  setDrawWithFinger(on: boolean): void {
    this.drawWithFinger = on;
  }

  // ---- view ----------------------------------------------------------------

  /** The current zoom + pan. The badge (T06b) reads `scale`. */
  getView(): Readonly<View> {
    return this.viewState;
  }
  get zoom(): number {
    return this.viewState.scale;
  }
  /** Whether the view is untouched — the badge hides itself on this. */
  get isDefaultView(): boolean {
    return isIdentityView(this.viewState);
  }

  /** Scale about a canvas-relative screen point, pinning what is under it. */
  zoomAt(screenX: number, screenY: number, factor: number): void {
    this.setViewInternal(zoomedView(this.viewState, screenX, screenY, factor));
  }
  /** Scale about the middle of the viewport — for a button or a shortcut. */
  zoomBy(factor: number): void {
    this.zoomAt(this.cssW / 2, this.cssH / 2, factor);
  }
  /** Move the drawing by a screen-space delta, in CSS px. */
  panBy(dx: number, dy: number): void {
    this.setViewInternal({ ...this.viewState, tx: this.viewState.tx + dx, ty: this.viewState.ty + dy });
  }
  setView(v: Partial<View>): void {
    this.setViewInternal({ ...this.viewState, ...v });
  }
  /** Back to 1×, centred. What double-tap and the badge both do. */
  resetView(): void {
    this.setViewInternal(IDENTITY_VIEW);
  }

  /**
   * A viewport position (`clientX`/`clientY`, i.e. straight off an event) in the
   * drawing's normalized coordinates.
   *
   * Exposed because the view is otherwise the engine's private business:
   * `hitTestStroke` takes normalized coordinates, and a caller that reached for
   * `toNormalized` directly would be silently wrong at every zoom but 1×.
   */
  screenToNormalized(clientX: number, clientY: number): { x: number; y: number } {
    const s = this.screenOf({ clientX, clientY });
    const d = screenToDrawing(this.viewState, s.x, s.y);
    return toNormalized(d.x, d.y, this.cssW, this.cssH);
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
    // The slack is a FINGER, so it is 8 px of screen at every zoom — which is a
    // smaller distance in the drawing the further in you are.
    return hitTestDrawing(this.doc.drawing, x, y, HIT_SLACK_PX / (this.half * this.viewState.scale));
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

  /** Load a drawing (also sets background from it). Drops history and the view. */
  loadDrawing(d: DrawingV2): void {
    this.state.bg = d.bg;
    // A new piece arrives framed, not wherever the last one was left zoomed.
    this.setViewInternal(IDENTITY_VIEW, false);
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
    this.live.removeEventListener("wheel", this.onWheel);
    // The window listeners outlive the canvases — Canvas.tsx builds and tears
    // down a Scene inside a useEffect, so a leaked one would keep answering
    // keystrokes for a dead engine after every remount.
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onWindowBlur);
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
