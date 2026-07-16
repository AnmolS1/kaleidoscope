import { Hono } from "hono";
import type { AppEnv } from "../middleware";
import { requireAuth, requireCsrf } from "../middleware";
import { setUserAdminFlag, listArtworksMissingAlt, setArtworkAlt } from "../lib/db";
import { templateAlt } from "../lib/alttext";
import { generateAlt } from "../lib/genalt";

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

// Admin-only: backfill alt text for legacy artworks (alt_text IS NULL). Fills the
// deterministic template value for a batch immediately, then opportunistically
// upgrades a small sub-batch with the AI vision model. Idempotent — rows already
// carrying alt text are skipped by the query, so it's safe to call repeatedly
// (poll until `remaining` is false). Counts are returned so a caller can drive it.
admin.post("/backfill-alt", requireAuth, requireCsrf, async (c) => {
  if (c.get("user")!.role !== "admin") return c.json({ error: "forbidden" }, 403);
  const body = (await c.req.json().catch(() => ({}))) as { batch?: number; ai?: number };
  const batch = Math.min(100, Math.max(1, Number(body.batch) || 25));
  const aiBudget = body.ai === undefined ? 5 : Math.min(batch, Math.max(0, Number(body.ai) || 0));

  const rows = await listArtworksMissingAlt(c.env, batch);

  // 1. Guarantee every scanned row is non-null via the template value.
  for (const row of rows) {
    await setArtworkAlt(c.env, row.id, templateAlt(row));
  }

  // 2. Opportunistic AI upgrade for a bounded sub-batch (best-effort, per-row safe).
  let upgraded = 0;
  for (const row of rows.slice(0, aiBudget)) {
    try {
      const obj = await c.env.ART.get(row.image_key);
      if (!obj) continue;
      const bytes = await obj.arrayBuffer();
      if (await generateAlt(c.env, row.id, bytes, row)) upgraded++;
    } catch {
      /* leave the template value in place */
    }
  }

  return c.json({
    scanned: rows.length,
    templated: rows.length,
    upgraded,
    remaining: rows.length === batch,
  });
});
