// Brushes — paint a single stroke into a context whose origin is the symmetry
// center and which has already had the image transform (rotation / reflection)
// applied. Coordinates inside a stroke are normalized; we multiply by `half`
// (the shorter half-axis in px) to get centered pixels. Shared by scene.ts
// (live + committed) and export.ts (PNG / replay).
//
// `strokeSegments` below is the ONE path builder. Live canvas, committed canvas,
// PNG/WebP/OG, SVG and replay all get their geometry from it, so a smoothed
// stroke cannot curve on screen and stay a polyline in a download. Canvas turns
// each segment into moveTo/lineTo or moveTo/bezierCurveTo; SVG turns the same
// list into `L` or `C` commands.

import { smoothStroke } from "../../shared/smooth";
import { REFERENCE_HALF, pressureAlpha, type Stroke, type Pt } from "../../shared/vector";

type AnyCtx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Pressure 0..1 → width multiplier, floored so strokes never vanish. */
function widthFactor(pressure: number): number {
  return 0.35 + 0.65 * Math.max(0, Math.min(1, pressure));
}

/**
 * One segment of a stroke's rendered path: always from source point `i` to
 * source point `i + 1`, optionally curved.
 *
 * Structurally a superset of `Cubic` from ../../shared/smooth, so the smoothed
 * builder's output is used verbatim rather than copied field by field.
 */
export interface StrokeSegment {
  /** Index of the source point this segment starts at. */
  i: number;
  /** End point — always equals the source point at `i + 1`. */
  x: number;
  y: number;
  /** Cubic control points. Absent on a straight segment. */
  c1x?: number;
  c1y?: number;
  c2x?: number;
  c2y?: number;
}

/**
 * THE shared path builder. Normalized coordinates, pure geometry, no `half`.
 *
 * Segment boundaries are the source points either way, because width and
 * spectrum hue already vary per source segment and must keep varying
 * identically — smoothing changes the shape between two points, never how many
 * there are.
 *
 * A stroke is smoothed only when it asks (`sm === 1`) AND has an interior to
 * smooth. `smoothStroke` returns null below 3 points, and that falls through to
 * the straight case: the coordinates are then copied from `pts` verbatim, with
 * no arithmetic, so a v1 stroke produces bit-identical output to the polyline
 * loop this replaced. That is what keeps every stored gallery piece rendering as
 * its saved PNG.
 */
export function strokeSegments(stroke: Stroke): StrokeSegment[] {
  const pts = stroke.pts;
  if (pts.length < 2) return [];
  if (stroke.sm === 1) {
    const cubics = smoothStroke(pts);
    if (cubics) return cubics;
  }
  const out: StrokeSegment[] = new Array(pts.length - 1);
  for (let k = 0; k < pts.length - 1; k++) {
    out[k] = { i: k, x: pts[k + 1][0], y: pts[k + 1][1] };
  }
  return out;
}

/**
 * The alpha a `po` stroke paints at, at a given pressure.
 *
 * `applyBrushMode` has already folded glow's ×0.7 into the base alpha, so
 * feeding that base through `pressureAlpha` is what makes the two factors
 * compose — glow at full pressure is still 0.7, not 1.
 */
function poAlpha(stroke: Stroke, pressure: number): number {
  const base = stroke.tool === "glow" ? stroke.opacity * 0.7 : stroke.opacity;
  return pressureAlpha(base, pressure);
}

/** Mean pressure over a stroke's points. Used where one alpha must stand in for
 *  the whole stroke — SVG, which cannot vary stroke-opacity along a path. */
export function meanPressure(pts: readonly Pt[]): number {
  if (pts.length === 0) return 1;
  let sum = 0;
  for (const p of pts) sum += p[2];
  return sum / pts.length;
}

/** Spectrum hue (deg) for a normalized point: hue follows the angle around the
 *  center, so a radial scribble rainbows automatically. */
export function spectrumHue(nx: number, ny: number): number {
  const a = Math.atan2(ny, nx); // -π..π
  return ((a / (Math.PI * 2)) * 360 + 360) % 360;
}

export function spectrumColor(nx: number, ny: number, opacity = 1): string {
  return `hsla(${spectrumHue(nx, ny).toFixed(1)}, 85%, 60%, ${opacity})`;
}

function applyBrushMode(ctx: AnyCtx, stroke: Stroke): void {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (stroke.tool === "glow") {
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = stroke.opacity * 0.7;
  } else {
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = stroke.opacity;
  }
}

/**
 * Draw one stroke. The context must already be translated to center and have the
 * symmetry image transform applied. `half` is the shorter half-axis in px.
 * A single point renders as a dot.
 */
export function drawStroke(ctx: AnyCtx, stroke: Stroke, half: number): void {
  const pts = stroke.pts;
  if (pts.length === 0) return;

  const scale = half / REFERENCE_HALF;
  ctx.save();
  applyBrushMode(ctx, stroke);

  const isSpectrum = stroke.color === "spectrum";
  if (!isSpectrum) ctx.strokeStyle = stroke.color;

  if (pts.length === 1) {
    // dot
    const [nx, ny, p] = pts[0];
    const x = nx * half;
    const y = ny * half;
    const r = (stroke.size * scale * widthFactor(p)) / 2;
    ctx.beginPath();
    ctx.fillStyle = isSpectrum ? spectrumColor(nx, ny, 1) : stroke.color;
    // Without `po` this is the same assignment it always was — deliberately
    // written as a branch rather than folded into one expression, because the
    // v1 value is pinned by test/unit/render-trace.test.ts, which records every
    // globalAlpha write.
    ctx.globalAlpha =
      stroke.po === 1
        ? poAlpha(stroke, p)
        : stroke.tool === "glow"
          ? stroke.opacity * 0.7
          : stroke.opacity;
    ctx.arc(x, y, Math.max(0.5, r), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  // Segment-by-segment so width (and spectrum hue) can vary along the stroke.
  // Each segment is stroked as its own path — chaining a smoothed stroke into a
  // single path would force one width and one hue on the whole thing.
  for (const seg of strokeSegments(stroke)) {
    const a = pts[seg.i];
    const b = pts[seg.i + 1];
    const w = stroke.size * scale * widthFactor((a[2] + b[2]) / 2);
    ctx.lineWidth = Math.max(0.5, w);
    if (isSpectrum) {
      const mx = (a[0] + b[0]) / 2;
      const my = (a[1] + b[1]) / 2;
      ctx.strokeStyle = spectrumColor(mx, my, 1);
    }
    // Guarded: an unconditional per-segment globalAlpha write would appear in
    // the v1 render trace, which is frozen. `po` is never set on a v1 stroke.
    if (stroke.po === 1) ctx.globalAlpha = poAlpha(stroke, (a[2] + b[2]) / 2);
    ctx.beginPath();
    ctx.moveTo(a[0] * half, a[1] * half);
    if (seg.c1x === undefined) {
      ctx.lineTo(seg.x * half, seg.y * half);
    } else {
      ctx.bezierCurveTo(
        seg.c1x * half,
        seg.c1y! * half,
        seg.c2x! * half,
        seg.c2y! * half,
        seg.x * half,
        seg.y * half,
      );
    }
    ctx.stroke();
  }

  ctx.restore();
}

/** Representative solid color for a stroke (used by the SVG exporter, which
 *  cannot vary color along a single <path>). */
export function representativeColor(stroke: Stroke): string {
  if (stroke.color !== "spectrum") return stroke.color;
  const pts: Pt[] = stroke.pts;
  if (pts.length === 0) return "#888888";
  // average position → one hue
  let sx = 0;
  let sy = 0;
  for (const [x, y] of pts) {
    sx += x;
    sy += y;
  }
  const h = spectrumHue(sx / pts.length, sy / pts.length);
  return hslToHex(h, 85, 60);
}

function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const color = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return Math.round(255 * color)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}
