// Exporters — every output is a re-render of the vector model, so PNG/SVG/replay
// all match the screen. PNG/thumb render to an OffscreenCanvas (off the visible
// DOM); SVG is built as a pure string (no DOM, unit-testable); replay captures a
// progressive redraw via MediaRecorder (WebM), with a clean seam for a GIF
// fallback. Square output suits the centered mandala.

import { forEachImage, imageTransformSvg } from "./symmetry";
import { representativeColor } from "./brush";
import { paintStrokes } from "./scene";
import { REFERENCE_HALF, type Drawing } from "./strokes";

export const BG_COLORS: Record<Drawing["bg"], string> = {
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

/** Paint a full drawing (bg + all strokes) into a square context of `size` px. */
function renderSquare(ctx: OffCtx | CanvasRenderingContext2D, drawing: Drawing, size: number): void {
  ctx.fillStyle = BG_COLORS[drawing.bg];
  ctx.fillRect(0, 0, size, size);
  paintStrokes(ctx, drawing.strokes, size, size, size / 2, drawing.sym);
}

/** PNG at 1/2/4×. Returns a Blob. */
export async function exportPNG(drawing: Drawing, scale: 1 | 2 | 4 = 1): Promise<Blob> {
  const size = PNG_BASE * scale;
  const { canvas, ctx } = makeOffscreen(size);
  renderSquare(ctx, drawing, size);
  return canvas.convertToBlob({ type: "image/png" });
}

/** Small WebP thumbnail for the gallery / save flow. */
export async function exportThumb(drawing: Drawing, size = 512): Promise<Blob> {
  const { canvas, ctx } = makeOffscreen(size);
  renderSquare(ctx, drawing, size);
  return canvas.convertToBlob({ type: "image/webp", quality: 0.85 });
}

/** Full-size WebP render (source for the stored image). */
export async function exportWebP(drawing: Drawing, size = PNG_BASE): Promise<Blob> {
  const { canvas, ctx } = makeOffscreen(size);
  renderSquare(ctx, drawing, size);
  return canvas.convertToBlob({ type: "image/webp", quality: 0.92 });
}

/** 1200×630 OG/share card — mandala centered on the themed background. */
export async function exportOG(drawing: Drawing, w = 1200, h = 630): Promise<Blob> {
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d") as OffCtx;
  ctx.fillStyle = BG_COLORS[drawing.bg];
  ctx.fillRect(0, 0, w, h);
  const half = (h / 2) * 0.82;
  paintStrokes(ctx, drawing.strokes, w, h, half, drawing.sym);
  return canvas.convertToBlob({ type: "image/webp", quality: 0.9 });
}

/**
 * SVG export — pure string, no DOM. One <path> per stroke in <defs>, referenced
 * by a <use> per symmetry image (compact + editable in vector tools). Spectrum
 * strokes collapse to one representative hue (a single <path> can't gradient
 * along its length); glow strokes use screen blending to approximate additivity.
 */
export function exportSVG(drawing: Drawing, S = 500): string {
  const vb = `${-S} ${-S} ${2 * S} ${2 * S}`;
  const scale = S / REFERENCE_HALF;
  const defs: string[] = [];
  const uses: string[] = [];

  drawing.strokes.forEach((stroke, i) => {
    if (stroke.pts.length === 0) return;
    const id = `s${i}`;
    const d = pathData(stroke.pts, S);
    const color = representativeColor(stroke);
    const width = (stroke.size * scale).toFixed(2);
    const blend = stroke.tool === "glow" ? ' style="mix-blend-mode:screen"' : "";
    defs.push(
      `<path id="${id}" d="${d}" fill="none" stroke="${color}" stroke-width="${width}" ` +
        `stroke-linecap="round" stroke-linejoin="round" stroke-opacity="${stroke.opacity}"${blend}/>`,
    );
    forEachImage(drawing.sym.segments, drawing.sym.mirror, (image) => {
      uses.push(`<use href="#${id}" transform="${imageTransformSvg(image)}"/>`);
    });
  });

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="${2 * S}" height="${2 * S}">` +
    `<rect x="${-S}" y="${-S}" width="${2 * S}" height="${2 * S}" fill="${BG_COLORS[drawing.bg]}"/>` +
    `<defs>${defs.join("")}</defs>` +
    `<g>${uses.join("")}</g>` +
    `</svg>`
  );
}

function pathData(pts: Drawing["strokes"][number]["pts"], S: number): string {
  if (pts.length === 1) {
    // tiny dot as a 1-unit line so it renders with round caps
    const x = (pts[0][0] * S).toFixed(2);
    const y = (pts[0][1] * S).toFixed(2);
    return `M${x} ${y} L${x} ${y}`;
  }
  let d = "";
  pts.forEach(([nx, ny], i) => {
    d += `${i === 0 ? "M" : "L"}${(nx * S).toFixed(2)} ${(ny * S).toFixed(2)}`;
  });
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
export async function exportReplayWebM(drawing: Drawing, opts: ReplayOptions = {}): Promise<Blob> {
  if (!canRecordReplay()) throw new Error("replay-unsupported");
  const size = opts.size ?? 800;
  const fps = opts.fps ?? 30;
  const durationMs = opts.durationMs ?? 4000;

  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;

  const totalPoints = Math.max(1, drawing.strokes.reduce((n, s) => n + s.pts.length, 0));
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
  drawing: Drawing,
  size: number,
  revealPoints: number,
): void {
  ctx.fillStyle = BG_COLORS[drawing.bg];
  ctx.fillRect(0, 0, size, size);
  let budget = revealPoints;
  const partial: Drawing["strokes"] = [];
  for (const s of drawing.strokes) {
    if (budget <= 0) break;
    const take = Math.min(budget, s.pts.length);
    partial.push({ ...s, pts: s.pts.slice(0, take) });
    budget -= take;
  }
  paintStrokes(ctx, partial, size, size, size / 2, drawing.sym);
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
