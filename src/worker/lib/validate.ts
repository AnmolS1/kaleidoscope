// Strict server-side validation of uploaded vector JSON + caps (spec §7, §10),
// plus the small env-var coercions the Plus/cap policy reads.
//
// The drawing format itself is NOT defined here — src/shared/vector.ts is the
// single definition, compiled by both the client and the Worker and mirrored in
// Swift. This module adapts it: it turns a parse failure into a stable wire
// error code and derives the flat metadata columns D1 stores.

import {
  deserialize,
  paletteOf,
  topSym,
  VECTOR_HARD_CAP_BYTES,
  type DrawingV2,
} from "../../shared/vector";
import { isReservedTitle } from "../../shared/title";
import type { Env } from "../types";

export const CAPS = {
  vectorBytes: VECTOR_HARD_CAP_BYTES,
  thumbBytes: 2 * 1024 * 1024,
  imageBytes: 6 * 1024 * 1024,
  ogBytes: 4 * 1024 * 1024,
  title: 120,
  dim: 4096,
};

export type DrawingMeta =
  | {
      ok: true;
      drawing: DrawingV2;
      /** topSym's segments, or 0 when visible layers disagree. */
      segments: number;
      mirror: number;
      palette: string | null;
      layers: number;
    }
  | { ok: false; error: string };

/**
 * Map a DrawingParseError message to the stable wire code the API has always
 * returned. The shared module throws human-readable messages (it is also a
 * client-side library, where a message is what you want); the API contract is
 * a machine code, and clients — including shipped iOS builds — switch on it.
 */
function errorCode(message: string): string {
  if (message.includes("too large")) return "vector_too_large";
  if (message.includes("JSON") || message.includes("not an object")) return "bad_json";
  if (message.includes("unsupported version")) return "bad_version";
  if (message.includes("bad bg")) return "bad_bg";
  if (message.includes("segments")) return "bad_segments";
  if (message.includes("sym")) return "bad_sym";
  if (message.includes("too many strokes")) return "too_many_strokes";
  if (message.includes("too many points")) return "too_many_points";
  if (message.includes("too many layers")) return "too_many_layers";
  if (message.includes("layers") || message.includes("layer")) return "bad_layers";
  if (message.includes("strokes")) return "bad_strokes";
  if (message.includes("tool")) return "bad_tool";
  if (message.includes("color")) return "bad_color";
  if (message.includes("size")) return "bad_size";
  if (message.includes("opacity")) return "bad_opacity";
  if (message.includes("pts")) return "bad_pts";
  return "bad_drawing";
}

/**
 * Parse + validate stored vector JSON (v1 or v2) and derive the metadata
 * columns.
 *
 * `segments`/`mirror` come from `topSym`, which is null when visible layers
 * disagree — that case stores 0/0 and means "layered", NOT "0-fold". Every
 * consumer of the column has to render that (templateAlt, genalt, the OG
 * description, the client's ArtworkPage, iOS's ArtworkView).
 */
export function validateDrawingJson(json: string): DrawingMeta {
  let drawing: DrawingV2;
  try {
    drawing = deserialize(json);
  } catch (e) {
    return { ok: false, error: errorCode(e instanceof Error ? e.message : "") };
  }

  const sym = topSym(drawing);
  const palette = paletteOf(drawing);
  return {
    ok: true,
    drawing,
    segments: sym ? sym.segments : 0,
    mirror: sym?.mirror ? 1 : 0,
    palette: palette.length ? JSON.stringify(palette) : null,
    layers: drawing.layers.length,
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

/**
 * The strict title rule, applied only to clients that announce `X-Client-Caps:
 * v2` — i.e. ones whose save UI actually asks for a title. Legacy clients keep
 * the `cleanTitle` fallback, because a shipped iOS 1.1 has no field to type into
 * and rejecting its saves would break the app in the store.
 *
 * NFKC (not the NFC the layer-name rule uses) is deliberate and is used ONLY to
 * decide: it folds the compatibility lookalikes that would otherwise walk
 * straight past a naive comparison — fullwidth "ｕｎｔｉｔｌｅｄ", and Roman
 * numeral U+2170 for the "i".
 *
 * (An earlier version of this comment also cited the ﬁ ligature. That was
 * wrong: "untitled" contains no "fi", and ﬁ folds to "fi" — so the closest
 * thing, "unti<ﬁ>tled", normalizes to "untifitled" and is a perfectly valid
 * title. Verified in both runtimes rather than reasoned about.)
 * The value STORED is the trimmed original, so a title keeps the characters the
 * user typed.
 */
export function validateTitle(raw: unknown): { ok: true; title: string } | { ok: false } {
  const title = typeof raw === "string" ? raw.trim().slice(0, CAPS.title) : "";
  if (!title) return { ok: false };
  if (isReservedTitle(title)) return { ok: false };
  if (!isPrintableScalars(title)) return { ok: false };
  return { ok: true, title };
}

/**
 * The character check layer names always had and titles did not (S6).
 *
 * Titles flow into `<title>`, OG tags and alt text, so NUL, C0/C1 controls,
 * bidi overrides and zero-width joiners all end up somewhere they can misrender
 * a page or disguise one title as another. Layer names got a full
 * printable-scalar check; titles — the ones that are actually published — got
 * length and "Untitled" and nothing else.
 *
 * Deliberately the same rule as `normalizeLayerName`, plus the bidi and
 * zero-width classes, because these are published rather than local.
 */
function isPrintableScalars(s: string): boolean {
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    // C0 controls and DEL, then C1 controls.
    if (cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) return false;
    // Unpaired surrogates (for..of combines valid pairs).
    if (cp >= 0xd800 && cp <= 0xdfff) return false;
    // Bidi overrides/embeddings and the isolate family: these reorder the text
    // AROUND them, so a title can render as something it does not say.
    if (cp >= 0x202a && cp <= 0x202e) return false;
    if (cp >= 0x2066 && cp <= 0x2069) return false;
    // Zero-width space/non-joiner/joiner and the BOM used as a zero-width
    // no-break space: invisible, so two different titles can look identical.
    if (cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0xfeff) return false;
    // The REST of the invisible family (REVIEW.md minor mA2). The four above
    // are the famous ones; these render as nothing just as reliably, and in a
    // public gallery an invisible character is a way to publish a piece whose
    // title is indistinguishable from someone else's.
    if (cp === 0x00ad) return false; // soft hyphen
    if (cp === 0x061c) return false; // Arabic letter mark
    if (cp === 0x180e) return false; // Mongolian vowel separator
    if (cp === 0x200e || cp === 0x200f) return false; // LRM / RLM
    if (cp >= 0x2060 && cp <= 0x2064) return false; // word joiner + invisible operators
    if (cp >= 0xfe00 && cp <= 0xfe0f) return false; // variation selectors
    if (cp >= 0xe0100 && cp <= 0xe01ef) return false; // variation selectors supplement
    if (cp >= 0xe0000 && cp <= 0xe007f) return false; // tag characters
    // Blank-rendering FILLERS. Not zero-WIDTH — they occupy space and draw
    // nothing, which is the same spoof with extra steps, and unlike a real space
    // `trim()` does not remove them, so a title made only of these is "not
    // empty" and shows as empty.
    if (cp === 0x115f || cp === 0x1160 || cp === 0x3164 || cp === 0xffa0) return false;
    if (cp === 0x2800) return false; // braille pattern blank
  }
  return true;
}


/** True when the client announced it speaks v2 (and so has a title field). */
export function hasV2Caps(header: string | undefined): boolean {
  if (!header) return false;
  return header
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .includes("v2");
}

/**
 * SAVE-PATH default: an absent or unrecognised visibility means "public".
 *
 * Correct for POST, where the field is optional and public is the documented
 * default. Do NOT reuse it on PATCH — see `parseVisibility`.
 */
export function cleanVisibility(raw: unknown): "public" | "unlisted" | "private" {
  return raw === "unlisted" || raw === "private" ? raw : "public";
}

/**
 * PATCH-PATH parse: strict, because on an edit the same coercion PUBLISHES.
 *
 * `cleanVisibility` folds everything it does not recognise to "public". On the
 * save path that is a default; on the edit path it is a coercion that makes a
 * private piece public — `{"title":"x","visibility":null}` publishes, and so do
 * `"Private"`, `"unlisted "`, `0` and `{}`. A client renaming a private piece
 * with a slightly-wrong visibility field publishes it and stamps published_at.
 *
 * Returns undefined for "not supplied" and null for "supplied but invalid", so
 * the caller can 400 on the second without treating it as the first.
 */
export function parseVisibility(raw: unknown): "public" | "unlisted" | "private" | null | undefined {
  if (raw === undefined) return undefined;
  return raw === "public" || raw === "unlisted" || raw === "private" ? raw : null;
}

// ---- env coercion --------------------------------------------------------

/**
 * Read a boolean var. Tolerant of both the string form wrangler.jsonc writes
 * and a real boolean, because those are indistinguishable at the call site and
 * getting it wrong fails silently in exactly the direction that matters (a
 * feature that reads as off forever).
 *
 * Anything unrecognized, or unset, is FALSE — an unset flag must behave like
 * today's build.
 */
export function envFlag(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  return typeof v === "string" && v.trim().toLowerCase() === "true";
}

/** Read an integer var, falling back when unset. Returns NaN for a set-but-
 *  unparseable value so the caller can decide to fail closed. */
export function envInt(v: unknown, fallback: number): number {
  if (typeof v === "number") return v;
  if (typeof v !== "string" || v.trim() === "") return fallback;
  return Number.parseInt(v, 10);
}

/** A cap so large the conditional-publish predicate always passes. */
export const NO_CAP = 2147483647;

export type CapPolicy =
  | { ok: true; enforced: boolean; cap: number; epoch: number }
  | { ok: false };

/**
 * Resolve the free public-post cap for one user.
 *
 * `CAP_EPOCH` is read ONLY when the cap is actually being enforced. That is
 * what lets a bad epoch fail closed (a 500) without making today's builds — and
 * every existing test, which sets no vars at all — depend on a var that does not
 * exist yet. It also means there is exactly one code path: the conditional
 * publish always runs, and "no cap" is expressed as a cap of NO_CAP rather than
 * as a second branch that could get the visibility wrong.
 */
export function capPolicy(env: Env, plus: boolean): CapPolicy {
  if (!envFlag(env.PLUS_ENABLED) || plus) {
    return { ok: true, enforced: false, cap: NO_CAP, epoch: 0 };
  }
  const epoch = envInt(env.CAP_EPOCH, NaN);
  const cap = envInt(env.FREE_PUBLIC_CAP, 10);
  // Fail closed on BOTH, because each fails in an opposite and equally silent
  // direction once bound into the conditional publish:
  //
  //   NaN epoch → every `published_at >= epoch` is false → nothing counts →
  //     an unlimited cap, the one failure a paid feature must not have.
  //   NaN cap   → binds as SQL NULL → `COUNT(*) < NULL` is NULL, i.e. falsy →
  //     every public save silently lands unlisted with capReached, which the
  //     client cannot tell apart from a genuinely full account.
  //
  // Only §2.4 required the epoch check; the cap is the same class of bug and
  // costs one line.
  if (!Number.isFinite(epoch) || !Number.isFinite(cap)) return { ok: false };
  return { ok: true, enforced: true, cap, epoch };
}
