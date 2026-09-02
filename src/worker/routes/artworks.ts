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
  validateTitle,
  hasV2Caps,
  capPolicy,
  parseVisibility,
} from "../lib/validate";
import { contentHash, deserialize, flattenToV1, serialize, serializeV1 } from "../../shared/vector";
import type { DrawingV1 } from "../../shared/vector";
import { newArtworkId } from "../lib/ids";
import {
  insertArtwork,
  getArtwork,
  getArtworkWithAuthor,
  deleteArtworkRow,
  updateArtwork,
  incrementLikes,
  findOwnByHash,
  findOtherByHash,
  publishArtwork,
  countPublicSince,
  hasPlus,
  DuplicateHashError,
} from "../lib/db";
import {
  keys,
  putVectorGz,
  putWebp,
  serveObject,
  serveVectorJson,
  readVectorJson,
  variantEtag,
  deleteArtworkObjects,
  cacheFor,
} from "../lib/r2";
import { templateAlt } from "../lib/alttext";
import { generateAlt } from "../lib/genalt";
import type { Artwork, Visibility } from "../types";

export const artworks = new Hono<AppEnv>();

const PER_HOUR = { limit: 60, windowSec: 3600 };
const PER_DAY = { limit: 300, windowSec: 86400 };
const LIKE_RULE = { limit: 120, windowSec: 3600 };
const SUGGEST_RULE = { limit: 30, windowSec: 3600 };
const HASH_RULE = { limit: 120, windowSec: 3600 };

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

// ---- save pre-flight ----
// The save dialog asks this the moment it opens, so it can show "you already
// saved this" (Open / edit title) or "someone else has this drawing" BEFORE the
// user types a title. The POST checks are the safety net, not the UX.
artworks.get("/hash/:sha", requireAuth, async (c) => {
  const user = c.get("user")!;
  const sha = c.req.param("sha");
  if (!/^[0-9a-f]{64}$/.test(sha)) return c.json({ error: "bad_hash" }, 400);
  if (!(await checkAll(c.env, [{ key: `hash:${user.id}:h`, rule: HASH_RULE }]))) {
    return c.json({ error: "rate_limited" }, 429);
  }

  const mine = await findOwnByHash(c.env, user.id, sha);
  const other = await findOtherByHash(c.env, user.id, sha);
  return c.json({
    mine: mine?.id ?? null,
    // Another user's PRIVATE piece is never named — it would leak both its
    // existence and its title. The POST still 409s on it (see below).
    other:
      other && other.visibility !== "private"
        ? { id: other.id, title: other.title, author: other.author_name }
        : null,
  });
});

// ---- create ----
artworks.post("/", requireAuth, requireCsrf, async (c) => {
  const user = c.get("user")!;
  const ip = c.req.header("CF-Connecting-IP");
  const now = Date.now();

  const form = await c.req.formData().catch(() => null);
  if (!form) return c.json({ error: "bad_form" }, 400);

  // The step order below is the contract (PLAN §2.3), not incidental. The
  // expensive and the CHARGED work happens last, so a save that turns out to be
  // a duplicate costs the user nothing: `checkAll` increments as it checks, so
  // rate-limiting before the dedupe check would burn a save slot on a request
  // that never writes a row.
  //
  //   turnstile → validate → hash → own dedupe → other-user 409
  //   → rate limit → R2 → D1 insert → conditional publish

  // 1. Turnstile. Native (Bearer) clients skip it: there's no ambient credential
  // to forge and the session + per-user rate limits already gate abuse. Web
  // (cookie) auth still must pass the challenge.
  if (c.get("session")?.via !== "bearer") {
    const turnstileToken = String(form.get("turnstile") ?? "");
    if (!(await verifyTurnstile(c.env, turnstileToken, ip))) {
      return c.json({ error: "turnstile_failed" }, 403);
    }
  }

  // 2. Cheap validation: form shape, title, drawing.
  const drawing = form.get("drawing");
  if (typeof drawing !== "string") return c.json({ error: "missing_drawing" }, 400);

  // A client that announces `X-Client-Caps: v2` has a title field, so an empty
  // or "Untitled" title is a bug worth rejecting. A legacy client (shipped iOS
  // 1.1, old web) has no such field; rejecting its saves would break an app
  // already in the store, so it keeps the "Untitled" fallback.
  const v2Client = hasV2Caps(c.req.header("X-Client-Caps"));
  let title: string;
  if (v2Client) {
    const t = validateTitle(form.get("title"));
    if (!t.ok) return c.json({ error: "title_required" }, 400);
    title = t.title;
  } else {
    title = cleanTitle(form.get("title"));
  }

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

  // 3. Hash the render-equivalent projection.
  const hash = await contentHash(drawing);

  // 4. Same user, same picture → return the piece they already have. Nothing is
  // written and nothing is mutated: re-saving is not an edit, and in particular
  // it never flips the existing piece's visibility.
  const own = await findOwnByHash(c.env, user.id, hash);
  if (own) {
    return c.json({ id: own.id, url: `${c.env.PUBLIC_BASE_URL}/p/${own.id}`, deduped: true });
  }

  // 5. Someone else's picture → refuse. A courtesy against posting an untouched
  // remix, not a policy: one extra dot defeats it, which is fine. `of` is only
  // named when the match is viewable, so a private piece is blocked without
  // being disclosed.
  const other = await findOtherByHash(c.env, user.id, hash);
  if (other) {
    return c.json(
      other.visibility === "private"
        ? { error: "duplicate_of_other" }
        : { error: "duplicate_of_other", of: other.id },
      409,
    );
  }

  // 6. Evaluate the cap BEFORE charging the rate limit (minor).
  //
  // A malformed CAP_EPOCH makes every save 500, and charging the budget first
  // meant a user hit by a deploy-side typo also burned their hourly and daily
  // save slots on requests that could never write. They then had to wait out a
  // limit for someone else's configuration mistake — and once it was fixed,
  // still could not save. Reading config costs nothing and is not attacker-
  // controlled, so there is no abuse budget to protect here.
  const requested = cleanVisibility(form.get("visibility"));
  const plus = await hasPlus(c.env, user.id);
  const policy = capPolicy(c.env, plus);
  // A cap we cannot evaluate is a cap we must not guess at. Fails closed.
  if (!policy.ok) return c.json({ error: "server_misconfigured" }, 500);

  // 7. Only now charge the rate limit — this request is going to write.
  const allowed = await checkAll(c.env, [
    { key: `save:${user.id}:h`, rule: PER_HOUR },
    { key: `save:${user.id}:d`, rule: PER_DAY },
  ]);
  if (!allowed) return c.json({ error: "rate_limited", message: "Whoa — slow down a little." }, 429);

  const remixRaw = form.get("remixOf");
  let remixOf: string | null = null;
  if (typeof remixRaw === "string" && remixRaw) {
    const parent = await getArtwork(c.env, remixRaw);
    if (parent && parent.visibility !== "private") remixOf = parent.id;
  }

  const id = newArtworkId();
  const width = clampDim(form.get("width"));
  const height = clampDim(form.get("height"));

  // 7. Store source-of-truth vector + renders. Keep the image bytes in hand so
  // the deferred alt-text upgrade can reuse them without re-reading R2.
  const imageBytes = await image.arrayBuffer();
  // Store the CANONICAL re-serialization, not the caller's bytes.
  //
  // `drawing` is whatever the client sent; `meta.drawing` is what the parser
  // accepted. Storing the former meant the bytes we serve back were never
  // normalized by anything — every question about the wire form (key order,
  // duplicate keys, hex case, unicode normalization, numeric formatting) became
  // a question about an arbitrary client's JSON encoder, and the answer was
  // served verbatim to every reader including iOS. Re-serializing makes the
  // stored form the one the format defines, so what comes out is what the hash
  // was computed over.
  await putVectorGz(c.env, id, serialize(meta.drawing));
  await putWebp(c.env, keys.image(id), imageBytes);
  await putWebp(c.env, keys.thumb(id), await thumb.arrayBuffer());
  if (og && og.size <= CAPS.ogBytes) {
    await putWebp(c.env, keys.og(id), await og.arrayBuffer());
  }

  // 8. Insert. A piece requested as public lands UNLISTED and is then published
  // by the conditional statement, so the cap check and the visibility change are
  // one atomic step — there is no window in which an over-cap piece is public.
  try {
    await insertArtwork(c.env, {
      id,
      user_id: user.id,
      title,
      visibility: requested === "public" ? "unlisted" : requested,
      image_key: keys.image(id),
      thumb_key: keys.thumb(id),
      vector_key: keys.vector(id),
      width,
      height,
      segments: meta.segments,
      mirror: meta.mirror,
      palette: meta.palette,
      remix_of: remixOf,
      created_at: now,
      // Deterministic fallback — guarantees altText is never null. Upgraded async below.
      alt_text: templateAlt(meta),
      content_hash: hash,
      layers: meta.layers,
    });
  } catch (e) {
    if (e instanceof DuplicateHashError) {
      // Lost the race against a concurrent save of the same drawing. Clean up
      // the blobs we just wrote — the row that would have owned them does not
      // exist, so nothing would ever reference or delete them.
      await deleteArtworkObjects(c.env, id);
      const existing = await findOwnByHash(c.env, user.id, hash);
      if (existing) {
        return c.json({
          id: existing.id,
          url: `${c.env.PUBLIC_BASE_URL}/p/${existing.id}`,
          deduped: true,
        });
      }
    }
    throw e;
  }

  // 9. Conditional publish. Runs for every public request, capped or not — "no
  // cap" is expressed as a cap so large the predicate always passes, which keeps
  // this the single path that can make a piece public.
  let visibility: Visibility = requested === "public" ? "unlisted" : requested;
  let capReached = false;
  if (requested === "public") {
    const published = await publishArtwork(c.env, {
      id,
      userId: user.id,
      cap: policy.cap,
      epoch: policy.epoch,
      now,
    });
    if (published) visibility = "public";
    else capReached = true;
  }

  // Best-effort AI upgrade after the response. c.executionCtx is absent in unit
  // tests (no 4th arg to app.request); the template value already stands in.
  try {
    c.executionCtx.waitUntil(generateAlt(c.env, id, imageBytes, meta));
  } catch {
    /* no ExecutionContext (tests) — skip the deferred upgrade */
  }

  // A finished piece is never unsaveable: hitting the cap still returns 201 with
  // the piece stored as unlisted, and the client explains why.
  const url = `${c.env.PUBLIC_BASE_URL}/p/${id}`;
  if (capReached) {
    const count = await countPublicSince(c.env, user.id, policy.epoch);
    return c.json({ id, url, visibility, capReached: true, cap: policy.cap, count }, 201);
  }
  return c.json({ id, url, visibility }, 201);
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

    const segmentsRaw = form.get("segments");
    const segments = Number(segmentsRaw) || 0;
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
    // A literal 0 means layers with differing symmetries, so no one fold count
    // describes it (see templateAlt) — left blank the model invents one. An
    // ABSENT field is a legacy client that never sends symmetry, which is not
    // the same claim, so that still says nothing.
    const symmetryHint = segments
      ? `${segments}-fold ${mirror ? "mirror (dihedral)" : "rotational"} symmetry.`
      : segmentsRaw === null
        ? ""
        : "Built from several layers, each with its own symmetry.";
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
    altText: art.alt_text ?? templateAlt(art),
    remixOf: art.remix_of,
    likes: art.likes,
    createdAt: art.created_at,
    updatedAt: art.updated_at,
    layers: art.layers,
    // NULL on legacy rows until the T02c backfill runs; clients must treat a
    // missing hash as "unknown", not as "no duplicate".
    contentHash: art.content_hash,
    urls: {
      image: `/api/artworks/${art.id}/image`,
      thumb: `/api/artworks/${art.id}/thumb`,
      vector: `/api/artworks/${art.id}/vector`,
    },
  });
});

// ---- R2 proxies (edge-cached, immutable) ----
async function proxy(c: Context<AppEnv>, kind: "image" | "thumb") {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "not_found" }, 404);
  const art = await getArtwork(c.env, id);
  if (!art) return c.json({ error: "not_found" }, 404);
  if (!canView(art, c.get("user")?.id)) return c.json({ error: "not_found" }, 404);
  const key = kind === "image" ? art.image_key : art.thumb_key;
  const res = await serveObject(c.env, key, art.visibility);
  return res ?? c.json({ error: "not_found" }, 404);
}

artworks.get("/:id/image", (c) => proxy(c, "image"));
artworks.get("/:id/thumb", (c) => proxy(c, "thumb"));

// ---- vector: version negotiation ----
//
// One drawing, two representations at two URLs.
//
//  ?v=2  the stored bytes, untouched. This path never parses, which is what
//        keeps it working for anything the current parser would reject.
//  else  the caller is a pre-1.2 client (iOS 1.1, an already-loaded web
//        bundle) that can only read v1, so flatten — or refuse with 426 when
//        flattening would change the picture rather than merely re-encode it.
//
// Stored v1 pieces go through the same flatten. deserialize() upgrades them to
// a single v2 layer and flattenToV1 projects them straight back, byte-for-byte
// (pinned by T01's fixture round-trip), so there is no legacy short-circuit to
// rot — and every no-param response carries the same etag shape.
artworks.get("/:id/vector", async (c) => {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "not_found" }, 404);
  const art = await getArtwork(c.env, id);
  if (!art) return c.json({ error: "not_found" }, 404);
  // The 426 lives strictly AFTER this check. A piece the caller may not see has
  // to answer 404 whether or not it happens to be flattenable; otherwise the
  // status code is an existence oracle for other people's private work — and a
  // fairly precise one, since 426 also reveals that the piece uses layers.
  if (!canView(art, c.get("user")?.id)) return c.json({ error: "not_found" }, 404);

  if (c.req.query("v") === "2") {
    const res = await serveVectorJson(c.env, art.vector_key, art.visibility);
    return res ?? c.json({ error: "not_found" }, 404);
  }

  const stored = await readVectorJson(c.env, art.vector_key);
  if (!stored) return c.json({ error: "not_found" }, 404);

  let flat: DrawingV1 | null;
  try {
    flat = flattenToV1(deserialize(stored.json));
  } catch {
    // The stored object is unreadable by the current parser. That is a server
    // fault, not the caller's, and the piece is not lost — ?v=2 still serves
    // the bytes. Never echo the parse message: it describes stored content.
    return c.json({ error: "vector_unreadable" }, 500);
  }
  if (!flat) return c.json({ error: "upgrade_required" }, 426);

  return new Response(serializeV1(flat), {
    headers: {
      "Content-Type": "application/json",
      // Same caching as the stored representation: the URL differs, so the two
      // never share a cache entry — but a private piece's flattened v1 form is
      // no less private than its v2 one, so the directive follows visibility.
      "Cache-Control": cacheFor(art.visibility),
      ETag: variantEtag(stored.etag, "v1"),
    },
  });
});

// ---- edit ----
artworks.patch("/:id", requireAuth, requireCsrf, async (c) => {
  const user = c.get("user")!;
  const art = await getArtwork(c.env, c.req.param("id"));
  if (!art) return c.json({ error: "not_found" }, 404);
  if (art.user_id !== user.id) return c.json({ error: "forbidden" }, 403);
  const now = Date.now();

  // An unparseable body is an ERROR, not an empty edit (minor).
  //
  // `.catch(() => ({}))` turned malformed JSON into "no fields supplied", which
  // then fell through to a 200 that changed nothing — including `updated_at`.
  // A client with a serialization bug got a success it could not distinguish
  // from a real one. Note the deliberate asymmetry: an EMPTY body is still fine
  // (some clients send none), it is unparseable content that is rejected.
  const raw = await c.req.text();
  let body: { title?: string; visibility?: string };
  if (raw.trim() === "") {
    body = {};
  } else {
    try {
      body = JSON.parse(raw) as { title?: string; visibility?: string };
    } catch {
      return c.json({ error: "bad_json" }, 400);
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return c.json({ error: "bad_json" }, 400);
    }
  }

  // And a PATCH that supplies nothing to change is a no-op, reported as one
  // rather than as a successful edit.
  if (body.title === undefined && body.visibility === undefined) {
    return c.json({ ok: true, changed: false });
  }

  // The title rule applies only when the body actually carries a title. A
  // visibility-only edit on one of the old "Untitled" rows must keep working —
  // otherwise 1.2 would make every legacy piece unpublishable.
  let title: string | undefined;
  if (body.title !== undefined) {
    if (hasV2Caps(c.req.header("X-Client-Caps"))) {
      const t = validateTitle(body.title);
      if (!t.ok) return c.json({ error: "title_required" }, 400);
      title = t.title;
    } else {
      title = cleanTitle(body.title);
    }
  }

  // Strict on PATCH: an unrecognised value is an error, not a default to
  // "public". `cleanVisibility` would silently publish a private piece.
  const visibility = parseVisibility(body.visibility);
  if (visibility === null) return c.json({ error: "bad_visibility" }, 400);

  // Going public goes through the conditional publish so the cap check and the
  // visibility change are one statement. Everything else is a plain update that
  // deliberately leaves `published_at` alone.
  if (visibility === "public" && art.visibility !== "public") {
    const policy = capPolicy(c.env, await hasPlus(c.env, user.id));
    if (!policy.ok) return c.json({ error: "server_misconfigured" }, 500);

    const published = await publishArtwork(c.env, {
      id: art.id,
      userId: user.id,
      cap: policy.cap,
      epoch: policy.epoch,
      now,
    });
    if (!published) {
      const count = await countPublicSince(c.env, user.id, policy.epoch);
      return c.json({ error: "cap_reached", cap: policy.cap, count }, 402);
    }
    if (title !== undefined) await updateArtwork(c.env, art.id, { title, updated_at: now });
    return c.json({ ok: true, visibility: "public" });
  }

  // An already-public piece asked to be public again must NOT go through the
  // conditional publish: its own row is inside the count, so at exactly the cap
  // the predicate reads `cap < cap` and an idempotent no-op would 402.
  await updateArtwork(c.env, art.id, {
    title,
    visibility: visibility === "public" ? undefined : visibility,
    updated_at: now,
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
