// Exporters — every output is a re-render of the vector model, so PNG/SVG/replay
// all match the screen. PNG/thumb render to an OffscreenCanvas (off the visible
// DOM); SVG is built as a pure string (no DOM, unit-testable); replay captures a
// progressive redraw via MediaRecorder (WebM), with a clean seam for a GIF
// fallback. Square output suits the centered mandala.

import { forEachImage, imageTransformSvg } from "./symmetry";
import { baseAlpha, meanPressure, representativeColor, strokeSegments } from "./brush";
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
 * Approximations that remain, each because SVG has no way to say the thing:
 *
 *  - Spectrum strokes collapse to one representative hue; a single <path>
 *    cannot gradient along its length.
 *  - Glow uses `mix-blend-mode:screen` where the canvas uses `lighter`. Screen
 *    is `a+b-ab`, additive is `a+b`, so glow over a LIGHT background still comes
 *    out slightly darker here — the `ab` term. `plus-lighter` is the exact
 *    match and was NOT used: it is a recent CSS value that vector editors do not
 *    implement, and an SVG that renders wrong in Illustrator is worse than one
 *    that is a few percent dark in the overlap. The alpha itself now matches
 *    (mE3), so the additive term is right and only that product differs.
 *  - Paint order within a layer is image-major here where the canvas is
 *    stroke-major, which can differ where two strokes of one layer overlap near
 *    the centre.
 */
export function exportSVG(drawing: DrawingV2, S = 500): string {
  const vb = `${-S} ${-S} ${2 * S} ${2 * S}`;
  const scale = S / REFERENCE_HALF;
  const defs: string[] = [];
  const groups: string[] = [];
  // The same predicate `paintDrawing` uses, so the two cannot disagree about
  // which drawings take the direct path.
  const visibleLayers = drawing.layers.filter((l) => l.visible);
  const bypass = visibleLayers.length === 1 && visibleLayers[0].opacity === 1;

  for (const layer of drawing.layers) {
    if (!layer.visible) continue;

    const ids: string[] = [];
    layer.strokes.forEach((stroke, i) => {
      if (stroke.pts.length === 0) return;
      const id = `${layer.id}s${i}`;
      ids.push(id);
      const color = representativeColor(stroke);
      const blend = stroke.tool === "glow" ? ' style="mix-blend-mode:screen"' : "";
      // WIDTH FOLLOWS PRESSURE, one <path> per segment (S9).
      //
      // A single <path> carries one stroke-width, so the SVG used the stroke's
      // nominal size while the canvas multiplies it by `widthFactor` of each
      // segment's mean pressure. Every SVG therefore came out as the HEAVIEST
      // possible version of the drawing — ~48% fatter than the PNG at the
      // default pressure. Splitting per segment is the only way SVG can express
      // a varying width; the segments live in one <g> so each symmetry image
      // still <use>s the stroke exactly once, and the per-stroke attributes
      // (colour, opacity, blend) stay on that group where they belong.
      defs.push(
        `<g id="${id}" fill="none" stroke="${color}" stroke-linecap="round" ` +
          `stroke-linejoin="round" stroke-opacity="${strokeOpacity(stroke)}"${blend}>` +
          `${segmentPaths(stroke, S, scale)}</g>`,
      );
    });
    if (ids.length === 0) continue;

    const images: string[] = [];
    forEachImage(layer.sym.segments, layer.sym.mirror, (image) => {
      const uses = ids.map((id) => `<use href="#${id}"/>`).join("");
      images.push(`<g transform="${imageTransformSvg(image)}">${uses}</g>`);
    });

    // ISOLATION, matching what the canvas actually does (REVIEW.md minor mE2).
    //
    // `paintDrawing` has one rule: a single visible layer at opacity 1 paints
    // STRAIGHT into the destination, so its glow blends additively against the
    // background fill; anything else goes through a per-layer offscreen buffer
    // and is composited `source-over`, so its glow blends only against its own
    // layer. The SVG emitted `<g opacity="1">`, which creates no stacking
    // context at all — so in a multi-layer drawing a glow stroke reached
    // through and blended with the layers underneath, which the canvas never
    // lets it do. `isolation:isolate` is the group-level equivalent of that
    // offscreen buffer, and it is applied on exactly the same condition.
    const style = bypass ? "" : ' style="isolation:isolate"';
    groups.push(
      `<g opacity="${svgNumber(layer.opacity)}"${style}>` +
        `<title>${xmlEscape(layer.name)}</title>${images.join("")}</g>`,
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
 * Glow's ×0.7 is folded in through the shared `baseAlpha` (REVIEW.md minor mE3).
 * It used to be omitted, so a glow stroke was painted at 0.7 on canvas and
 * exported at 1.0 — the SVG was the brightest possible reading of the drawing,
 * the same way it was the heaviest before S9. Yes, this darkens the glow in
 * every existing piece's SVG download; that is the direction of the PNG it is
 * supposed to match.
 */
function strokeOpacity(stroke: Stroke): string {
  const base = baseAlpha(stroke);
  // Formatted, not stringified: `0.8 * 0.7` is 0.5600000000000001 in binary
  // floating point, and an SVG attribute is a place that noise becomes visible.
  // A stroke with neither glow nor `po` keeps its exact stored digits, so no v1
  // piece's SVG changes for a reason unrelated to this fix.
  if (stroke.po !== 1) return stroke.tool === "glow" ? svgNumber(base) : String(stroke.opacity);
  return svgNumber(pressureAlpha(base, meanPressure(stroke.pts)));
}

/**
 * A number for an SVG attribute: at most 4 decimals, no trailing zeros, and no
 * binary-float tail.
 *
 * `<g opacity="${layer.opacity}">` emitted whatever the slider's float
 * happened to be — `0.30000000000000004` in the file for a value the UI shows
 * as 30% (REVIEW.md minor mE2). 4dp is finer than the format stores opacity at
 * (3dp), so this can never round away something the document distinguishes.
 */
function svgNumber(n: number): string {
  return String(Number(n.toFixed(4)));
}

/**
 * The `d` attribute, built from the SAME segment list the canvas renderer uses
 * (`strokeSegments`). A straight segment becomes `L`, a smoothed one `C`, so an
 * exported SVG has the curve that was on screen.
 */

/** Pressure 0..1 → width multiplier. MUST match `widthFactor` in brush.ts, or
 *  the SVG and the PNG of the same drawing disagree — which is the bug
 *  `segmentPaths` exists to close. */
function widthFactor(pressure: number): number {
  return 0.35 + 0.65 * Math.max(0, Math.min(1, pressure));
}

/**
 * A stroke as one `<path>` per segment, each carrying its own pressure-derived
 * width — the SVG counterpart of the segment loop in `brush.ts`.
 *
 * Each path's geometry is exactly the segment it represents, so the union
 * traces the same curve the single-path form did.
 */
function segmentPaths(stroke: Stroke, S: number, scale: number): string {
  const pts = stroke.pts;
  const f = (n: number): string => (n * S).toFixed(2);
  const w = (p: number): string => (stroke.size * scale * widthFactor(p)).toFixed(2);

  if (pts.length === 1) {
    // A dot, drawn as a 1-unit line so round caps render it.
    const x = f(pts[0][0]);
    const y = f(pts[0][1]);
    return `<path d="M${x} ${y} L${x} ${y}" stroke-width="${w(pts[0][2])}"/>`;
  }

  const out: string[] = [];
  for (const seg of strokeSegments(stroke)) {
    const a = pts[seg.i];
    const b = pts[seg.i + 1];
    const d =
      `M${f(a[0])} ${f(a[1])}` +
      (seg.c1x === undefined
        ? `L${f(seg.x)} ${f(seg.y)}`
        : `C${f(seg.c1x)} ${f(seg.c1y!)} ${f(seg.c2x!)} ${f(seg.c2y!)} ${f(seg.x)} ${f(seg.y)}`);
    out.push(`<path d="${d}" stroke-width="${w((a[2] + b[2]) / 2)}"/>`);
  }
  return out.join("");
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
