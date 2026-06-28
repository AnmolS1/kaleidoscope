// Brushes — paint a single stroke into a context whose origin is the symmetry
// center and which has already had the image transform (rotation / reflection)
// applied. Coordinates inside a stroke are normalized; we multiply by `half`
// (the shorter half-axis in px) to get centered pixels. Shared by scene.ts
// (live + committed) and export.ts (PNG / replay). SVG export builds paths
// separately but reuses the spectrum hue function for consistency.

import { REFERENCE_HALF, type Stroke, type Pt } from "./strokes";

type AnyCtx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Pressure 0..1 → width multiplier, floored so strokes never vanish. */
function widthFactor(pressure: number): number {
  return 0.35 + 0.65 * Math.max(0, Math.min(1, pressure));
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
    ctx.globalAlpha = stroke.tool === "glow" ? stroke.opacity * 0.7 : stroke.opacity;
    ctx.arc(x, y, Math.max(0.5, r), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  // Segment-by-segment so width (and spectrum hue) can vary along the stroke.
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const w = stroke.size * scale * widthFactor((a[2] + b[2]) / 2);
    ctx.lineWidth = Math.max(0.5, w);
    if (isSpectrum) {
      const mx = (a[0] + b[0]) / 2;
      const my = (a[1] + b[1]) / 2;
      ctx.strokeStyle = spectrumColor(mx, my, 1);
    }
    ctx.beginPath();
    ctx.moveTo(a[0] * half, a[1] * half);
    ctx.lineTo(b[0] * half, b[1] * half);
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
