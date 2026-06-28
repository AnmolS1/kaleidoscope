// Opaque, server-side sessions in KV. The cookie holds only a 256-bit random id
// (never a JWT), so sessions revoke instantly on logout. See spec §8.

import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Env } from "../types";
import type { AppEnv } from "../middleware";
import { randomToken } from "./ids";

// Type-only import of AppEnv (erased at runtime), so no import cycle with
// middleware.ts which imports readSession at runtime.
type Ctx = Context<AppEnv>;

const COOKIE_NAME = "kld_session"; // emitted as __Host-kld_session via the 'host' prefix
const TTL_SECONDS = 30 * 24 * 3600; // 30 days
const REFRESH_AFTER_MS = 24 * 3600 * 1000; // slide the window at most ~daily

export interface SessionData {
  userId: string;
  csrf: string;
  createdAt: number;
}

export async function createSession(env: Env, userId: string): Promise<{ id: string; csrf: string }> {
  const id = randomToken(32);
  const csrf = randomToken(32);
  const data: SessionData = { userId, csrf, createdAt: Date.now() };
  await env.SESSIONS.put(id, JSON.stringify(data), { expirationTtl: TTL_SECONDS });
  return { id, csrf };
}

export interface ActiveSession {
  id: string;
  data: SessionData;
}

export async function readSession(c: Ctx): Promise<ActiveSession | null> {
  const id = getCookie(c, COOKIE_NAME, "host");
  if (!id) return null;
  const data = await c.env.SESSIONS.get<SessionData>(id, "json");
  if (!data) return null;

  // Rolling refresh: slide the TTL window occasionally.
  if (Date.now() - data.createdAt > REFRESH_AFTER_MS) {
    await c.env.SESSIONS.put(id, JSON.stringify({ ...data, createdAt: Date.now() }), {
      expirationTtl: TTL_SECONDS,
    });
  }
  return { id, data };
}

export function writeSessionCookie(c: Ctx, id: string): void {
  setCookie(c, COOKIE_NAME, id, {
    prefix: "host", // __Host- : Secure + Path=/ + no Domain, enforced by the helper
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: TTL_SECONDS,
  });
}

export async function destroySession(c: Ctx, id: string): Promise<void> {
  await c.env.SESSIONS.delete(id);
  deleteCookie(c, COOKIE_NAME, { prefix: "host", path: "/", secure: true });
}
