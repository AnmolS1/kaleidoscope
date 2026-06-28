// Vector stroke model — the source of truth for a drawing. Coordinates are
// resolution-independent: normalized to the canvas's shorter HALF-axis with the
// origin at center, so the same data renders crisp at 256px (thumb) or 4096px
// (export). Sizes are in px at a fixed REFERENCE_HALF; renderers scale by
// (actualHalf / REFERENCE_HALF).

export type Background = "light" | "dark";
export type BrushTool = "solid" | "glow";

/** [x, y, pressure] — x,y normalized to ~[-1,1] on the shorter half-axis. */
export type Pt = [number, number, number];

export interface Stroke {
  tool: BrushTool;
  /** "#RRGGBB" or the literal "spectrum". */
  color: string;
  /** px at REFERENCE_HALF resolution. */
  size: number;
  /** 0..1 */
  opacity: number;
  pts: Pt[];
}

export interface Symmetry {
  segments: number;
  mirror: boolean;
}

export interface Drawing {
  v: 1;
  bg: Background;
  sym: Symmetry;
  strokes: Stroke[];
}

/** Reference half-axis (px). A stroke size of N renders N px when the canvas's
 *  shorter half-axis equals this. */
export const REFERENCE_HALF = 1000;

/** Coordinate decimal precision when serializing. */
const COORD_DECIMALS = 3;
const PRESSURE_DECIMALS = 2;

export const VECTOR_HARD_CAP_BYTES = 256 * 1024;

export function emptyDrawing(bg: Background, sym: Symmetry): Drawing {
  return { v: 1, bg, sym: { ...sym }, strokes: [] };
}

// ---- coordinate transforms -------------------------------------------------

/** Shorter half-axis in pixels for a canvas of given size. */
export function halfAxis(width: number, height: number): number {
  return Math.min(width, height) / 2;
}

/** Canvas pixel (relative to the canvas top-left) → normalized, center origin. */
export function toNormalized(
  px: number,
  py: number,
  width: number,
  height: number,
): { x: number; y: number } {
  const half = halfAxis(width, height);
  return { x: (px - width / 2) / half, y: (py - height / 2) / half };
}

/** Normalized, center origin → canvas pixel (relative to top-left). */
export function toPixel(
  nx: number,
  ny: number,
  width: number,
  height: number,
): { x: number; y: number } {
  const half = halfAxis(width, height);
  return { x: width / 2 + nx * half, y: height / 2 + ny * half };
}

// ---- rounding / compaction -------------------------------------------------

function round(n: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function compactPt([x, y, p]: Pt): Pt {
  return [round(x, COORD_DECIMALS), round(y, COORD_DECIMALS), round(p, PRESSURE_DECIMALS)];
}

/**
 * Should a new point be kept? Drops near-duplicates to keep payloads tiny.
 * `minDistNorm` is the minimum move in normalized units (≈ 1.1px / half at draw
 * resolution). Always keeps the first point of a stroke.
 */
export function shouldKeepPoint(prev: Pt | undefined, next: Pt, minDistNorm: number): boolean {
  if (!prev) return true;
  return Math.hypot(next[0] - prev[0], next[1] - prev[1]) >= minDistNorm;
}

// ---- serialization ---------------------------------------------------------

export function serialize(drawing: Drawing): string {
  const compact: Drawing = {
    v: 1,
    bg: drawing.bg,
    sym: { segments: drawing.sym.segments, mirror: drawing.sym.mirror },
    strokes: drawing.strokes.map((s) => ({
      tool: s.tool,
      color: s.color,
      size: round(s.size, 2),
      opacity: round(s.opacity, 3),
      pts: s.pts.map(compactPt),
    })),
  };
  return JSON.stringify(compact);
}

export class DrawingParseError extends Error {}

const HEX = /^#[0-9a-fA-F]{6}$/;

function isPt(v: unknown): v is Pt {
  return (
    Array.isArray(v) &&
    v.length === 3 &&
    v.every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

/**
 * Parse + structurally validate a serialized drawing. Throws DrawingParseError
 * on anything malformed. Used by the client (load/remix) and mirrored by the
 * worker's stricter byte-capped validator.
 */
export function deserialize(json: string): Drawing {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new DrawingParseError("invalid JSON");
  }
  if (typeof raw !== "object" || raw === null) throw new DrawingParseError("not an object");
  const d = raw as Record<string, unknown>;

  if (d.v !== 1) throw new DrawingParseError("unsupported version");
  if (d.bg !== "light" && d.bg !== "dark") throw new DrawingParseError("bad bg");

  const sym = d.sym as Record<string, unknown> | undefined;
  if (!sym || typeof sym.segments !== "number" || typeof sym.mirror !== "boolean") {
    throw new DrawingParseError("bad sym");
  }

  if (!Array.isArray(d.strokes)) throw new DrawingParseError("bad strokes");
  const strokes: Stroke[] = d.strokes.map((sv, i) => {
    const s = sv as Record<string, unknown>;
    if (s.tool !== "solid" && s.tool !== "glow") throw new DrawingParseError(`stroke ${i}: bad tool`);
    if (typeof s.color !== "string" || (s.color !== "spectrum" && !HEX.test(s.color))) {
      throw new DrawingParseError(`stroke ${i}: bad color`);
    }
    if (typeof s.size !== "number" || !Number.isFinite(s.size) || s.size <= 0) {
      throw new DrawingParseError(`stroke ${i}: bad size`);
    }
    if (typeof s.opacity !== "number" || s.opacity < 0 || s.opacity > 1) {
      throw new DrawingParseError(`stroke ${i}: bad opacity`);
    }
    if (!Array.isArray(s.pts) || !s.pts.every(isPt)) {
      throw new DrawingParseError(`stroke ${i}: bad pts`);
    }
    return {
      tool: s.tool,
      color: s.color,
      size: s.size,
      opacity: s.opacity,
      pts: s.pts as Pt[],
    };
  });

  return { v: 1, bg: d.bg, sym: { segments: sym.segments, mirror: sym.mirror }, strokes };
}

/** Quick stat helpers used by the save flow and gallery metadata. */
export function paletteOf(drawing: Drawing): string[] {
  const seen = new Set<string>();
  for (const s of drawing.strokes) if (s.color !== "spectrum") seen.add(s.color);
  return [...seen];
}
