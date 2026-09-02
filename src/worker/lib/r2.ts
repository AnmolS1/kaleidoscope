// R2 storage. Vector JSON is the source of truth, gzipped. Renders (webp) are
// uploaded by the client (the Worker has no canvas). Served through the Worker
// with long immutable cache headers so Cloudflare's edge caches them; the bucket
// itself is never made world-public.

import type { Env } from "../types";

export const keys = {
  vector: (id: string) => `vec/${id}.json.gz`,
  image: (id: string) => `img/${id}.webp`,
  thumb: (id: string) => `thumb/${id}.webp`,
  og: (id: string) => `og/${id}.webp`,
  avatar: (userId: string) => `avatar/${userId}`,
};

export const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
/**
 * The same year of immutability, but PRIVATE.
 *
 * A private piece's bytes are immutable in exactly the same way a public one's
 * are — the content is addressed by id and never rewritten — so the freshness
 * story is unchanged. What must change is WHO may keep a copy: the URL carries
 * no per-user component, so `public` invites the browser cache, any
 * intermediary, and (one "Cache Everything" rule away) Cloudflare's edge to
 * store a private drawing and hand it to somebody else.
 */
export const PRIVATE_IMMUTABLE_CACHE = "private, max-age=31536000, immutable";

/** Cache directive for an artwork representation, by the artwork's visibility. */
export function cacheFor(visibility: string | null | undefined): string {
  return visibility === "private" ? PRIVATE_IMMUTABLE_CACHE : IMMUTABLE_CACHE;
}
// Avatars are overwritten on each login, so they can't be immutable. A day of
// freshness with a week of stale-while-revalidate keeps the edge fast without
// pinning a stale picture forever.
export const AVATAR_CACHE = "public, max-age=86400, stale-while-revalidate=604800";
const AVATAR_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const AVATAR_MAX_BYTES = 512 * 1024;

async function gzip(data: string): Promise<ArrayBuffer> {
  const cs = new CompressionStream("gzip");
  const stream = new Blob([data]).stream().pipeThrough(cs);
  return new Response(stream).arrayBuffer();
}

// Store gzipped bytes as opaque (no contentEncoding metadata) so R2/runtime
// never auto-(de)compresses; we decompress explicitly on serve. This avoids the
// Content-Encoding header being dropped and handing the client raw gzip.
export async function putVectorGz(env: Env, id: string, json: string): Promise<void> {
  const gz = await gzip(json);
  await env.ART.put(keys.vector(id), gz, {
    httpMetadata: { contentType: "application/octet-stream" },
  });
}

/** Serve the gzipped vector as decompressed JSON. */
export async function serveVectorJson(
  env: Env,
  key: string,
  visibility?: string | null,
): Promise<Response | null> {
  const obj = await env.ART.get(key);
  if (!obj) return null;
  const stream = obj.body.pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": cacheFor(visibility),
      ETag: obj.httpEtag,
    },
  });
}

/**
 * Read the stored vector back as decompressed JSON text, with the R2 etag the
 * bytes came with.
 *
 * `serveVectorJson` streams and never materializes the body, which is right for
 * the pass-through path. Version negotiation has to *parse* the drawing, so it
 * needs the text — and it needs the etag from the SAME object read, both because
 * a second `get()` is a second round trip and because the etag must describe the
 * bytes we actually flattened.
 */
export async function readVectorJson(
  env: Env,
  key: string,
): Promise<{ json: string; etag: string } | null> {
  const obj = await env.ART.get(key);
  if (!obj) return null;
  const stream = obj.body.pipeThrough(new DecompressionStream("gzip"));
  return { json: await new Response(stream).text(), etag: obj.httpEtag };
}

/**
 * Derive an etag for a DERIVED representation of a stored object.
 *
 * An etag is per-URL, so `?v=2` and the flattened URL could legally reuse one
 * string — but a shared CDN keyed on anything looser than the full URL, or a
 * client that carries an If-None-Match across the two, would then be told two
 * different bodies are the same entity. The suffix keeps the representations
 * distinguishable while staying derived from (and invalidated by) the stored
 * object's own etag.
 *
 * R2's `httpEtag` is a quoted strong etag; unwrap before appending so the result
 * is a valid quoted string and not `"abc"-v1`.
 */
export function variantEtag(etag: string, suffix: string): string {
  const m = /^(?:W\/)?"(.*)"$/.exec(etag);
  return `"${m ? m[1] : etag}-${suffix}"`;
}

export async function putWebp(env: Env, key: string, body: ArrayBuffer | ReadableStream): Promise<void> {
  await env.ART.put(key, body, { httpMetadata: { contentType: "image/webp" } });
}

/** Build a cacheable Response from an R2 object, or null if missing. */
export async function serveObject(
  env: Env,
  key: string,
  visibility?: string | null,
): Promise<Response | null> {
  const obj = await env.ART.get(key);
  if (!obj) return null;
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("Cache-Control", cacheFor(visibility));
  headers.set("ETag", obj.httpEtag);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/octet-stream");
  return new Response(obj.body, { headers });
}

export async function deleteArtworkObjects(env: Env, id: string): Promise<void> {
  await env.ART.delete([keys.vector(id), keys.image(id), keys.thumb(id), keys.og(id)]);
}

// Fetch a user's Google avatar server-side (the page CSP doesn't apply here) and
// cache the bytes in R2 so we can serve them same-origin. Best-effort: never
// throws, returns false on any failure so login is never blocked by it.
export async function cacheRemoteAvatar(
  env: Env,
  userId: string,
  pictureUrl: string,
): Promise<boolean> {
  try {
    // Ask Google for a reasonable fixed size instead of whatever default it picked.
    const url = pictureUrl.replace(/=s\d+-c$/, "=s192-c");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    let res: Response;
    try {
      res = await fetch(url, { signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (res.status !== 200) return false;

    const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!AVATAR_TYPES.has(contentType)) return false;

    const bytes = await res.arrayBuffer();
    if (bytes.byteLength === 0 || bytes.byteLength > AVATAR_MAX_BYTES) return false;

    await env.ART.put(keys.avatar(userId), bytes, {
      httpMetadata: { contentType },
    });
    return true;
  } catch {
    return false;
  }
}

/** Serve a cached avatar with short-lived cache headers, or null if none stored. */
export async function serveAvatar(env: Env, userId: string): Promise<Response | null> {
  const obj = await env.ART.get(keys.avatar(userId));
  if (!obj) return null;
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("Cache-Control", AVATAR_CACHE);
  headers.set("ETag", obj.httpEtag);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/octet-stream");
  return new Response(obj.body, { headers });
}
