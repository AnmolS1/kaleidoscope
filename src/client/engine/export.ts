// Exporters — every output is a re-render of the vector model, so PNG/SVG/replay
// all match the screen. PNG/thumb render to an OffscreenCanvas (off the visible
// DOM); SVG is built as a pure string (no DOM, unit-testable); replay captures a
// progressive redraw via MediaRecorder (WebM), with a clean seam for a GIF
// fallback. Square output suits the centered mandala.

import { forEachImage, imageTransformSvg } from "./symmetry";
import { meanPressure, representativeColor, strokeSegments } from "./brush";
import { paintDrawing } from "./scene";
import {
  REFERENCE_HALF,
  pressureAlpha,
  type Background,
  type DrawingV2,
  type Layer,
  type Stroke,
} from "../../shared/vector";

export const BG_COLORS: Record<Background, string> = {
  light: "#EEF0EC",
  dark: "#13202A",
};

const PNG_BASE = 1024; // 1× square edge in px

type OffCtx = OffscreenCanvasRenderingContext2D;

function makeOffscreen(size: number): { canvas: OffscreenCanvas; ctx: OffCtx } {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d") as OffCtx;
  return { canvas, ctx };
}

/** Paint a full drawing (bg + every visible layer) into a square context. */
function renderSquare(ctx: OffCtx | CanvasRenderingContext2D, drawing: DrawingV2, size: number): void {
  ctx.fillStyle = BG_COLORS[drawing.bg];
  ctx.fillRect(0, 0, size, size);
  // paintDrawing, not paintStrokes: exports must composite layers exactly as the
  // screen does, INCLUDING the single-visible-layer-at-opacity-1 bypass. That
  // bypass matters more here than anywhere — the background is already filled,
  // so a glow stroke routed through an offscreen buffer would blend against
  // transparent black instead of against the background and come out wrong.
  paintDrawing(ctx, drawing, size, size, size / 2);
}

/** PNG at 1/2/4×. Returns a Blob. */
export async function exportPNG(drawing: DrawingV2, scale: 1 | 2 | 4 = 1): Promise<Blob> {
  const size = PNG_BASE * scale;
  const { canvas, ctx } = makeOffscreen(size);
  renderSquare(ctx, drawing, size);
  return canvas.convertToBlob({ type: "image/png" });
}

/** Small WebP thumbnail for the gallery / save flow. */
export async function exportThumb(drawing: DrawingV2, size = 512): Promise<Blob> {
  const { canvas, ctx } = makeOffscreen(size);
  renderSquare(ctx, drawing, size);
  return canvas.convertToBlob({ type: "image/webp", quality: 0.85 });
}

/** Full-size WebP render (source for the stored image). */
export async function exportWebP(drawing: DrawingV2, size = PNG_BASE): Promise<Blob> {
  const { canvas, ctx } = makeOffscreen(size);
  renderSquare(ctx, drawing, size);
  return canvas.convertToBlob({ type: "image/webp", quality: 0.92 });
}

/** 1200×630 OG/share card — mandala centered on the themed background. */
export async function exportOG(drawing: DrawingV2, w = 1200, h = 630): Promise<Blob> {
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d") as OffCtx;
  ctx.fillStyle = BG_COLORS[drawing.bg];
  ctx.fillRect(0, 0, w, h);
  const half = (h / 2) * 0.82;
  paintDrawing(ctx, drawing, w, h, half);
  return canvas.convertToBlob({ type: "image/webp", quality: 0.9 });
}

/**
 * SVG export — pure string, no DOM.
 *
 * Structure mirrors the document: one <path> per stroke in <defs>, then a <g>
 * per visible layer carrying that layer's opacity, containing a <g> per symmetry
 * image whose <use>s reference the layer's paths. That gives a vector editor the
 * same handles the app has — a layer, and a movable copy per image.
 *
 * The layer name rides in a <title> only. It is metadata, never rendered text,
 * and it is XML-escaped because layer names are user input.
 *
 * Two long-standing approximations remain: spectrum strokes collapse to one
 * representative hue (a single <path> cannot gradient along its length) and glow
 * strokes use screen blending to stand in for additive compositing. Paint order
 * within a layer is image-major here where the canvas is stroke-major, which can
 * differ where two strokes of one layer overlap near the center.
 */
export function exportSVG(drawing: DrawingV2, S = 500): string {
  const vb = `${-S} ${-S} ${2 * S} ${2 * S}`;
  const scale = S / REFERENCE_HALF;
  const defs: string[] = [];
  const groups: string[] = [];

  for (const layer of drawing.layers) {
    if (!layer.visible) continue;

    const ids: string[] = [];
    layer.strokes.forEach((stroke, i) => {
      if (stroke.pts.length === 0) return;
      const id = `${layer.id}s${i}`;
      ids.push(id);
      const d = pathData(stroke, S);
      const color = representativeColor(stroke);
      const width = (stroke.size * scale).toFixed(2);
      const blend = stroke.tool === "glow" ? ' style="mix-blend-mode:screen"' : "";
      defs.push(
        `<path id="${id}" d="${d}" fill="none" stroke="${color}" stroke-width="${width}" ` +
          `stroke-linecap="round" stroke-linejoin="round" stroke-opacity="${strokeOpacity(stroke)}"${blend}/>`,
      );
    });
    if (ids.length === 0) continue;

    const images: string[] = [];
    forEachImage(layer.sym.segments, layer.sym.mirror, (image) => {
      const uses = ids.map((id) => `<use href="#${id}"/>`).join("");
      images.push(`<g transform="${imageTransformSvg(image)}">${uses}</g>`);
    });

    groups.push(
      `<g opacity="${layer.opacity}"><title>${xmlEscape(layer.name)}</title>${images.join("")}</g>`,
    );
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="${2 * S}" height="${2 * S}">` +
    `<rect x="${-S}" y="${-S}" width="${2 * S}" height="${2 * S}" fill="${BG_COLORS[drawing.bg]}"/>` +
    `<defs>${defs.join("")}</defs>` +
    groups.join("") +
    `</svg>`
  );
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * `stroke-opacity` for one stroke.
 *
 * A `<path>` carries a single opacity, so a `po` stroke — whose alpha varies
 * point by point on canvas — is represented by its MEAN pressure. Without `po`
 * this is the untouched `stroke.opacity`, character for character, so no stored
 * v1 piece's SVG changes.
 *
 * Known divergence, PRE-EXISTING and deliberately left alone here: canvas dims
 * glow by ×0.7 and this SVG never has. Folding it in would darken every glow
 * stroke in every existing piece's SVG download, which is outside "path
 * building only". Reported rather than fixed.
 */
function strokeOpacity(stroke: Stroke): string {
  if (stroke.po !== 1) return String(stroke.opacity);
  return pressureAlpha(stroke.opacity, meanPressure(stroke.pts)).toFixed(4);
}

/**
 * The `d` attribute, built from the SAME segment list the canvas renderer uses
 * (`strokeSegments`). A straight segment becomes `L`, a smoothed one `C`, so an
 * exported SVG has the curve that was on screen.
 */
function pathData(stroke: Stroke, S: number): string {
  const pts = stroke.pts;
  if (pts.length === 1) {
    // tiny dot as a 1-unit line so it renders with round caps
    const x = (pts[0][0] * S).toFixed(2);
    const y = (pts[0][1] * S).toFixed(2);
    return `M${x} ${y} L${x} ${y}`;
  }
  const f = (n: number): string => (n * S).toFixed(2);
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (const seg of strokeSegments(stroke)) {
    d +=
      seg.c1x === undefined
        ? `L${f(seg.x)} ${f(seg.y)}`
        : `C${f(seg.c1x)} ${f(seg.c1y!)} ${f(seg.c2x!)} ${f(seg.c2y!)} ${f(seg.x)} ${f(seg.y)}`;
  }
  return d;
}

/** Whether animated replay capture is available in this browser. */
export function canRecordReplay(): boolean {
  return (
    typeof MediaRecorder !== "undefined" &&
    typeof HTMLCanvasElement !== "undefined" &&
    typeof HTMLCanvasElement.prototype.captureStream === "function"
  );
}

export interface ReplayOptions {
  size?: number;
  fps?: number;
  /** approx total duration in ms; points are revealed evenly across it */
  durationMs?: number;
}

/**
 * Animated replay (WebM) that progressively redraws the piece. Falls back with a
 * thrown error if MediaRecorder/captureStream is unavailable — the UI hides the
 * option in that case. GIF fallback (gif.js) is a clean future seam.
 */
export async function exportReplayWebM(drawing: DrawingV2, opts: ReplayOptions = {}): Promise<Blob> {
  if (!canRecordReplay()) throw new Error("replay-unsupported");
  const size = opts.size ?? 800;
  const fps = opts.fps ?? 30;
  const durationMs = opts.durationMs ?? 4000;

  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;

  const totalPoints = Math.max(
    1,
    drawing.layers.reduce((n, l) => n + l.strokes.reduce((m, s) => m + s.pts.length, 0), 0),
  );
  const stream = canvas.captureStream(fps);
  const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
    ? "video/webm;codecs=vp9"
    : "video/webm";
  const recorder = new MediaRecorder(stream, { mimeType: mime });
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);

  const done = new Promise<Blob>((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: "video/webm" }));
  });

  recorder.start();
  const start = performance.now();

  await new Promise<void>((resolve) => {
    const frame = () => {
      const t = Math.min(1, (performance.now() - start) / durationMs);
      const reveal = Math.max(1, Math.floor(t * totalPoints));
      drawPartial(ctx, drawing, size, reveal);
      if (t >= 1) resolve();
      else requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });

  // hold the final frame briefly
  await new Promise((r) => setTimeout(r, 250));
  recorder.stop();
  return done;
}

function drawPartial(
  ctx: CanvasRenderingContext2D,
  drawing: DrawingV2,
  size: number,
  revealPoints: number,
): void {
  ctx.fillStyle = BG_COLORS[drawing.bg];
  ctx.fillRect(0, 0, size, size);
  paintDrawing(ctx, partialDrawing(drawing, revealPoints), size, size, size / 2);
}

/**
 * The drawing truncated to its first `revealPoints` points, bottom layer first —
 * the piece builds up in the order it was made. Layers are kept even when empty
 * so the composite (and therefore the bypass decision) matches the finished
 * render throughout the replay.
 */
function partialDrawing(drawing: DrawingV2, revealPoints: number): DrawingV2 {
  let budget = revealPoints;
  const layers = drawing.layers.map((l) => {
    const strokes: Layer["strokes"] = [];
    for (const s of l.strokes) {
      if (budget <= 0) break;
      const take = Math.min(budget, s.pts.length);
      strokes.push({ ...s, pts: s.pts.slice(0, take) });
      budget -= take;
    }
    return { ...l, strokes };
  });
  return { ...drawing, layers };
}

/** Trigger a browser download for a Blob or string payload. */
export function downloadBlob(data: Blob | string, filename: string, type = "image/svg+xml"): void {
  const blob = typeof data === "string" ? new Blob([data], { type }) : data;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
