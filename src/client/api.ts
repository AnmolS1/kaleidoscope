// Typed fetch wrapper for the Worker API. CSRF token is captured from /api/me
// and replayed on mutating requests. Expanded with artwork/gallery calls in
// Phase 6.

export interface SessionUser {
  id: string;
  name: string | null;
  avatar: string | null;
  role: "user" | "admin";
  flagged: boolean;
}

/**
 * The Plus entitlement block from /api/me. `enabled` is the PLUS_ENABLED kill
 * switch: while it is false there is no cap anywhere and no Plus UI, so a client
 * must read it before showing any paywall affordance.
 */
export interface PlusInfo {
  active: boolean;
  sources: Array<"apple" | "lemonsqueezy" | "comp">;
  publicCount: number;
  publicCap: number | null;
  layerCap: number;
  enabled: boolean;
}

export interface MeResponse {
  user: SessionUser | null;
  csrf?: string;
  turnstileSiteKey?: string;
  plus?: PlusInfo;
}

/** Layers a free account may add. The floor when /api/me says nothing. */
export const DEFAULT_LAYER_CAP = 3;

let csrfToken: string | null = null;
let turnstileSiteKey: string | null = null;

export function getCsrf(): string | null {
  return csrfToken;
}

export function getTurnstileSiteKey(): string | null {
  return turnstileSiteKey;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const method = (init.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    headers.set("Content-Type", headers.get("Content-Type") ?? "application/json");
    if (csrfToken) headers.set("X-CSRF-Token", csrfToken);
  }
  const res = await fetch(path, { ...init, headers, credentials: "same-origin" });
  if (!res.ok) {
    let code = "error";
    try {
      const body = (await res.json()) as { error?: string };
      code = body.error ?? code;
    } catch {
      /* non-json */
    }
    throw new ApiError(res.status, code);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface MeResult {
  user: SessionUser | null;
  plus: PlusInfo | null;
}

/**
 * Session + entitlement. `plus` is null against a worker that predates it, so
 * every caller has to have a default ready rather than assuming the block is
 * there — a new bundle can be loaded against an old worker for the length of one
 * deploy, and the layer cap must not become NaN in that window.
 */
export async function fetchMe(): Promise<MeResult> {
  const data = await request<MeResponse>("/api/me");
  if (data.csrf) csrfToken = data.csrf;
  if (data.turnstileSiteKey) turnstileSiteKey = data.turnstileSiteKey;
  return { user: data.user, plus: parsePlus(data.plus) };
}

function parsePlus(raw: unknown): PlusInfo | null {
  if (typeof raw !== "object" || raw === null) return null;
  const p = raw as Record<string, unknown>;
  const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  return {
    active: p.active === true,
    sources: Array.isArray(p.sources) ? (p.sources.filter((s) => typeof s === "string") as PlusInfo["sources"]) : [],
    publicCount: num(p.publicCount, 0),
    publicCap: typeof p.publicCap === "number" && Number.isFinite(p.publicCap) ? p.publicCap : null,
    layerCap: num(p.layerCap, DEFAULT_LAYER_CAP),
    enabled: p.enabled === true,
  };
}

export function loginUrl(returnTo?: string): string {
  const u = new URL("/api/auth/login", location.origin);
  if (returnTo) u.searchParams.set("returnTo", returnTo);
  return u.toString();
}

export async function logout(): Promise<void> {
  await request<void>("/api/auth/logout", { method: "POST" });
}

// ---- artworks ----

export interface ArtworkMeta {
  id: string;
  title: string;
  altText: string;
  visibility: "public" | "unlisted" | "private";
  author: { name: string | null; avatar: string | null };
  isOwner: boolean;
  /** 0 means the visible layers disagree — render "layered", never "0-fold". */
  segments: number;
  mirror: boolean;
  /** Layer count. Optional: absent from a worker that predates v2. */
  layers?: number;
  contentHash?: string | null;
  updatedAt?: number | null;
  width: number;
  height: number;
  palette: string[];
  remixOf: string | null;
  likes: number;
  createdAt: number;
  urls: { image: string; thumb: string; vector: string };
}

export interface GalleryItem {
  id: string;
  title: string;
  altText: string;
  author?: { name: string | null; avatar: string | null };
  visibility?: string;
  thumb: string;
  likes: number;
  createdAt: number;
}

export interface SaveInput {
  title: string;
  visibility: "public" | "unlisted" | "private";
  drawingJson: string;
  image: Blob;
  thumb: Blob;
  og: Blob;
  turnstileToken: string;
  remixOf?: string | null;
}

export async function saveArtwork(input: SaveInput): Promise<{ id: string; url: string }> {
  const fd = new FormData();
  fd.set("drawing", input.drawingJson);
  fd.set("image", input.image, "image.webp");
  fd.set("thumb", input.thumb, "thumb.webp");
  fd.set("og", input.og, "og.webp");
  fd.set("title", input.title);
  fd.set("visibility", input.visibility);
  fd.set("turnstile", input.turnstileToken);
  if (input.remixOf) fd.set("remixOf", input.remixOf);

  const headers = new Headers();
  if (csrfToken) headers.set("X-CSRF-Token", csrfToken);
  const res = await fetch("/api/artworks", {
    method: "POST",
    body: fd,
    headers,
    credentials: "same-origin",
  });
  if (!res.ok) {
    let code = "error";
    try {
      code = ((await res.json()) as { error?: string }).error ?? code;
    } catch {
      /* */
    }
    throw new ApiError(res.status, code);
  }
  return (await res.json()) as { id: string; url: string };
}

export function getArtwork(id: string): Promise<ArtworkMeta> {
  return request<ArtworkMeta>(`/api/artworks/${id}`);
}

/**
 * Stored vector JSON. `?v=2` is the capability signal: it tells the worker this
 * client can read layers, so it serves the stored bytes instead of flattening to
 * v1 (or refusing with 426 when a flatten would change the picture). The URL
 * differs from the legacy one, so the two cache entries stay distinct.
 */
export async function getArtworkVector(id: string): Promise<string> {
  const res = await fetch(`/api/artworks/${id}/vector?v=2`, { credentials: "same-origin" });
  if (!res.ok) throw new ApiError(res.status, "vector_unavailable");
  return res.text(); // browser transparently gunzips (Content-Encoding: gzip)
}

export function getGallery(cursor?: string | null): Promise<{ items: GalleryItem[]; nextCursor: string | null }> {
  const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  return request(`/api/gallery${q}`);
}

export function getMyArtworks(cursor?: string | null): Promise<{ items: GalleryItem[]; nextCursor: string | null }> {
  const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  return request(`/api/users/me/artworks${q}`);
}

export function patchArtwork(id: string, patch: { title?: string; visibility?: string }): Promise<{ ok: boolean }> {
  return request(`/api/artworks/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export function deleteArtwork(id: string): Promise<{ ok: boolean }> {
  return request(`/api/artworks/${id}`, { method: "DELETE" });
}

export function likeArtwork(id: string): Promise<{ likes: number }> {
  return request(`/api/artworks/${id}/like`, { method: "POST" });
}

export { request as apiRequest };
