// v1-facing shim over the shared vector format.
//
// TEMPORARY. The format now lives in src/shared/vector.ts, which both the client
// and the Worker compile. This module keeps the old v1 surface — same exported
// names, same signatures, `Drawing` still meaning the single-symmetry v1 shape —
// so the engine and UI modules that have not yet been migrated keep compiling
// while the migration lands file by file.
//
// T03 migrates the callers it owns; T04 is the last importer (via brush.ts) and
// deletes this file together with test/unit/strokes.test.ts. Do not add anything
// new here, and do not import it from new code — import src/shared/vector.ts.

import {
  deserialize as deserializeV2,
  flattenToV1,
  paletteOf as paletteOfV2,
  serializeV1,
  DrawingParseError,
} from "../../shared/vector";
import type { DrawingV1, DrawingV2, Symmetry } from "../../shared/vector";

export {
  REFERENCE_HALF,
  VECTOR_HARD_CAP_BYTES,
  halfAxis,
  toNormalized,
  toPixel,
  shouldKeepPoint,
  DrawingParseError,
} from "../../shared/vector";

export type { Background, BrushTool, Pt, Stroke, Symmetry } from "../../shared/vector";

/** The v1 drawing shape: one set of strokes under one symmetry. */
export type Drawing = DrawingV1;

export function emptyDrawing(bg: DrawingV1["bg"], sym: Symmetry): Drawing {
  return { v: 1, bg, sym: { ...sym }, strokes: [] };
}

export function serialize(drawing: Drawing): string {
  return serializeV1(drawing);
}

/**
 * Parse v1 (or v2) JSON and return the v1 shape.
 *
 * A v2 drawing is accepted when it flattens faithfully — a single-layer piece,
 * or several layers that share one symmetry at full opacity with no smoothing or
 * pressure-opacity strokes. When it does not, there is no v1 answer to give, so
 * this throws rather than returning a drawing that would render differently from
 * the one that was stored. Callers on the v1 surface cannot represent layers;
 * the ones that need to are being migrated to the shared module.
 */
export function deserialize(json: string): Drawing {
  const v2: DrawingV2 = deserializeV2(json);
  const flat = flattenToV1(v2);
  if (!flat) throw new DrawingParseError("drawing needs v2 (layers, smoothing or pressure opacity)");
  return flat;
}

export function paletteOf(drawing: Drawing): string[] {
  return paletteOfV2({
    v: 2,
    bg: drawing.bg,
    layers: [
      {
        id: "l1",
        name: "Layer 1",
        visible: true,
        opacity: 1,
        sym: drawing.sym,
        strokes: drawing.strokes,
      },
    ],
  });
}
