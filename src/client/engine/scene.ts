// The live drawing engine: three stacked canvases (grid / art / live), DPR-aware
// sizing, a requestAnimationFrame render loop, and pointer input with coalesced
// events + pressure. Framework-free — the Preact <Canvas> just mounts it into a
// host element and forwards tool changes. All rendering goes through the shared
// symmetry + brush modules so the screen matches every exporter exactly.

import {
  forEachImage,
  applyImageTransform,
  clampSegments,
} from "./symmetry";
import {
  drawStroke,
} from "./brush";
import { History } from "./history";
import {
  emptyDrawing,
  halfAxis,
  toNormalized,
  type Background,
  type BrushTool,
  type Drawing,
  type Pt,
  type Stroke,
} from "./strokes";

export interface ToolState {
  tool: BrushTool;
  color: string;
  size: number;
  opacity: number;
  segments: number;
  mirror: boolean;
  bg: Background;
  showGuides: boolean;
}

export interface SceneCallbacks {
  onHistoryChange?: (canUndo: boolean, canRedo: boolean, count: number) => void;
}

const MAX_DPR = 3;
const DEFAULT_PRESSURE = 0.5;

function readVar(name: string, fallback: string): string {
  if (typeof getComputedStyle === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export class Scene {
  private host: HTMLElement;
  private grid: HTMLCanvasElement;
  private art: HTMLCanvasElement;
  private live: HTMLCanvasElement;
  private gctx: CanvasRenderingContext2D;
  private actx: CanvasRenderingContext2D;
  private lctx: CanvasRenderingContext2D;

  private history = new History();
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

  constructor(host: HTMLElement, initial: ToolState, cb: SceneCallbacks = {}) {
    this.host = host;
    this.state = { ...initial, segments: clampSegments(initial.segments) };
    this.cb = cb;

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

    const bg = readVar("--color-graph", this.state.bg === "dark" ? "#13202A" : "#EEF0EC");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    // graph-paper grid
    const fine = readVar("--color-grid-line", "rgba(46,94,140,.07)");
    const bold = readVar("--color-crease-line", "rgba(46,94,140,.13)");
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

  private renderGuides(): void {
    const ctx = this.gctx;
    const n = this.state.segments;
    const r = Math.max(this.cssW, this.cssH);
    const color = readVar("--color-crease-line-bold", "rgba(46,94,140,.28)");
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
    if (this.state.mirror) {
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
  private renderArt(): void {
    paintStrokes(this.actx, this.history.strokes, this.cssW, this.cssH, this.half, this.state);
  }

  private renderLive(): void {
    const ctx = this.lctx;
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    if (this.drawingStroke && this.drawingStroke.pts.length > 0) {
      paintStrokes(ctx, [this.drawingStroke], this.cssW, this.cssH, this.half, this.state);
    }
  }

  private loop = (): void => {
    if (this.liveDirty) {
      this.liveDirty = false;
      this.renderLive();
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
    this.live.setPointerCapture(e.pointerId);
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
      this.history.commit(stroke);
      this.renderArt();
      this.notify();
    }
  };

  private notify(): void {
    this.cb.onHistoryChange?.(this.history.canUndo, this.history.canRedo, this.history.strokes.length);
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
  setSegments(n: number): void {
    this.state.segments = clampSegments(n);
    this.renderGrid();
    this.renderArt();
  }
  setMirror(m: boolean): void {
    this.state.mirror = m;
    this.renderGrid();
    this.renderArt();
  }
  setBackground(bg: Background): void {
    this.state.bg = bg;
    this.renderGrid();
    this.renderArt();
  }
  setShowGuides(s: boolean): void {
    this.state.showGuides = s;
    this.renderGrid();
  }

  undo(): void {
    if (this.history.undo()) {
      this.renderArt();
      this.notify();
    }
  }
  redo(): void {
    if (this.history.redo()) {
      this.renderArt();
      this.notify();
    }
  }
  clear(): void {
    if (this.history.clear()) {
      this.renderArt();
      this.notify();
    }
  }

  get canUndo(): boolean {
    return this.history.canUndo;
  }
  get canRedo(): boolean {
    return this.history.canRedo;
  }
  get strokeCount(): number {
    return this.history.strokes.length;
  }
  get toolState(): Readonly<ToolState> {
    return this.state;
  }

  /** Snapshot the current drawing as the vector model. */
  getDrawing(): Drawing {
    const d = emptyDrawing(this.state.bg, {
      segments: this.state.segments,
      mirror: this.state.mirror,
    });
    d.strokes = [...this.history.strokes];
    return d;
  }

  /** Load a drawing (also sets symmetry/bg from it). Drops history. */
  loadDrawing(d: Drawing): void {
    this.state.bg = d.bg;
    this.state.segments = clampSegments(d.sym.segments);
    this.state.mirror = d.sym.mirror;
    this.history.reset(d.strokes as Stroke[]);
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

/**
 * Paint a list of strokes across all symmetry images into a 2D context whose
 * coordinate space is CSS pixels with the top-left at (0,0). Exported so the
 * PNG/replay exporters can reuse the exact same draw path at any resolution.
 */
export function paintStrokes(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  strokes: readonly Stroke[],
  width: number,
  height: number,
  half: number,
  sym: { segments: number; mirror: boolean },
): void {
  ctx.clearRect(0, 0, width, height);
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
