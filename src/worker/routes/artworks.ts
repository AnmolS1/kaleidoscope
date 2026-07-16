import { Hono, type Context } from "hono";
import type { AppEnv } from "../middleware";
import { requireAuth, requireCsrf } from "../middleware";
import { verifyTurnstile } from "../lib/turnstile";
import { checkAll } from "../lib/ratelimit";
import {
  CAPS,
  validateDrawingJson,
  clampDim,
  cleanTitle,
  cleanVisibility,
} from "../lib/validate";
import { newArtworkId } from "../lib/ids";
import {
  insertArtwork,
  getArtwork,
  getArtworkWithAuthor,
  deleteArtworkRow,
  updateArtwork,
  incrementLikes,
} from "../lib/db";
import { keys, putVectorGz, putWebp, serveObject, serveVectorJson, deleteArtworkObjects } from "../lib/r2";
import type { Artwork } from "../types";

export const artworks = new Hono<AppEnv>();

const PER_HOUR = { limit: 60, windowSec: 3600 };
const PER_DAY = { limit: 300, windowSec: 86400 };
const LIKE_RULE = { limit: 120, windowSec: 3600 };
const SUGGEST_RULE = { limit: 30, windowSec: 3600 };

// Workers AI model ids — the catalog changes, so these are pinned at build time
// (verified current against the Cloudflare docs). llava is the documented
// image-to-text model; the -fast llama has no deprecation date + a 128k window.
const VISION_MODEL = "@cf/llava-hf/llava-1.5-7b-hf";
const INSTRUCT_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

function canView(art: Artwork, userId: string | undefined): boolean {
  return art.visibility !== "private" || art.user_id === userId;
}

// workerd FormData returns File objects at runtime, but the worker lib types
// entries as string|null — duck-type to recover the upload.
interface UploadFile {
  size: number;
  type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}
function fileFrom(v: unknown): UploadFile | null {
  if (v && typeof v === "object" && typeof (v as UploadFile).arrayBuffer === "function") {
    return v as UploadFile;
  }
  return null;
}

// ---- create ----
artworks.post("/", requireAuth, requireCsrf, async (c) => {
  const user = c.get("user")!;
  const ip = c.req.header("CF-Connecting-IP");

  const form = await c.req.formData().catch(() => null);
  if (!form) return c.json({ error: "bad_form" }, 400);

  // Native (Bearer) clients skip Turnstile: there's no ambient credential to
  // forge and the session + per-user rate limits already gate abuse. Web (cookie)
  // auth still must pass the challenge.
  if (c.get("session")?.via !== "bearer") {
    const turnstileToken = String(form.get("turnstile") ?? "");
    if (!(await verifyTurnstile(c.env, turnstileToken, ip))) {
      return c.json({ error: "turnstile_failed" }, 403);
    }
  }

  const allowed = await checkAll(c.env, [
    { key: `save:${user.id}:h`, rule: PER_HOUR },
    { key: `save:${user.id}:d`, rule: PER_DAY },
  ]);
  if (!allowed) return c.json({ error: "rate_limited", message: "Whoa — slow down a little." }, 429);

  const drawing = form.get("drawing");
  if (typeof drawing !== "string") return c.json({ error: "missing_drawing" }, 400);
  const meta = validateDrawingJson(drawing);
  if (!meta.ok) return c.json({ error: meta.error }, 400);

  const image = fileFrom(form.get("image"));
  const thumb = fileFrom(form.get("thumb"));
  const og = fileFrom(form.get("og"));
  if (!image || !thumb) {
    return c.json({ error: "missing_render" }, 400);
  }
  if (image.size > CAPS.imageBytes || thumb.size > CAPS.thumbBytes) {
    return c.json({ error: "render_too_large" }, 413);
  }
  if (!image.type.startsWith("image/") || !thumb.type.startsWith("image/")) {
    return c.json({ error: "bad_render_type" }, 400);
  }

  const remixRaw = form.get("remixOf");
  let remixOf: string | null = null;
  if (typeof remixRaw === "string" && remixRaw) {
    const parent = await getArtwork(c.env, remixRaw);
    if (parent && parent.visibility !== "private") remixOf = parent.id;
  }

  const id = newArtworkId();
  const width = clampDim(form.get("width"));
  const height = clampDim(form.get("height"));

  // store source-of-truth vector + renders
  await putVectorGz(c.env, id, drawing);
  await putWebp(c.env, keys.image(id), await image.arrayBuffer());
  await putWebp(c.env, keys.thumb(id), await thumb.arrayBuffer());
  if (og && og.size <= CAPS.ogBytes) {
    await putWebp(c.env, keys.og(id), await og.arrayBuffer());
  }

  await insertArtwork(c.env, {
    id,
    user_id: user.id,
    title: cleanTitle(form.get("title")),
    visibility: cleanVisibility(form.get("visibility")),
    image_key: keys.image(id),
    thumb_key: keys.thumb(id),
    vector_key: keys.vector(id),
    width,
    height,
    segments: meta.segments,
    mirror: meta.mirror,
    palette: meta.palette,
    remix_of: remixOf,
    created_at: Date.now(),
  });

  return c.json({ id, url: `${c.env.PUBLIC_BASE_URL}/p/${id}` }, 201);
});

// ---- AI name suggestions ----
// Best-effort: any failure (rate limit, bad input, model error) returns
// { names: [] } so the save flow is never blocked by naming.
type LooseAI = { run(model: string, input: unknown): Promise<unknown> };

/** Pull up to 3 clean title strings out of a model's free-form reply. */
function parseNames(raw: unknown): string[] {
  const text = typeof raw === "string" ? raw : "";
  let arr: unknown[] | null = null;
  const match = text.match(/\[[\s\S]*\]/); // first JSON array in the reply
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed)) arr = parsed;
    } catch {
      /* fall through to line parsing */
    }
  }
  if (!arr) {
    // Fallback: split lines, strip list markers / numbering / quotes.
    arr = text
      .split("\n")
      .map((l) => l.replace(/^[\s\-*\d.)"']+/, "").replace(/["']+$/, "").trim())
      .filter(Boolean);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of arr) {
    if (typeof v !== "string") continue;
    const t = v.trim().slice(0, CAPS.title);
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
    if (out.length === 3) break;
  }
  return out;
}

artworks.post("/suggest-names", requireAuth, async (c) => {
  const user = c.get("user")!;
  // Rate-limited → just no suggestions (never an error the client must handle).
  if (!(await checkAll(c.env, [{ key: `suggest:${user.id}:h`, rule: SUGGEST_RULE }]))) {
    return c.json({ names: [] });
  }

  try {
    const form = await c.req.formData();
    const thumb = fileFrom(form.get("thumb"));
    if (!thumb || thumb.size > CAPS.thumbBytes || !thumb.type.startsWith("image/")) {
      return c.json({ names: [] });
    }

    const segments = Number(form.get("segments")) || 0;
    const mirror = String(form.get("mirror") ?? "") === "1" || form.get("mirror") === "true";
    const paletteRaw = String(form.get("palette") ?? "");
    const palette = paletteRaw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^#[0-9a-fA-F]{6}$/.test(s))
      .slice(0, 6);

    const ai = c.env.AI as unknown as LooseAI;

    // 1. Caption the mandala with the vision model.
    const bytes = new Uint8Array(await thumb.arrayBuffer());
    const capOut = (await ai.run(VISION_MODEL, {
      image: [...bytes],
      prompt:
        "Describe this abstract mandala in one vivid sentence — its colors, mood, and shapes.",
      max_tokens: 128,
    })) as { description?: string; response?: string };
    const caption = (capOut?.description ?? capOut?.response ?? "").toString().slice(0, 400);

    // 2. Turn the caption + symmetry/palette hints into 3 titles.
    const symmetryHint = segments
      ? `${segments}-fold ${mirror ? "mirror (dihedral)" : "rotational"} symmetry.`
      : "";
    const paletteHint = palette.length ? `Dominant colors: ${palette.join(", ")}.` : "";
    const prompt =
      `An abstract kaleidoscope mandala. ${caption} ${symmetryHint} ${paletteHint}\n` +
      `Invent exactly 3 short, evocative, non-cliché titles (2–4 words each). ` +
      `Avoid the words "kaleidoscope", "mandala", and "symmetry". ` +
      `Reply with ONLY a JSON array of 3 strings.`;
    const genOut = (await ai.run(INSTRUCT_MODEL, {
      messages: [
        {
          role: "system",
          content:
            "You name abstract artworks with poetic brevity. Reply with only a JSON array of 3 short title strings.",
        },
        { role: "user", content: prompt },
      ],
      max_tokens: 128,
    })) as { response?: string };

    return c.json({ names: parseNames(genOut?.response) });
  } catch {
    return c.json({ names: [] });
  }
});

// ---- metadata ----
artworks.get("/:id", async (c) => {
  const art = await getArtworkWithAuthor(c.env, c.req.param("id"));
  if (!art) return c.json({ error: "not_found" }, 404);
  if (!canView(art, c.get("user")?.id)) return c.json({ error: "not_found" }, 404);

  return c.json({
    id: art.id,
    title: art.title,
    visibility: art.visibility,
    author: { name: art.author_name, avatar: art.author_avatar },
    isOwner: art.user_id === c.get("user")?.id,
    segments: art.segments,
    mirror: !!art.mirror,
    width: art.width,
    height: art.height,
    palette: art.palette ? (JSON.parse(art.palette) as string[]) : [],
    remixOf: art.remix_of,
    likes: art.likes,
    createdAt: art.created_at,
    urls: {
      image: `/api/artworks/${art.id}/image`,
      thumb: `/api/artworks/${art.id}/thumb`,
      vector: `/api/artworks/${art.id}/vector`,
    },
  });
});

// ---- R2 proxies (edge-cached, immutable) ----
async function proxy(c: Context<AppEnv>, kind: "image" | "thumb" | "vector") {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "not_found" }, 404);
  const art = await getArtwork(c.env, id);
  if (!art) return c.json({ error: "not_found" }, 404);
  if (!canView(art, c.get("user")?.id)) return c.json({ error: "not_found" }, 404);
  if (kind === "vector") {
    const res = await serveVectorJson(c.env, art.vector_key);
    return res ?? c.json({ error: "not_found" }, 404);
  }
  const key = kind === "image" ? art.image_key : art.thumb_key;
  const res = await serveObject(c.env, key);
  return res ?? c.json({ error: "not_found" }, 404);
}

artworks.get("/:id/image", (c) => proxy(c, "image"));
artworks.get("/:id/thumb", (c) => proxy(c, "thumb"));
artworks.get("/:id/vector", (c) => proxy(c, "vector"));

// ---- edit ----
artworks.patch("/:id", requireAuth, requireCsrf, async (c) => {
  const art = await getArtwork(c.env, c.req.param("id"));
  if (!art) return c.json({ error: "not_found" }, 404);
  if (art.user_id !== c.get("user")!.id) return c.json({ error: "forbidden" }, 403);

  const body = (await c.req.json().catch(() => ({}))) as { title?: string; visibility?: string };
  await updateArtwork(c.env, art.id, {
    title: body.title !== undefined ? cleanTitle(body.title) : undefined,
    visibility: body.visibility !== undefined ? cleanVisibility(body.visibility) : undefined,
  });
  return c.json({ ok: true });
});

// ---- delete ----
artworks.delete("/:id", requireAuth, requireCsrf, async (c) => {
  const user = c.get("user")!;
  const art = await getArtwork(c.env, c.req.param("id"));
  if (!art) return c.json({ error: "not_found" }, 404);
  if (art.user_id !== user.id && user.role !== "admin") return c.json({ error: "forbidden" }, 403);

  await deleteArtworkRow(c.env, art.id);
  await deleteArtworkObjects(c.env, art.id);
  return c.json({ ok: true });
});

// ---- like ----
artworks.post("/:id/like", requireAuth, requireCsrf, async (c) => {
  const user = c.get("user")!;
  const art = await getArtwork(c.env, c.req.param("id"));
  if (!art || !canView(art, user.id)) return c.json({ error: "not_found" }, 404);
  if (!(await checkAll(c.env, [{ key: `like:${user.id}:h`, rule: LIKE_RULE }]))) {
    return c.json({ error: "rate_limited" }, 429);
  }
  const likes = await incrementLikes(c.env, art.id);
  return c.json({ likes });
});
