// Pure helpers for accessible alt text. No I/O — safe to unit-test and to call
// synchronously on the save/serve hot path. The template value is the guaranteed
// fallback so every artwork response carries a non-empty `altText` even before
// (or if) the deferred AI vision upgrade runs.

// Named palette anchors. Display names are what surfaces in alt text; the hex is
// the anchor we snap an arbitrary stroke color to via nearest-RGB. "teal" is the
// friendly label for the crease blue anchor.
const PALETTE: { name: string; r: number; g: number; b: number }[] = [
  { name: "crane orange", ...rgb("#E84A27") },
  { name: "teal", ...rgb("#2E5E8C") },
  { name: "sax gold", ...rgb("#D9A521") },
  { name: "graphite", ...rgb("#1B2A33") },
  { name: "green", ...rgb("#3FA34D") },
  { name: "purple", ...rgb("#8E44AD") },
  { name: "light gray", ...rgb("#EAEAEA") },
];

function rgb(hex: string): { r: number; g: number; b: number } {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

/** Snap a hex color to the nearest named palette color (RGB Euclidean distance).
 *  "spectrum" (our rainbow tool) passes through unchanged. Unparseable input
 *  falls back to "spectrum" rather than throwing. */
export function nearestName(hex: string): string {
  if (hex === "spectrum") return "spectrum";
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return "spectrum";
  const c = rgb(hex);
  let best = PALETTE[0];
  let bestD = Infinity;
  for (const p of PALETTE) {
    const d = (c.r - p.r) ** 2 + (c.g - p.g) ** 2 + (c.b - p.b) ** 2;
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best.name;
}

/** Normalize palette (JSON string | array | null) into up to 3 deduped color
 *  names. */
function paletteNames(palette: string | string[] | null | undefined): string[] {
  let arr: unknown[] = [];
  if (Array.isArray(palette)) {
    arr = palette;
  } else if (typeof palette === "string" && palette) {
    try {
      const parsed = JSON.parse(palette);
      if (Array.isArray(parsed)) arr = parsed;
    } catch {
      /* not JSON — treat as no palette */
    }
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of arr) {
    if (typeof v !== "string") continue;
    const name = nearestName(v);
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length === 3) break;
  }
  return out;
}

/** Join names in prose: "a", "a and b", "a, b and c". */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Deterministic, always-non-empty alt text derived from symmetry + palette.
 *  e.g. "12-fold mirrored mandala in crane orange, teal and graphite". */
export function templateAlt(meta: {
  segments: number;
  mirror: number | boolean;
  palette: string | string[] | null;
}): string {
  const n = Number(meta.segments);
  const fold = Number.isFinite(n) && n > 0 ? `${n}-fold ` : "";
  const sym = meta.mirror ? "mirrored" : "rotational";
  const colors = joinNames(paletteNames(meta.palette));
  const inColors = colors ? ` in ${colors}` : "";
  return `${fold}${sym} mandala${inColors}`;
}
