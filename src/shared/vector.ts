// The vector drawing format — v2, with layers. The single source of truth for
// what a drawing IS, shared by the web client and the Worker.
//
// Compiled by BOTH tsconfig.app.json and tsconfig.worker.json, which have
// separate `include` lists and no project reference between them. It may
// therefore use only globals present in both runtimes: `crypto.subtle`,
// `TextEncoder`, `JSON`, `Math`. No DOM, no `node:`.
//
// A third implementation of this format lives in Swift (ios/KaleidoEngine) and
// is held to producing byte-identical output; ios/tools/gen-engine-fixtures.ts
// generates its golden fixtures by running the serializer in this file, so this
// is the definition and Swift conforms to it.
//
// ---- what v2 changes, and what it must not ------------------------------
//
// A v1 drawing is one set of strokes under one symmetry. v2 is up to 8 layers,
// each with its own symmetry, name, visibility and opacity. Two new per-stroke
// flags ride along: `sm` (render smoothed) and `po` (pressure also scales
// opacity).
//
// Both flags are OPT-IN and absent on every v1 stroke, which is the mechanism
// that keeps existing work pixel-stable: a v1 piece upgrades to a single layer
// at opacity 1 with no `sm` and no `po`, so it renders through exactly the path
// it always did. Every piece in the live gallery is v1 and the PNG each one
// shows was rasterized by that path, so this is not a nicety.

// ---- types ---------------------------------------------------------------

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
  /**
   * Pressure also scales alpha: `opacity * (0.25 + 0.75 * p)`. Pen input only.
   * Absent means width-only, which is v1 behavior.
   */
  po?: 1;
  /**
   * Render with the smoothing in ../shared/smooth.ts. Absent means polyline.
   * Never set on a v1 stroke, and never retrofitted onto one.
   */
  sm?: 1;
  pts: Pt[];
}

export interface Symmetry {
  segments: number;
  mirror: boolean;
}

export interface Layer {
  /** Positional and stable within a document: "l1".."l8". Never random. */
  id: string;
  name: string;
  visible: boolean;
  /** 0..1, applied to the whole layer when compositing. */
  opacity: number;
  sym: Symmetry;
  strokes: Stroke[];
}

/** Layers are ordered bottom → top. */
export interface DrawingV2 {
  v: 2;
  bg: Background;
  layers: Layer[];
}

/** The v1 shape, still emitted for clients that cannot read v2. */
export interface DrawingV1 {
  v: 1;
  bg: Background;
  sym: Symmetry;
  strokes: Stroke[];
}

// ---- constants -----------------------------------------------------------

/** Reference half-axis (px): a stroke of size N renders N px at this half-axis. */
export const REFERENCE_HALF = 1000;

export const MIN_SEGMENTS = 3;
export const MAX_SEGMENTS = 24;
export const MAX_LAYERS = 8;
export const MAX_LAYER_NAME = 40;
export const MAX_STROKES_TOTAL = 5000;
export const MAX_POINTS_TOTAL = 200_000;

/**
 * Numeric bounds enforced on PARSE, on both platforms.
 *
 * None of these existed, and the format is written by one platform and read by
 * the other, so an unbounded number is not a cosmetic problem: Swift's
 * `Int(...)` conversion traps — uncatchably — well below what a double can
 * hold, so a value this parser waved through crash-looped every iOS client that
 * opened the piece.
 *
 * `MIN_SIZE` is the rounding grid, not an aesthetic minimum: size serializes to
 * two decimals, so anything smaller writes back as `0`, which this same parser
 * rejects — the piece destroys itself on the first re-save.
 */
export const MIN_SIZE = 0.01; // one unit of the 2dp serialization grid
export const MAX_SIZE = 1_000; // far above any brush; well clear of the Int trap
export const MAX_COORD = 1_000; // coords are normalized to ~[-1, 1]
export const VECTOR_HARD_CAP_BYTES = 256 * 1024;

const COORD_DECIMALS = 3;
const PRESSURE_DECIMALS = 2;
const SIZE_DECIMALS = 2;
const OPACITY_DECIMALS = 3;

/**
 * Pressure presets, applied at CAPTURE time (`p' = p^γ`) and stored as the
 * adjusted pressure. Nothing downstream knows which preset was used, so a
 * drawing does not change appearance when the setting later changes.
 */
export const PRESSURE_GAMMA = { light: 0.6, normal: 1, firm: 1.6 } as const;
export type PressurePreset = keyof typeof PRESSURE_GAMMA;

export class DrawingParseError extends Error {}

// ---- numeric formatting --------------------------------------------------

/**
 * Round half away from... no: round exactly like JS `Math.round`, which is half
 * toward +∞. The Swift port reproduces this as `floor(n * 10^d + 0.5)`, so any
 * change here breaks byte-parity and the golden test catches it.
 *
 * `-0` collapses to `0`. `JSON.stringify` already prints `-0` as `0`, so this is
 * belt-and-braces, but it keeps in-memory values comparable with `Object.is`.
 */
function round(n: number, decimals: number): number {
  const f = 10 ** decimals;
  const v = Math.round(n * f) / f;
  return Object.is(v, -0) ? 0 : v;
}

// ---- coordinate transforms ----------------------------------------------

/** Shorter half-axis in pixels for a canvas of the given size. */
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

/**
 * Should a new point be kept? Drops near-duplicates to keep payloads small.
 * `minDistNorm` is the minimum move in normalized units. Always keeps the first
 * point of a stroke.
 */
export function shouldKeepPoint(prev: Pt | undefined, next: Pt, minDistNorm: number): boolean {
  if (!prev) return true;
  return Math.hypot(next[0] - prev[0], next[1] - prev[1]) >= minDistNorm;
}

export function clampSegments(n: number): number {
  n = Math.round(n);
  if (Number.isNaN(n)) return MIN_SEGMENTS;
  return Math.max(MIN_SEGMENTS, Math.min(MAX_SEGMENTS, n));
}

/** Apply a pressure preset at capture time. Storage holds the adjusted value. */
export function applyPressureGamma(p: number, preset: PressurePreset): number {
  const clamped = Math.max(0, Math.min(1, p));
  const g = PRESSURE_GAMMA[preset];
  return g === 1 ? clamped : clamped ** g;
}

/** Alpha multiplier for a stroke's `po` flag at a given pressure. */
export function pressureAlpha(opacity: number, p: number): number {
  return opacity * (0.25 + 0.75 * Math.max(0, Math.min(1, p)));
}

// ---- layer names ---------------------------------------------------------

/**
 * Validate and normalize a layer name.
 *
 * NFC first, then the limit is checked — normalization can change the code-unit
 * count, so checking before it would let a 41-unit name through or reject a
 * legal 40-unit one. Returns null if the name is not storable.
 *
 * Rejected: control characters (C0, DEL, C1) and lone surrogates. A lone
 * surrogate is not a character at all; it survives a JSON round-trip in some
 * parsers and becomes U+FFFD in others, which would silently change the stored
 * bytes and therefore the content hash.
 *
 * The empty string is ALLOWED — it is "printable scalars only" vacuously, and
 * refusing it would fail a save over something the UI can simply render as
 * blank. See HANDOFF; flagged for M1.
 */
export function normalizeLayerName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.normalize("NFC");
  if (name.length > MAX_LAYER_NAME) return null;
  for (const ch of name) {
    const cp = ch.codePointAt(0)!;
    // C0 controls and DEL, then C1 controls.
    if (cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) return null;
    // A code point in the surrogate range can only appear here if it was
    // unpaired; `for..of` combines valid pairs into a single code point.
    if (cp >= 0xd800 && cp <= 0xdfff) return null;
  }
  return name;
}

/**
 * The lowest unused id in "l1".."l8". Ids are positional and stable within a
 * document rather than random, so two clients that add a layer to the same
 * drawing produce the same id — and so a hash projection can drop them without
 * having to care that they differ.
 */
export function nextLayerId(layers: ReadonlyArray<{ id: string }>): string {
  const used = new Set(layers.map((l) => l.id));
  for (let i = 1; i <= MAX_LAYERS; i++) {
    const id = `l${i}`;
    if (!used.has(id)) return id;
  }
  throw new DrawingParseError("no free layer id");
}

/** A fresh single-layer drawing — the starting state on every platform. */
export function emptyDrawing(bg: Background, sym: Symmetry): DrawingV2 {
  return {
    v: 2,
    bg,
    layers: [
      {
        id: "l1",
        name: "Layer 1",
        visible: true,
        opacity: 1,
        sym: { segments: sym.segments, mirror: sym.mirror },
        strokes: [],
      },
    ],
  };
}

// ---- serialization -------------------------------------------------------

// Built as plain objects and handed to JSON.stringify rather than concatenated
// by hand. Insertion order is the emitted key order, string escaping is exactly
// ECMAScript semantics, and `-0` prints as `0` — all three for free, and all
// three things the Swift port has to reproduce deliberately.

function compactStroke(s: Stroke): Record<string, unknown> {
  const out: Record<string, unknown> = {
    tool: s.tool,
    color: s.color,
    size: round(s.size, SIZE_DECIMALS),
    opacity: round(s.opacity, OPACITY_DECIMALS),
  };
  // Emitted only when set, so a stroke without them is byte-identical to v1.
  if (s.po === 1) out.po = 1;
  if (s.sm === 1) out.sm = 1;
  out.pts = s.pts.map(
    (p) =>
      [round(p[0], COORD_DECIMALS), round(p[1], COORD_DECIMALS), round(p[2], PRESSURE_DECIMALS)] as Pt,
  );
  return out;
}

/** Canonical storage form. Byte-identical on Swift (golden test). */
export function serialize(d: DrawingV2): string {
  return JSON.stringify({
    v: 2,
    bg: d.bg,
    layers: d.layers.map((l) => ({
      id: l.id,
      name: l.name,
      visible: l.visible,
      opacity: round(l.opacity, OPACITY_DECIMALS),
      sym: { segments: l.sym.segments, mirror: l.sym.mirror },
      strokes: l.strokes.map(compactStroke),
    })),
  });
}

/**
 * The render-equivalent projection used for content hashing.
 *
 * Drops everything that does not change the picture: layer ids, layer names,
 * the `visible` flag, and hidden layers entirely. Two drawings that LOOK
 * identical therefore hash identically, which is what makes "this exact drawing
 * is already in the gallery" true rather than approximately true — renaming a
 * layer or toggling a hidden one is not a new piece.
 *
 * Layer ORDER and per-layer opacity and symmetry are kept, because all three
 * change the render.
 *
 * Two normalizations beyond that, both added 2026-09-01 (REVIEW S16, S17) and
 * both requiring the content_hash re-backfill in migration 0006:
 *
 * 1. **Hex colour case is folded.** `#ABCDEF` and `#abcdef` are the same
 *    colour and render identically, so they are the same picture.
 *
 * 2. **A stack that FLATTENS is hashed flat.** `flattenToV1` already decides
 *    when N layers are render-equivalent to one — same symmetry throughout,
 *    every layer at opacity 1, no `po`/`sm`. When that holds, the layered form
 *    and the single-layer form ARE the same picture by this codebase's own
 *    argument, and they used to hash differently: a pre-1.2 client that fetched
 *    the flattened `?v=1` form and re-saved it got a duplicate instead of
 *    `deduped`. The conditions are read off `flattenToV1` rather than restated,
 *    so the two cannot drift apart.
 *
 * Anything that changes the picture still separates two drawings; these only
 * merge things the renderer cannot tell apart.
 */
export function serializeForHash(d: DrawingV2): string {
  const fold = (st: Stroke): Stroke =>
    st.color === "spectrum" ? st : { ...st, color: st.color.toLowerCase() };

  // Hash the flattened form when the drawing genuinely flattens. `flattenToV1`
  // owns that decision; calling it is what keeps the two definitions identical.
  const flat = flattenToV1(d);
  if (flat) {
    return JSON.stringify({
      v: 2,
      bg: flat.bg,
      layers: [
        {
          opacity: round(1, OPACITY_DECIMALS),
          sym: { segments: flat.sym.segments, mirror: flat.sym.mirror },
          strokes: flat.strokes.map((st) => compactStroke(fold(st))),
        },
      ],
    });
  }

  return JSON.stringify({
    v: 2,
    bg: d.bg,
    layers: d.layers
      .filter((l) => l.visible)
      .map((l) => ({
        opacity: round(l.opacity, OPACITY_DECIMALS),
        sym: { segments: l.sym.segments, mirror: l.sym.mirror },
        strokes: l.strokes.map((st) => compactStroke(fold(st))),
      })),
  });
}

/**
 * SHA-256 of the render-equivalent projection, as lowercase hex.
 *
 * Takes the stored JSON rather than a parsed drawing so that both sides of a
 * comparison necessarily go through the same parse + projection. On the web this
 * needs a secure context (`crypto.subtle` is undefined on plain http from a
 * non-localhost host — see the dev-server note in README).
 */
export async function contentHash(json: string): Promise<string> {
  const projected = serializeForHash(deserialize(json));
  const bytes = new TextEncoder().encode(projected);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const view = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < view.length; i++) hex += view[i].toString(16).padStart(2, "0");
  return hex;
}

// ---- deserialization -----------------------------------------------------

const HEX = /^#[0-9a-fA-F]{6}$/;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function parseSym(raw: unknown, where: string): Symmetry {
  const sym = raw as Record<string, unknown> | undefined;
  if (!sym || typeof sym.segments !== "number" || typeof sym.mirror !== "boolean") {
    throw new DrawingParseError(`${where}: bad sym`);
  }
  if (!Number.isInteger(sym.segments) || sym.segments < MIN_SEGMENTS || sym.segments > MAX_SEGMENTS) {
    throw new DrawingParseError(`${where}: bad segments`);
  }
  return { segments: sym.segments, mirror: sym.mirror };
}

/** Running totals so the caps apply across the whole drawing, not per layer. */
interface Budget {
  strokes: number;
  points: number;
}

function parseStroke(sv: unknown, where: string, budget: Budget): Stroke {
  const s = sv as Record<string, unknown>;
  if (typeof s !== "object" || s === null) throw new DrawingParseError(`${where}: bad stroke`);

  if (s.tool !== "solid" && s.tool !== "glow") throw new DrawingParseError(`${where}: bad tool`);
  if (typeof s.color !== "string" || (s.color !== "spectrum" && !HEX.test(s.color))) {
    throw new DrawingParseError(`${where}: bad color`);
  }
  // M8: the floor is the ROUNDING GRID, not zero.
  //
  // `size` is serialized to 2dp, so anything under 0.005 writes back as
  // `"size":0` — which this same parser then rejects. A drawing saved at
  // size 0.004 is accepted, stored, and permanently destroyed by the first
  // client that re-saves it: /vector 500s, iOS throws, the hash backfill can
  // never process it. Refuse it on the way in instead of losing the piece.
  if (!isFiniteNumber(s.size) || s.size < MIN_SIZE || s.size > MAX_SIZE) {
    throw new DrawingParseError(`${where}: bad size`);
  }
  if (!isFiniteNumber(s.opacity) || s.opacity < 0 || s.opacity > 1) {
    throw new DrawingParseError(`${where}: bad opacity`);
  }
  // The flags are strictly the literal 1 when present. Accepting `true` or 0
  // would make two byte-different drawings render alike but hash differently.
  if (s.po !== undefined && s.po !== 1) throw new DrawingParseError(`${where}: bad po`);
  if (s.sm !== undefined && s.sm !== 1) throw new DrawingParseError(`${where}: bad sm`);
  if (!Array.isArray(s.pts)) throw new DrawingParseError(`${where}: bad pts`);

  budget.points += s.pts.length;
  if (budget.points > MAX_POINTS_TOTAL) throw new DrawingParseError("too many points");

  const pts: Pt[] = s.pts.map((pv) => {
    // A future revision may add tilt as a 5-tuple; a v2 reader must refuse it
    // rather than silently drop the extra channels.
    if (!Array.isArray(pv) || pv.length !== 3 || !pv.every(isFiniteNumber)) {
      throw new DrawingParseError(`${where}: bad pts`);
    }
    // M6: BOUND THE NUMBERS, because the other platform traps on them.
    //
    // Coordinates are normalized to roughly [-1, 1] and pressure to [0, 1], and
    // neither was range-checked at all. Swift's `Serialize` multiplies by the
    // decimal scale and calls `Int(...)`, which TRAPS — uncatchably — above
    // ~9.2e15. So one POST carrying `"x": 1e30` publishes a gallery item that
    // crash-loops every iOS client that renders it, and the worker stored the
    // caller's bytes verbatim and served them straight back.
    if (Math.abs(pv[0]) > MAX_COORD || Math.abs(pv[1]) > MAX_COORD) {
      throw new DrawingParseError(`${where}: coordinate out of range`);
    }
    if (pv[2] < 0 || pv[2] > 1) throw new DrawingParseError(`${where}: pressure out of range`);
    return [pv[0], pv[1], pv[2]] as Pt;
  });

  const out: Stroke = {
    tool: s.tool,
    color: s.color,
    size: s.size,
    opacity: s.opacity,
    pts,
  };
  if (s.po === 1) out.po = 1;
  if (s.sm === 1) out.sm = 1;
  return out;
}

/**
 * Parse and structurally validate stored vector JSON, accepting v1 and v2 and
 * always returning v2. A v1 drawing becomes exactly one layer, visible, at
 * opacity 1, named "Layer 1" with id "l1" — the same shape a fresh drawing
 * starts as on every platform.
 */
export function deserialize(json: string): DrawingV2 {
  // Byte length, not string length: layer names are user text and may be
  // multi-byte, and the cap is a storage cap.
  if (new TextEncoder().encode(json).length > VECTOR_HARD_CAP_BYTES) {
    throw new DrawingParseError("vector too large");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new DrawingParseError("invalid JSON");
  }
  if (typeof raw !== "object" || raw === null) throw new DrawingParseError("not an object");
  const d = raw as Record<string, unknown>;

  if (d.bg !== "light" && d.bg !== "dark") throw new DrawingParseError("bad bg");
  const budget: Budget = { strokes: 0, points: 0 };

  if (d.v === 1) {
    const sym = parseSym(d.sym, "drawing");
    if (!Array.isArray(d.strokes)) throw new DrawingParseError("bad strokes");
    budget.strokes = d.strokes.length;
    if (budget.strokes > MAX_STROKES_TOTAL) throw new DrawingParseError("too many strokes");
    const strokes = d.strokes.map((sv, i) => parseStroke(sv, `stroke ${i}`, budget));
    return {
      v: 2,
      bg: d.bg,
      layers: [{ id: "l1", name: "Layer 1", visible: true, opacity: 1, sym, strokes }],
    };
  }

  if (d.v !== 2) throw new DrawingParseError("unsupported version");

  if (!Array.isArray(d.layers)) throw new DrawingParseError("bad layers");
  if (d.layers.length < 1) throw new DrawingParseError("no layers");
  if (d.layers.length > MAX_LAYERS) throw new DrawingParseError("too many layers");

  const seenIds = new Set<string>();
  const layers: Layer[] = d.layers.map((lv, i) => {
    const l = lv as Record<string, unknown>;
    if (typeof l !== "object" || l === null) throw new DrawingParseError(`layer ${i}: bad layer`);

    if (typeof l.id !== "string" || !/^l[1-8]$/.test(l.id)) {
      throw new DrawingParseError(`layer ${i}: bad id`);
    }
    if (seenIds.has(l.id)) throw new DrawingParseError(`layer ${i}: duplicate id`);
    seenIds.add(l.id);

    const name = normalizeLayerName(l.name);
    if (name === null) throw new DrawingParseError(`layer ${i}: bad name`);
    if (typeof l.visible !== "boolean") throw new DrawingParseError(`layer ${i}: bad visible`);
    if (!isFiniteNumber(l.opacity) || l.opacity < 0 || l.opacity > 1) {
      throw new DrawingParseError(`layer ${i}: bad opacity`);
    }
    const sym = parseSym(l.sym, `layer ${i}`);

    if (!Array.isArray(l.strokes)) throw new DrawingParseError(`layer ${i}: bad strokes`);
    budget.strokes += l.strokes.length;
    if (budget.strokes > MAX_STROKES_TOTAL) throw new DrawingParseError("too many strokes");
    const strokes = l.strokes.map((sv, j) => parseStroke(sv, `layer ${i} stroke ${j}`, budget));

    return { id: l.id, name, visible: l.visible, opacity: l.opacity, sym, strokes };
  });

  return { v: 2, bg: d.bg, layers };
}

// ---- v1 interop ----------------------------------------------------------

/**
 * Does this drawing have anything the renderer will draw a layer for?
 *
 * The save path uses this to decide whether the piece can be DEDUPED, not
 * whether it can be saved. Every drawing with nothing visible projects to the
 * same empty picture, so they all hash alike — which is correct for a
 * render-equivalence hash and wrong as a uniqueness key: the first blank a user
 * saves would block every later one, regardless of the hidden work inside it.
 * Such a row stores a NULL hash instead, and the partial unique index (`WHERE
 * content_hash IS NOT NULL`) already means NULL is exempt.
 */
export function hasVisibleLayers(d: DrawingV2): boolean {
  return d.layers.some((l) => l.visible);
}

/**
 * Project a v2 drawing back to v1, or null when that would change the picture.
 *
 * The promise, stated once so it stops eroding by increments: the v1 body
 * renders identically to the v2 drawing, to within the 3dp the format already
 * rounds layer opacity to. Everything else returns null.
 *
 * Only faithful when every VISIBLE layer shares one symmetry, sits at opacity 1,
 * and carries no `po` or `sm` stroke. Anything else has no v1 representation:
 *
 *  - Mixed symmetry: v1 has one `sym` for the whole drawing.
 *  - Layer opacity < 1: folding it into each stroke's opacity is NOT the same
 *    picture. Per-layer compositing flattens the layer once and then blends it;
 *    per-stroke opacity blends every stroke separately, so overlapping strokes
 *    within the layer darken where they should not.
 *  - `po` / `sm`: an old parser requires 3-tuples and knows neither flag, so it
 *    would render the stroke as an unsmoothed, uniform-alpha polyline.
 *
 * Hidden layers are dropped rather than blocking the flatten — they contribute
 * nothing to the picture, which is the same reason the hash ignores them.
 */
export function flattenToV1(d: DrawingV2): DrawingV1 | null {
  const visible = d.layers.filter((l) => l.visible);

  // Nothing visible has NO faithful v1 form, even though it renders blank.
  // Handing back `{ strokes: [] }` was the one lossy branch in this function:
  // every other path either preserves the picture exactly or returns null. A v1
  // client given that body sees an empty drawing, and the moment it saves the
  // drawing back the hidden layers are gone for good. 426 is the honest answer —
  // "this is not something you can edit" — and it costs nothing, since a v1
  // client could not have shown the content anyway.
  if (visible.length === 0) return null;

  const first = visible[0].sym;
  for (const l of visible) {
    if (l.sym.segments !== first.segments || l.sym.mirror !== first.mirror) return null;
    // Rounded, NOT exact — the same rounding the hash applies. Compared exactly,
    // a layer at 0.9999 refuses to flatten while the hash rounds it to 1 and
    // hashes it as though it had flattened. Two definitions of "the same
    // opacity" that disagree mean two drawings can share a hash and yet get
    // different answers from `?v=1`. One definition, used by both.
    if (round(l.opacity, OPACITY_DECIMALS) !== 1) return null;
    for (const s of l.strokes) if (s.po === 1 || s.sm === 1) return null;
  }

  return {
    v: 1,
    bg: d.bg,
    sym: { segments: first.segments, mirror: first.mirror },
    strokes: visible.flatMap((l) => l.strokes),
  };
}

/** Serialize a v1 projection in the v1 canonical form (key order, rounding). */
export function serializeV1(d: DrawingV1): string {
  return JSON.stringify({
    v: 1,
    bg: d.bg,
    sym: { segments: d.sym.segments, mirror: d.sym.mirror },
    strokes: d.strokes.map(compactStroke),
  });
}

// ---- derived metadata ----------------------------------------------------

/** Union of hex colors across visible layers, in first-seen order. */
export function paletteOf(d: DrawingV2): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of d.layers) {
    if (!l.visible) continue;
    for (const s of l.strokes) {
      if (s.color !== "spectrum" && !seen.has(s.color)) {
        seen.add(s.color);
        out.push(s.color);
      }
    }
  }
  return out;
}

/**
 * The symmetry to describe the whole piece by: the top-most visible layer's,
 * or null when visible layers disagree.
 *
 * Null is what makes a piece "layered" in gallery copy, alt text, and OG
 * descriptions. Every consumer of the stored `segments` column has to render
 * that case rather than printing "0-fold symmetry".
 */
export function topSym(d: DrawingV2): Symmetry | null {
  const visible = d.layers.filter((l) => l.visible);
  if (visible.length === 0) return null;
  const top = visible[visible.length - 1].sym;
  for (const l of visible) {
    if (l.sym.segments !== top.segments || l.sym.mirror !== top.mirror) return null;
  }
  return { segments: top.segments, mirror: top.mirror };
}

/** Total stroke count across all layers, visible or not. */
export function strokeCount(d: DrawingV2): number {
  let n = 0;
  for (const l of d.layers) n += l.strokes.length;
  return n;
}
