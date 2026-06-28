// Strict server-side validation of uploaded vector JSON + caps (spec §7, §10).
// Never trust client width/height beyond the cap.

export const CAPS = {
  vectorBytes: 256 * 1024,
  thumbBytes: 2 * 1024 * 1024,
  imageBytes: 6 * 1024 * 1024,
  ogBytes: 4 * 1024 * 1024,
  title: 120,
  dim: 4096,
  maxStrokes: 5000,
  maxPointsTotal: 200_000,
};

const HEX = /^#[0-9a-fA-F]{6}$/;

export type DrawingMeta =
  | { ok: true; segments: number; mirror: number; palette: string | null }
  | { ok: false; error: string };

export function validateDrawingJson(json: string): DrawingMeta {
  if (json.length > CAPS.vectorBytes) return { ok: false, error: "vector_too_large" };
  let d: any;
  try {
    d = JSON.parse(json);
  } catch {
    return { ok: false, error: "bad_json" };
  }
  if (typeof d !== "object" || d === null) return { ok: false, error: "bad_json" };
  if (d.v !== 1) return { ok: false, error: "bad_version" };
  if (d.bg !== "light" && d.bg !== "dark") return { ok: false, error: "bad_bg" };
  if (!d.sym || typeof d.sym.segments !== "number" || typeof d.sym.mirror !== "boolean") {
    return { ok: false, error: "bad_sym" };
  }
  if (d.sym.segments < 3 || d.sym.segments > 24) return { ok: false, error: "bad_segments" };
  if (!Array.isArray(d.strokes)) return { ok: false, error: "bad_strokes" };
  if (d.strokes.length > CAPS.maxStrokes) return { ok: false, error: "too_many_strokes" };

  const palette = new Set<string>();
  let pointCount = 0;
  for (const s of d.strokes) {
    if (s.tool !== "solid" && s.tool !== "glow") return { ok: false, error: "bad_tool" };
    if (typeof s.color !== "string") return { ok: false, error: "bad_color" };
    if (s.color !== "spectrum") {
      if (!HEX.test(s.color)) return { ok: false, error: "bad_color" };
      palette.add(s.color);
    }
    if (typeof s.size !== "number" || !Number.isFinite(s.size) || s.size <= 0) {
      return { ok: false, error: "bad_size" };
    }
    if (typeof s.opacity !== "number" || s.opacity < 0 || s.opacity > 1) {
      return { ok: false, error: "bad_opacity" };
    }
    if (!Array.isArray(s.pts)) return { ok: false, error: "bad_pts" };
    pointCount += s.pts.length;
    if (pointCount > CAPS.maxPointsTotal) return { ok: false, error: "too_many_points" };
  }

  return {
    ok: true,
    segments: d.sym.segments,
    mirror: d.sym.mirror ? 1 : 0,
    palette: palette.size ? JSON.stringify([...palette]) : null,
  };
}

export function clampDim(n: unknown): number {
  const v = typeof n === "number" ? n : parseInt(String(n), 10);
  if (!Number.isFinite(v) || v <= 0) return 1024;
  return Math.min(CAPS.dim, Math.max(1, Math.floor(v)));
}

export function cleanTitle(raw: unknown): string {
  const t = typeof raw === "string" ? raw.trim().slice(0, CAPS.title) : "";
  return t || "Untitled";
}

export function cleanVisibility(raw: unknown): "public" | "unlisted" | "private" {
  return raw === "unlisted" || raw === "private" ? raw : "public";
}
