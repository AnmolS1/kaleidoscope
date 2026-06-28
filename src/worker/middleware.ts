// Shared Hono app type + auth middleware. loadAuth runs globally and attaches
// the session/user; requireAuth and requireCsrf gate protected routes.

import { createMiddleware } from "hono/factory";
import type { Env, User } from "./types";
import { readSession, type ActiveSession } from "./lib/session";
import { getUserById } from "./lib/db";

export type AppEnv = {
  Bindings: Env;
  Variables: { session: ActiveSession | null; user: User | null };
};

export const loadAuth = createMiddleware<AppEnv>(async (c, next) => {
  const session = await readSession(c);
  let user: User | null = null;
  if (session) user = await getUserById(c.env, session.data.userId);
  // A dangling cookie (session expired/revoked) → treat as logged out.
  c.set("session", user ? session : null);
  c.set("user", user);
  await next();
});

export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.get("user")) return c.json({ error: "unauthorized" }, 401);
  await next();
});

export const requireCsrf = createMiddleware<AppEnv>(async (c, next) => {
  const session = c.get("session");
  const token = c.req.header("X-CSRF-Token");
  if (!session || !token || token !== session.data.csrf) {
    return c.json({ error: "bad_csrf" }, 403);
  }
  await next();
});
