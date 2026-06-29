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
export async function serveVectorJson(env: Env, key: string): Promise<Response | null> {
  const obj = await env.ART.get(key);
  if (!obj) return null;
  const stream = obj.body.pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": IMMUTABLE_CACHE,
      ETag: obj.httpEtag,
    },
  });
}

export async function putWebp(env: Env, key: string, body: ArrayBuffer | ReadableStream): Promise<void> {
  await env.ART.put(key, body, { httpMetadata: { contentType: "image/webp" } });
}

/** Build a cacheable Response from an R2 object, or null if missing. */
export async function serveObject(env: Env, key: string): Promise<Response | null> {
  const obj = await env.ART.get(key);
  if (!obj) return null;
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("Cache-Control", IMMUTABLE_CACHE);
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
