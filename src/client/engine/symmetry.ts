// Rosette symmetry groups — the single source of truth shared by the live
// renderer (scene.ts), the SVG exporter, and the replay/PNG exporters (export.ts).
//
// Cyclic C_n  : n images, each a rotation by i * 2π/n.
// Dihedral D_n: the n rotations PLUS a reflected copy of each → 2n images.
//               The reflection is `ctx.scale(1, -1)` applied inside the rotated
//               frame, i.e. the group element r^i · s. This is well-defined for
//               every n (odd or even), unlike the old `i % 2` construction.

export interface SymmetryImage {
  /** 0-based index across all emitted images. */
  index: number;
  /** Rotation in radians (i * 2π/n). */
  angle: number;
  /** Whether this image is the reflected (scale(1,-1)) copy. */
  mirror: boolean;
}

// The segment bounds and the clamp live in the shared vector contract, which the
// Worker and Swift also enforce. Re-exported here (rather than redeclared) so the
// renderer can never drift from what the format accepts.
export { MIN_SEGMENTS, MAX_SEGMENTS, clampSegments } from "../../shared/vector";

/** Total number of symmetry images: n for C_n, 2n for D_n. */
export function imageCount(segments: number, mirror: boolean): number {
  return mirror ? segments * 2 : segments;
}

/**
 * Enumerate every symmetry image once, in a stable order:
 * first the n pure rotations (mirror=false), then — if `mirror` — the n
 * reflected rotations (mirror=true). Pure: allocates nothing per call beyond
 * the descriptor handed to `fn`.
 */
export function forEachImage(
  segments: number,
  mirror: boolean,
  fn: (image: SymmetryImage) => void,
): void {
  const step = (Math.PI * 2) / segments;
  let index = 0;
  for (let i = 0; i < segments; i++) {
    fn({ index: index++, angle: i * step, mirror: false });
  }
  if (mirror) {
    for (let i = 0; i < segments; i++) {
      fn({ index: index++, angle: i * step, mirror: true });
    }
  }
}

/**
 * Apply an image's transform to a canvas context already translated to the
 * symmetry center. Order matches r^i · s: rotate, then reflect.
 */
export function applyImageTransform(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  image: SymmetryImage,
): void {
  ctx.rotate(image.angle);
  if (image.mirror) ctx.scale(1, -1);
}

/**
 * Map a point (x, y) given in the base drawing frame to its position under an
 * image's transform (rotation then optional y-reflection). Used by the SVG
 * exporter and unit tests; canvas paths use applyImageTransform instead.
 */
export function transformPoint(
  image: SymmetryImage,
  x: number,
  y: number,
): { x: number; y: number } {
  const { angle, mirror } = image;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  // s (mirror) is applied first: (x, y) -> (x, -y), then R(angle).
  const ry = mirror ? -y : y;
  return {
    x: x * cos - ry * sin,
    y: x * sin + ry * cos,
  };
}

/**
 * The inverse of transformPoint: map a point in the drawing frame back into the
 * base (un-imaged) frame. Used by hit-testing, which has a tap in canvas space
 * and needs to know whether it landed on any of a stroke's N symmetry images —
 * inverting each image once is N cheap transforms instead of expanding every
 * stroke into N polylines.
 *
 * Forward is R(angle) . S; S is its own inverse, so this is S . R(-angle).
 */
export function inverseTransformPoint(
  image: SymmetryImage,
  x: number,
  y: number,
): { x: number; y: number } {
  const { angle, mirror } = image;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const rx = x * cos + y * sin;
  const ry = -x * sin + y * cos;
  return { x: rx, y: mirror ? -ry : ry };
}

/**
 * SVG transform attribute for an image, relative to a group already translated
 * to (cx, cy). Degrees + scale keep it human-editable in vector tools.
 */
export function imageTransformSvg(image: SymmetryImage): string {
  const deg = (image.angle * 180) / Math.PI;
  const rot = `rotate(${round(deg)})`;
  return image.mirror ? `${rot} scale(1,-1)` : rot;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
