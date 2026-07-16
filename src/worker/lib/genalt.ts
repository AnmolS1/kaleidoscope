// Deferred AI upgrade for artwork alt text. Runs the LLaVA vision model to turn
// the rendered image + known symmetry/palette metadata into one factual
// sentence, then persists it. Strictly best-effort: the template value is
// already stored, so any failure here (rate limit, bad input, model error)
// leaves an accessible fallback in place and NEVER throws — safe to hand to
// `waitUntil`.

import type { Env } from "../types";
import { setArtworkAlt } from "./db";

// Pinned image-to-text model (same one the name-suggestion route uses).
const VISION_MODEL = "@cf/llava-hf/llava-1.5-7b-hf";
const ALT_MAX_CHARS = 240;

// workerd's Ai binding is loosely typed for arbitrary models; mirror the cast the
// suggest-names route uses.
type LooseAI = { run(model: string, input: unknown): Promise<unknown> };

export interface AltMeta {
  segments: number;
  mirror: number | boolean;
  palette: string | string[] | null;
}

/** Collapse a model reply to a single clean sentence, capped in length. */
function oneSentence(raw: string): string {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) return "";
  // Keep through the first sentence terminator, else the whole (capped) reply.
  const m = text.match(/^.*?[.!?](?=\s|$)/);
  const s = (m ? m[0] : text).trim();
  return s.length > ALT_MAX_CHARS ? `${s.slice(0, ALT_MAX_CHARS - 1).trimEnd()}…` : s;
}

/**
 * Generate and persist AI alt text for one artwork. `imageBytes` is the rendered
 * webp already in hand on the save path (no R2 re-read needed there). Best-effort;
 * resolves to `true` only when an AI sentence was persisted, `false` otherwise
 * (leaving the caller's template fallback in place). Never rejects.
 */
export async function generateAlt(
  env: Env,
  id: string,
  imageBytes: ArrayBuffer,
  meta: AltMeta,
): Promise<boolean> {
  try {
    const ai = env.AI as unknown as LooseAI;
    const n = Number(meta.segments);
    const symmetryHint =
      Number.isFinite(n) && n > 0
        ? `It has ${n}-fold ${meta.mirror ? "mirror (dihedral)" : "rotational"} symmetry.`
        : "";
    const out = (await ai.run(VISION_MODEL, {
      image: [...new Uint8Array(imageBytes)],
      prompt:
        "You are writing accessibility alt text for a blind reader. This is an abstract " +
        "kaleidoscope mandala. In ONE factual sentence, describe its colors, how dense or " +
        `sparse it is, and its overall character. ${symmetryHint} Do not start with "The image".`,
      max_tokens: 128,
    })) as { description?: string; response?: string };

    const sentence = oneSentence((out?.description ?? out?.response ?? "").toString());
    if (!sentence) return false; // keep the template fallback
    await setArtworkAlt(env, id, sentence);
    return true;
  } catch {
    // Template value already persisted; nothing to do.
    return false;
  }
}
