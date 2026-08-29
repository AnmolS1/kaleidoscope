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
    /**
     * The parsed error body, when there was one.
     *
     * The cap responses carry numbers the UI has to print — `402 {cap, count}`
     * on PATCH, `409 {of}` on POST — and a bare code cannot say "10 of 10" or
     * link to the twin. Throwing the code alone forced every caller to re-read
     * a body that had already been consumed.
     */
    public data: Record<string, unknown> = {},
    message?: string,
  ) {
    super(message ?? code);
  }
}

/** Capabilities this client announces. `v2` = layers + a real title field. */
const CLIENT_CAPS = "v2";

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const method = (init.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    headers.set("Content-Type", headers.get("Content-Type") ?? "application/json");
    if (csrfToken) headers.set("X-CSRF-Token", csrfToken);
    // Announce the title field. The worker rejects an empty or "Untitled" title
    // ONLY for clients that send this, because a shipped iOS 1.1 has no field to
    // type into and rejecting its saves would break the app in the store.
    headers.set("X-Client-Caps", CLIENT_CAPS);
  }
  const res = await fetch(path, { ...init, headers, credentials: "same-origin" });
  if (!res.ok) {
    let code = "error";
    let data: Record<string, unknown> = {};
    try {
      data = (await res.json()) as Record<string, unknown>;
      if (typeof data.error === "string") code = data.error;
    } catch {
      /* non-json */
    }
    throw new ApiError(res.status, code, data);
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

/**
 * What the create endpoint can answer with. Three shapes, one 200/201 status
 * family, and the client renders a different dialog state for each:
 *
 * - `deduped` (200): the same user already has this exact picture. Nothing was
 *   written — re-saving is not an edit and never flips the existing visibility.
 * - `capReached` (201): the piece IS saved, as unlisted, because the public wall
 *   was full. `cap`/`count` are the numbers the cap copy prints.
 * - plain 201: saved as `visibility`.
 */
export interface SaveResult {
  id: string;
  url: string;
  deduped?: boolean;
  visibility?: "public" | "unlisted" | "private";
  capReached?: boolean;
  cap?: number;
  count?: number;
}

export async function saveArtwork(input: SaveInput): Promise<SaveResult> {
  const fd = new FormData();
  fd.set("drawing", input.drawingJson);
  fd.set("image", input.image, "image.webp");
  fd.set("thumb", input.thumb, "thumb.webp");
  fd.set("og", input.og, "og.webp");
  fd.set("title", input.title);
  fd.set("visibility", input.visibility);
  fd.set("turnstile", input.turnstileToken);
  if (input.remixOf) fd.set("remixOf", input.remixOf);

  // Hand-rolled rather than routed through `request`, because the body is
  // FormData: setting Content-Type would clobber the multipart boundary.
  const headers = new Headers();
  if (csrfToken) headers.set("X-CSRF-Token", csrfToken);
  headers.set("X-Client-Caps", CLIENT_CAPS);
  const res = await fetch("/api/artworks", {
    method: "POST",
    body: fd,
    headers,
    credentials: "same-origin",
  });
  if (!res.ok) {
    let code = "error";
    let data: Record<string, unknown> = {};
    try {
      data = (await res.json()) as Record<string, unknown>;
      if (typeof data.error === "string") code = data.error;
    } catch {
      /* */
    }
    // `409 duplicate_of_other` comes in TWO shapes and they are different
    // states: with `of` there is a viewable twin to name and link; without it,
    // someone else holds this drawing privately and there is nothing to show
    // but the refusal. `data` is what lets the dialog tell them apart.
    throw new ApiError(res.status, code, data);
  }
  return (await res.json()) as SaveResult;
}

// ---- save pre-flight ----

/**
 * Does this exact picture already exist?
 *
 * Asked the moment the save dialog opens, so "you already saved this" or
 * "someone else has this drawing" is on screen before the user types a title.
 * `other` is omitted for a private match — deliberately, since naming it would
 * leak both its existence and its title — so a private twin is invisible here
 * and only surfaces as a bare `409` on the POST.
 */
export interface HashLookup {
  mine: string | null;
  other: { id: string; title: string; author: string | null } | null;
}

export function hashLookup(sha: string): Promise<HashLookup> {
  return request<HashLookup>(`/api/artworks/hash/${sha}`);
}

// ---- AI name suggestions ----

export interface SuggestInput {
  thumb: Blob;
  /** topSym's segments, or 0 when the visible layers disagree ("layered"). */
  segments: number;
  mirror: boolean;
  palette: string[];
}

/**
 * Title suggestions for the save dialog's chips.
 *
 * Never throws: naming is a convenience and the endpoint answers `{names: []}`
 * for every internal failure, so a transport failure has to degrade the same
 * way or a dead AI binding would block saving.
 */
export async function suggestNames(input: SuggestInput): Promise<string[]> {
  const fd = new FormData();
  fd.set("thumb", input.thumb, "thumb.webp");
  fd.set("segments", String(input.segments));
  fd.set("mirror", input.mirror ? "1" : "0");
  fd.set("palette", input.palette.join(","));

  const headers = new Headers();
  if (csrfToken) headers.set("X-CSRF-Token", csrfToken);
  headers.set("X-Client-Caps", CLIENT_CAPS);
  try {
    const res = await fetch("/api/artworks/suggest-names", {
      method: "POST",
      body: fd,
      headers,
      credentials: "same-origin",
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { names?: unknown };
    return Array.isArray(body.names)
      ? body.names.filter((n): n is string => typeof n === "string").slice(0, 3)
      : [];
  } catch {
    return [];
  }
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
