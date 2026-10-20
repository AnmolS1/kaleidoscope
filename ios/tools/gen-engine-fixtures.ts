// Generates golden serialization fixtures for the Swift KaleidoEngine port by
// running the REAL web serializer (src/shared/vector.ts — the definition both the
// client and the Worker compile). The Swift engine must reproduce these
// byte-for-byte. Run from the repo root:
//
//   npx vite-node ios/tools/gen-engine-fixtures.ts
//
// Output: ios/KaleidoEngine/Tests/KaleidoEngineTests/Fixtures/golden.json
//
// Never hand-edit the expected strings. Regenerating from the web serializer is
// what makes the Swift test a parity check; typing the expectations by hand would
// turn it into a check that Swift agrees with whoever typed them.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  serialize,
  serializeV1,
  serializeForHash,
  contentHash,
  deserialize,
  flattenToV1,
  paletteOf,
  topSym,
  type DrawingV1,
  type DrawingV2,
  type Symmetry,
} from "../../src/shared/vector";
import { smoothStroke } from "../../src/shared/smooth";
import { copyName } from "../../src/client/engine/history";
import { exportSVG } from "../../src/client/engine/export";

const COPY_NAME_CASES = [
  "Layer 1",
  "a".repeat(40),                 // already at the limit
  "a".repeat(35) + "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}", // ZWJ family at the boundary
  "a".repeat(38) + "\u00e9",       // NFC-composed, one scalar
  "a".repeat(30) + "\u{1F1EC}\u{1F1E7}\u{1F1EC}\u{1F1E7}\u{1F1EC}\u{1F1E7}", // flags
  "a".repeat(37) + "\u0915\u094D\u0937\u093F",     // Devanagari conjunct
  "\u{1F600}".repeat(20),          // nothing but clusters
];

const root = process.cwd();

async function sha256hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- v1 cases -------------------------------------------------------------
// These predate v2 and are kept verbatim: each targets a number-formatting hazard
// for the Swift port, and their `expected` strings must not move. They now also
// carry the v2 bytes they upgrade into, so the upgrade path is pinned too.

const v1Cases: { name: string; drawing: DrawingV1 }[] = [
  {
    name: "empty",
    drawing: { v: 1, bg: "light", sym: { segments: 6, mirror: true }, strokes: [] },
  },
  {
    name: "integers-and-trailing-zeros",
    drawing: {
      v: 1,
      bg: "dark",
      sym: { segments: 12, mirror: false },
      // size 10 -> "10" (not "10.00"); opacity 1 -> "1"; pressure 0 -> "0".
      strokes: [{ tool: "solid", color: "#00ff88", size: 10, opacity: 1, pts: [[0, 0, 0]] }],
    },
  },
  {
    name: "fractions-and-padding",
    drawing: {
      v: 1,
      bg: "light",
      sym: { segments: 3, mirror: false },
      // 0.05 needs a padded leading zero; 0.5 must not print "0.50".
      strokes: [
        { tool: "solid", color: "#123456", size: 2.5, opacity: 0.5, pts: [[0.05, 0.001, 0.07], [0.5, 0.25, 0.5]] },
      ],
    },
  },
  {
    name: "negative-coords-half-up-rounding",
    drawing: {
      v: 1,
      bg: "light",
      sym: { segments: 8, mirror: true },
      // -0.1235 and 0.1235 exercise JS Math.round's toward-+inf half handling
      // under floating-point wobble (0.1235*1000 is actually 123.4999…).
      strokes: [
        {
          tool: "solid",
          color: "#ffffff",
          size: 7.125,
          opacity: 0.333,
          pts: [
            [-0.1235, 0.1235, 0.5],
            [-0.5005, 0.5005, 0.25],
            [-0.0001, 0.0004, 0.005], // round toward zero -> must serialize "0", never "-0"
            [1.5, -2, 1],
          ],
        },
      ],
    },
  },
  {
    name: "spectrum-and-glow",
    drawing: {
      v: 1,
      bg: "dark",
      sym: { segments: 24, mirror: true },
      strokes: [
        { tool: "glow", color: "spectrum", size: 18.4, opacity: 0.7, pts: [[0.2, 0.2, 0.6], [0.21, 0.19, 0.62]] },
        { tool: "solid", color: "#e84a27", size: 4, opacity: 0.85, pts: [[-0.3, 0.4, 0.9]] },
      ],
    },
  },
  {
    name: "many-points",
    drawing: {
      v: 1,
      bg: "light",
      sym: { segments: 5, mirror: false },
      strokes: [
        {
          tool: "solid",
          color: "#2e5e8c",
          size: 3.33,
          opacity: 0.9,
          pts: Array.from({ length: 20 }, (_, i) => [
            (i - 10) / 13,
            Math.sin(i) / 2,
            (i % 10) / 10,
          ]) as DrawingV1["strokes"][number]["pts"],
        },
      ],
    },
  },
];

// ---- v2 cases -------------------------------------------------------------

const SYM6: Symmetry = { segments: 6, mirror: false };
const SYM12: Symmetry = { segments: 12, mirror: true };

/** Two ordinary strokes, reused so fixtures differ only in the thing under test. */
const inkA: DrawingV2["layers"][number]["strokes"] = [
  { tool: "solid", color: "#e84a27", size: 6.5, opacity: 0.8, pts: [[-0.2, 0.1, 0.4], [0.15, -0.05, 0.9]] },
];
const inkB: DrawingV2["layers"][number]["strokes"] = [
  { tool: "glow", color: "spectrum", size: 21, opacity: 0.7, pts: [[0.3, 0.3, 1], [0.31, 0.29, 0.5], [0.4, 0.2, 0.25]] },
];

interface V2Case {
  name: string;
  drawing: DrawingV2;
  /**
   * False when the fixture deliberately bypasses `deserialize` — see
   * "control-chars-in-name". The Swift test then checks `serialize` and
   * `serializeForHash` only, not the parse round-trip.
   */
  parseable?: boolean;
  /** Name of a fixture whose CONTENT HASH must equal this one's. */
  hashTwinOf?: string;
}

const v2Cases: V2Case[] = [
  {
    // The shape every v1 piece upgrades into, and the only shape that flattens
    // back. If this one ever stops flattening, existing gallery pieces stop being
    // servable to old clients.
    name: "single-layer-v1-equivalent",
    drawing: {
      v: 2,
      bg: "light",
      layers: [{ id: "l1", name: "Layer 1", visible: true, opacity: 1, sym: SYM6, strokes: [...inkA, ...inkB] }],
    },
  },
  {
    // Mixed symmetry: no v1 representation (v1 has one `sym` for the drawing),
    // and `topSym` must be null so consumers render "layered" copy.
    name: "two-layers-mixed-sym",
    drawing: {
      v: 2,
      bg: "dark",
      layers: [
        { id: "l1", name: "Base", visible: true, opacity: 1, sym: SYM6, strokes: inkA },
        { id: "l2", name: "Overlay", visible: true, opacity: 1, sym: SYM12, strokes: inkB },
      ],
    },
  },
  {
    // Layer opacity < 1 has no v1 form: folding it into each stroke would darken
    // overlaps that per-layer compositing leaves alone.
    name: "layer-opacity-half",
    drawing: {
      v: 2,
      bg: "light",
      layers: [
        { id: "l1", name: "Base", visible: true, opacity: 1, sym: SYM6, strokes: inkA },
        { id: "l2", name: "Wash", visible: true, opacity: 0.5, sym: SYM6, strokes: inkB },
      ],
    },
  },
  {
    // Opacity 0.125 needs all three decimals; 0.0005 rounds up to 0.001, and the
    // layer stays in the hash projection even at opacity 0 (it is still visible).
    name: "layer-opacity-rounding",
    drawing: {
      v: 2,
      bg: "dark",
      layers: [
        { id: "l1", name: "", visible: true, opacity: 0.125, sym: SYM6, strokes: inkA },
        { id: "l2", name: "zero", visible: true, opacity: 0, sym: SYM6, strokes: inkB },
        { id: "l3", name: "wobble", visible: true, opacity: 0.0005, sym: SYM6, strokes: [] },
      ],
    },
  },
  {
    // `po` and `sm` are emitted only when set, and in that order after `opacity`.
    // A stroke with neither must be byte-identical to its v1 form.
    name: "po-and-sm-flags",
    drawing: {
      v: 2,
      bg: "light",
      layers: [
        {
          id: "l1",
          name: "Flags",
          visible: true,
          opacity: 1,
          sym: SYM12,
          strokes: [
            { tool: "solid", color: "#123456", size: 4, opacity: 1, po: 1, pts: [[0, 0, 0.5], [0.1, 0.1, 1]] },
            { tool: "solid", color: "#123456", size: 4, opacity: 1, sm: 1, pts: [[0, 0, 0.5], [0.1, 0.1, 1]] },
            { tool: "glow", color: "spectrum", size: 9, opacity: 0.6, po: 1, sm: 1, pts: [[0, 0, 0.5], [0.1, 0.1, 1]] },
            { tool: "solid", color: "#123456", size: 4, opacity: 1, pts: [[0, 0, 0.5], [0.1, 0.1, 1]] },
          ],
        },
      ],
    },
  },
  {
    // Layer names are user text, so they are on the byte-parity path. Quote and
    // backslash take short escapes; astral emoji, combining marks and U+2028 are
    // emitted RAW by JSON.stringify and must be raw here. Every name in this
    // fixture is validator-clean, so it also round-trips through `deserialize`.
    name: "unicode-names",
    drawing: {
      v: 2,
      bg: "dark",
      layers: [
        { id: "l1", name: 'He said "hi" \\ then left', visible: true, opacity: 1, sym: SYM6, strokes: [] },
        { id: "l2", name: "🎨 palette · café · Ω", visible: true, opacity: 1, sym: SYM6, strokes: inkA },
        // U+2028 LINE SEPARATOR: passes the name validator (not a C0/C1 control)
        // and JSON.stringify does NOT escape it. The one non-ASCII scalar a
        // "helpfully escape it" instinct in the Swift port would silently break.
        { id: "l3", name: "line\u2028sep", visible: true, opacity: 1, sym: SYM6, strokes: [] },
        // 20 astral emoji = exactly 40 UTF-16 code units: the limit is measured
        // in code units, not characters, so this is legal and 21 would not be.
        { id: "l4", name: "😀".repeat(20), visible: true, opacity: 1, sym: SYM6, strokes: [] },
      ],
    },
  },
  {
    // Hidden layers are dropped from the hash projection but kept in storage, so
    // this and its twin serialize to different bytes and hash the same.
    name: "hidden-layer",
    drawing: {
      v: 2,
      bg: "light",
      layers: [
        { id: "l1", name: "Kept", visible: true, opacity: 1, sym: SYM6, strokes: inkA },
        { id: "l2", name: "Scratch", visible: false, opacity: 0.4, sym: SYM12, strokes: inkB },
      ],
    },
    hashTwinOf: "hidden-layer-twin",
  },
  {
    // Same picture, different id and different name, no hidden layer. Proves the
    // projection drops id, name and hidden layers all three — a single fixture's
    // hash alone would prove none of them.
    name: "hidden-layer-twin",
    drawing: {
      v: 2,
      bg: "light",
      layers: [{ id: "l4", name: "Renamed 🙂", visible: true, opacity: 1, sym: SYM6, strokes: inkA }],
    },
  },
  {
    name: "max-layers-eight",
    drawing: {
      v: 2,
      bg: "dark",
      layers: Array.from({ length: 8 }, (_, i) => ({
        id: `l${i + 1}`,
        name: `Layer ${i + 1}`,
        visible: i % 3 !== 2,
        opacity: 1 - i / 20,
        sym: { segments: 3 + i * 3, mirror: i % 2 === 1 },
        strokes: i === 0 ? inkA : [],
      })),
    },
  },
  {
    // Every layer hidden: the projection's `layers` array is empty (but still
    // present), and the v1 flatten is NULL. A hidden layer alongside a visible
    // one never blocks a flatten; a drawing with nothing visible has no v1 form
    // at all, because the empty body it used to return is one a v1 client can
    // save back over the hidden work (REVIEW.md minor mA4).
    name: "all-layers-hidden",
    drawing: {
      v: 2,
      bg: "light",
      layers: [
        { id: "l1", name: "A", visible: false, opacity: 1, sym: SYM12, strokes: inkA },
        { id: "l2", name: "B", visible: false, opacity: 1, sym: SYM6, strokes: inkB },
      ],
    },
  },
  {
    // UPPERCASE hex. Its hash must come out identical to the lowercase twin's,
    // because case is folded in the projection (REVIEW.md S17) — and no other
    // fixture uses an uppercase colour, so without this one the fold is pinned
    // on neither platform. It was in fact missing from Swift entirely.
    name: "uppercase-hex-colour",
    drawing: {
      v: 2,
      bg: "light",
      layers: [
        {
          id: "l1",
          name: "A",
          visible: true,
          opacity: 1,
          sym: SYM6,
          strokes: inkA.map((s) => ({ ...s, color: s.color.toUpperCase() })),
        },
      ],
    },
  },
  {
    // The lowercase twin, so the equality is checkable by reading the file:
    // these two fixtures must carry the SAME hash and different bytes.
    name: "uppercase-hex-colour-twin",
    drawing: {
      v: 2,
      bg: "light",
      layers: [
        { id: "l1", name: "A", visible: true, opacity: 1, sym: SYM6, strokes: inkA },
      ],
    },
  },
  {
    // Layer opacity just inside the 3dp the format rounds to. The serializer
    // writes it as 1, so flatten must AGREE that it is 1 — comparing exactly
    // meant the caller's bytes and the bytes we store disagreed about whether
    // the drawing flattens, and therefore hashed apart (REVIEW.md minor mA5).
    // Pinned across platforms because a divergence here is invisible until it
    // is a duplicate row in production.
    name: "layer-opacity-just-under-one",
    drawing: {
      v: 2,
      bg: "light",
      layers: [
        { id: "l1", name: "A", visible: true, opacity: 1, sym: SYM6, strokes: inkA },
        { id: "l2", name: "B", visible: true, opacity: 0.9999, sym: SYM6, strokes: inkB },
      ],
    },
  },
  {
    // The control for the fixture above: 0.9994 rounds to 0.999, so it must NOT
    // flatten. Without it, a port that simply stopped checking opacity would
    // pass the pair.
    name: "layer-opacity-below-the-rounding-boundary",
    drawing: {
      v: 2,
      bg: "light",
      layers: [
        { id: "l1", name: "A", visible: true, opacity: 1, sym: SYM6, strokes: inkA },
        { id: "l2", name: "B", visible: true, opacity: 0.9994, sym: SYM6, strokes: inkB },
      ],
    },
  },
  {
    // DELIBERATELY UNPARSEABLE. `normalizeLayerName` rejects control characters,
    // so no fixture built through `deserialize` can carry one — but neither
    // `serialize` nor the Swift struct initializer validates, so the escaping is
    // still reachable if the validator is ever bypassed. This is the only fixture
    // that exercises the short escapes \b (0x08) and \f (0x0C) — which the Swift
    // port emitted as the six-character \u0008 / \u000c until T10. Built as a
    // literal, not parsed.
    name: "control-chars-in-name",
    parseable: false,
    drawing: {
      v: 2,
      bg: "light",
      layers: [
        {
          id: "l1",
          name: "back\bspace form\ffeed tab\t nl\n cr\r soh\u0001 del\u007f",
          visible: true,
          opacity: 1,
          sym: SYM6,
          strokes: inkA,
        },
      ],
    },
  },
];

// ---- build ----------------------------------------------------------------

interface V1Fixture {
  name: string;
  drawing: DrawingV1;
  /** v1 canonical bytes. */
  expected: string;
  /** The v2 bytes this upgrades into. */
  upgraded: string;
  /** Render-equivalent projection of the upgrade, and its SHA-256. */
  forHash: string;
  hash: string;
  /** `exportSVG` of the upgraded drawing (`deserialize(upgraded)`). */
  svg: string;
}

interface V2Fixture {
  name: string;
  drawing: DrawingV2;
  expected: string;
  forHash: string;
  hash: string;
  parseable: boolean;
  /** v1 canonical bytes, or null when the drawing has no faithful v1 form. */
  flattened: string | null;
  palette: string[];
  topSym: Symmetry | null;
  hashTwinOf?: string;
  /** `exportSVG` of `drawing` as given. */
  svg: string;
}

const v1Fixtures: V1Fixture[] = [];
for (const c of v1Cases) {
  const expected = serializeV1(c.drawing);
  const upgradedDrawing = deserialize(expected);
  const forHash = serializeForHash(upgradedDrawing);
  const hash = await contentHash(expected);
  if (hash !== (await sha256hex(forHash))) throw new Error(`${c.name}: hash disagrees with projection`);
  const upgraded = serialize(upgradedDrawing);
  // From the UPGRADED bytes, not the raw literal: that is the drawing a v1 piece
  // actually is once loaded (3dp-rounded), and the one Swift can rebuild with
  // `deserializeV2(upgraded)` without a second, unpinned upgrade path.
  const svg = exportSVG(deserialize(upgraded));
  v1Fixtures.push({ name: c.name, drawing: c.drawing, expected, upgraded, forHash, hash, svg });
}

const v2Fixtures: V2Fixture[] = [];
for (const c of v2Cases) {
  const parseable = c.parseable !== false;
  const expected = serialize(c.drawing);
  const forHash = serializeForHash(c.drawing);
  const hash = await sha256hex(forHash);
  const flat = flattenToV1(c.drawing);

  if (parseable) {
    // A fixture that does not survive its own round trip would pin Swift to bytes
    // the Worker would reject on save.
    const reparsed = deserialize(expected);
    if (serialize(reparsed) !== expected) throw new Error(`${c.name}: v2 round-trip is not byte-stable`);
    if ((await contentHash(expected)) !== hash) throw new Error(`${c.name}: contentHash disagrees`);
  }

  v2Fixtures.push({
    name: c.name,
    drawing: c.drawing,
    expected,
    forHash,
    hash,
    parseable,
    flattened: flat ? serializeV1(flat) : null,
    palette: paletteOf(c.drawing),
    topSym: topSym(c.drawing),
    ...(c.hashTwinOf ? { hashTwinOf: c.hashTwinOf } : {}),
    svg: exportSVG(c.drawing),
  });
}

for (const f of v2Fixtures) {
  if (!f.hashTwinOf) continue;
  const twin = v2Fixtures.find((t) => t.name === f.hashTwinOf);
  if (!twin) throw new Error(`${f.name}: hashTwinOf names a missing fixture`);
  if (twin.hash !== f.hash) throw new Error(`${f.name}: hash twin ${twin.name} does not match`);
  if (twin.expected === f.expected) throw new Error(`${f.name}: hash twin is byte-identical, proving nothing`);
}

// The smoothing golden is T01's file, copied in rather than recomputed here, so
// there is exactly one definition of the expected control points. Recomputing it
// and comparing first proves the copy is live rather than a stale duplicate.
interface SmoothGolden {
  alpha: number;
  points: [number, number, number][];
  cubics: { i: number; c1x: number; c1y: number; c2x: number; c2y: number; x: number; y: number }[];
}
const smoothPath = join(root, "test/unit/fixtures/smooth.json");
const smooth = JSON.parse(readFileSync(smoothPath, "utf8")) as SmoothGolden;
const recomputed = smoothStroke(smooth.points);
if (!recomputed) throw new Error("smooth fixture has too few points");
if (JSON.stringify(recomputed) !== JSON.stringify(smooth.cubics)) {
  throw new Error("test/unit/fixtures/smooth.json is stale — regenerate it in T01's tests first");
}

// ---- SVG export -----------------------------------------------------------
// Every v1/v2 fixture above also carries `svg`, the web exporter's output for
// it. These add what none of those drawings reach: the smoothed `C` branch, XML
// escaping, an empty stroke consuming an id index, exact toFixed ties, a tiny
// negative that must print "-0.00", float-tail opacities, and a non-default `S`.
// They are SVG-only: not every value here is one the format accepts on save.

interface SvgCase {
  name: string;
  drawing: DrawingV2;
  /** `exportSVG`'s `S`; absent means its default. */
  half?: number;
}

const svgCases: SvgCase[] = [
  {
    name: "svg-hazards",
    drawing: {
      v: 2,
      bg: "dark",
      layers: [
        {
          id: "l1",
          name: `Tom & Jerry <"quoted"> it's`,
          visible: true,
          opacity: 1,
          sym: { segments: 7, mirror: true },
          strokes: [
            // Smoothed and pressure-alpha'd: the `C` branch and the po mean.
            {
              tool: "solid", color: "#2e5e8c", size: 5, opacity: 0.9, po: 1, sm: 1,
              pts: smooth.points.map(([x, y, p]): [number, number, number] => [x, y, p]),
            },
            // Empty: skipped, but its index (1) is still consumed — the next id is s2.
            { tool: "solid", color: "#123456", size: 3, opacity: 1, pts: [] },
            // A dot. Size 2.25 at full pressure is width 1.125: an exact tie that
            // toFixed(2) rounds UP and libc printf rounds to even. Upper-case hex
            // passes through verbatim; 0.1 + 0.2 keeps its float tail.
            { tool: "solid", color: "#ABCDEF", size: 2.25, opacity: 0.1 + 0.2, pts: [[1 / 32, -1 / 32, 1]] },
            // ±1/32 × 500 = ±15.625, a tie of both signs; -0.000001 × 500 rounds
            // to zero but keeps its sign ("-0.00"); 1e-7 is "1e-7", not "1e-07".
            {
              tool: "solid", color: "#00ff88", size: 4, opacity: 1e-7,
              pts: [[-1 / 32, 3 / 32, 0.5], [-0.000001, 0.375, 0.25], [0.6, -0.000004, 0.75]],
            },
          ],
        },
        {
          id: "l2",
          name: "glow   🎨",
          visible: true,
          opacity: 0.1 + 0.2,
          sym: { segments: 24, mirror: false },
          strokes: [
            { tool: "glow", color: "spectrum", size: 13.7, opacity: 0.85, po: 1, pts: [[-0.4, -0.2, 0.33], [-0.35, -0.3, 0.66]] },
            { tool: "glow", color: "spectrum", size: 13.7, opacity: 0.8, sm: 1, pts: [[0.1, 0.7, 0.2], [0.2, 0.6, 0.4], [0.25, 0.4, 0.9], [0.1, 0.1, 1]] },
          ],
        },
        { id: "l3", name: "hidden", visible: false, opacity: 1, sym: SYM6, strokes: inkA },
      ],
    },
  },
  {
    name: "custom-half",
    half: 333,
    drawing: {
      v: 2,
      bg: "light",
      layers: [{ id: "l1", name: "A", visible: true, opacity: 1, sym: SYM12, strokes: [...inkA, ...inkB] }],
    },
  },
];

// The formatters on their own, over values the drawings only rarely hit: exact
// ties (where JS and libc disagree), the classic not-a-tie 1.005, and a seeded
// sweep through the real ranges — coordinates × S, widths, opacity products.
// `str` is `String(x)`, the raw stroke-opacity path.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(0x5f3759df);
const numberInputs: number[] = [
  1.125, -1.125, 0.375, 15.625, -15.625, 0.03125, 0.00005, -0.00005, 2.5, 0.5,
  1.005, 8.345, -0.0005, -0.000001, 0, 1, 0.1 + 0.2, 0.8 * 0.7, 1e-7, 1.5e-7,
  123456.789, 0.000001, 1e20, 1.5e21,
];
for (let i = 0; i < 300; i++) {
  numberInputs.push((rand() * 2 - 1) * 500); // coordinate × S
  numberInputs.push(rand() * 1000 * 0.5 * (0.35 + 0.65 * rand())); // width
  numberInputs.push(rand() * 0.7 * (0.25 + 0.75 * rand())); // opacity product
}
// k/8 is exact, and a tie at 2dp whenever k is odd.
for (let i = 0; i < 100; i++) numberInputs.push((Math.floor(rand() * 8000) - 4000) / 8);
const svgNumbers = numberInputs.map((x) => ({
  x,
  fixed2: x.toFixed(2),
  fixed4: x.toFixed(4),
  svg: String(Number(x.toFixed(4))),
  str: String(x),
}));

const out = {
  _comment:
    "Golden fixtures for the Swift KaleidoEngine port. Generated by " +
    "ios/tools/gen-engine-fixtures.ts running the REAL web serializer " +
    "(src/shared/vector.ts) — never hand-edit. `smooth` is copied verbatim from " +
    "test/unit/fixtures/smooth.json after verifying it against src/shared/smooth.ts.",
  v1: v1Fixtures,
  v2: v2Fixtures,
  smooth: { alpha: smooth.alpha, points: smooth.points, cubics: smooth.cubics },
  // REVIEW.md minor mI7. Duplicating a layer appends " copy" and trims until the
  // 40-unit name limit accepts it. The trim used to run by UTF-16 code unit on
  // the web and by grapheme cluster in Swift, and for a cluster made of several
  // scalars those are different answers — a truncated ZWJ family, a lone
  // regional indicator. Both drop clusters now, and these pin it: "both
  // implement UAX #29" is a claim about two separate implementations, which is
  // exactly the kind of claim that belongs in a fixture rather than a comment.
  copyNames: COPY_NAME_CASES.map((name) => ({ name, expected: copyName(name) })),
  // `exportSVG` parity beyond the per-fixture `svg` fields — see "SVG export".
  svgCases: svgCases.map((c) => ({
    name: c.name,
    drawing: c.drawing,
    half: c.half ?? null,
    expected: c.half === undefined ? exportSVG(c.drawing) : exportSVG(c.drawing, c.half),
  })),
  svgNumbers,
};


const outPath = join(root, "ios/KaleidoEngine/Tests/KaleidoEngineTests/Fixtures/golden.json");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");

console.log(`Wrote ${v1Fixtures.length} v1 + ${v2Fixtures.length} v2 fixtures to ${outPath}`);
for (const f of v1Fixtures) console.log(`  v1 ${f.name}: ${f.hash.slice(0, 12)}…`);
for (const f of v2Fixtures) {
  console.log(`  v2 ${f.name}: ${f.hash.slice(0, 12)}… flattened=${f.flattened === null ? "null" : "yes"}`);
}

// vite-node keeps its module runner alive, so without this the process writes
// the file and then simply never exits. Harmless when a human runs it and
// ctrl-Cs; a hung job that burns its whole timeout in CI.
process.exit(0);
