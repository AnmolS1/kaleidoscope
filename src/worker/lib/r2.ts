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
};

export const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

async function gzip(data: string): Promise<ArrayBuffer> {
  const cs = new CompressionStream("gzip");
  const stream = new Blob([data]).stream().pipeThrough(cs);
  return new Response(stream).arrayBuffer();
}

export async function putVectorGz(env: Env, id: string, json: string): Promise<void> {
  const gz = await gzip(json);
  await env.ART.put(keys.vector(id), gz, {
    httpMetadata: { contentType: "application/json", contentEncoding: "gzip" },
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
