import { Hono } from "hono";
import type { AppEnv } from "../middleware";
import { requireAuth, requireCsrf } from "../middleware";
import { setUserAdminFlag } from "../lib/db";

export const admin = new Hono<AppEnv>();

// Admin-only: set role/flagged for a user by google_sub. (Also doable via
// `wrangler d1 execute`.)
admin.post("/flag", requireAuth, requireCsrf, async (c) => {
  if (c.get("user")!.role !== "admin") return c.json({ error: "forbidden" }, 403);
  const body = (await c.req.json().catch(() => ({}))) as {
    google_sub?: string;
    role?: string;
    flagged?: number | boolean;
  };
  if (!body.google_sub) return c.json({ error: "missing_sub" }, 400);

  const role = body.role === "admin" || body.role === "user" ? body.role : undefined;
  const flagged =
    body.flagged === undefined ? undefined : body.flagged ? 1 : 0;

  await setUserAdminFlag(c.env, body.google_sub, { role, flagged });
  return c.json({ ok: true });
});
