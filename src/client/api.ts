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

export interface MeResponse {
  user: SessionUser | null;
  csrf?: string;
}

let csrfToken: string | null = null;

export function getCsrf(): string | null {
  return csrfToken;
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

export async function fetchMe(): Promise<SessionUser | null> {
  const data = await request<MeResponse>("/api/me");
  if (data.csrf) csrfToken = data.csrf;
  return data.user;
}

export function loginUrl(returnTo?: string): string {
  const u = new URL("/api/auth/login", location.origin);
  if (returnTo) u.searchParams.set("returnTo", returnTo);
  return u.toString();
}

export async function logout(): Promise<void> {
  await request<void>("/api/auth/logout", { method: "POST" });
}

export { request as apiRequest };
