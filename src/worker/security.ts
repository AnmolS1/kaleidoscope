// Security headers for Worker-served responses (/api, /og). Static assets get the
// same headers via public/_headers. Kept in sync with that file. See spec §8.

import { createMiddleware } from "hono/factory";
import type { Env } from "./types";

const CSP =
  "default-src 'self'; base-uri 'none'; object-src 'none'; " +
  "img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; " +
  "script-src 'self' https://challenges.cloudflare.com https://static.cloudflareinsights.com; " +
  "frame-src https://challenges.cloudflare.com; " +
  "connect-src 'self' https://challenges.cloudflare.com https://cloudflareinsights.com; " +
  "form-action 'self'";

export const securityHeaders = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  await next();
  const h = c.res.headers;
  h.set("Content-Security-Policy", CSP);
  h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  h.set("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  h.set("X-Frame-Options", "DENY");
});

/** Reject cross-origin state-changing requests by Origin allowlist. */
export const originCheck = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const method = c.req.method;
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();
  const origin = c.req.header("Origin");
  if (origin) {
    const allowed = new URL(c.env.PUBLIC_BASE_URL).origin;
    let reqOrigin: string;
    try {
      reqOrigin = new URL(origin).origin;
    } catch {
      return c.json({ error: "bad_origin" }, 403);
    }
    // allow prod origin and localhost dev origins
    if (reqOrigin !== allowed && !reqOrigin.startsWith("http://localhost")) {
      return c.json({ error: "bad_origin" }, 403);
    }
  }
  return next();
});
