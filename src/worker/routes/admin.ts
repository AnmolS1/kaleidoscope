import { Hono } from "hono";
import type { AppEnv } from "../middleware";
import { requireAuth, requireCsrf } from "../middleware";
import {
  setUserAdminFlag,
  listArtworksMissingAlt,
  setArtworkAlt,
  listArtworksMissingHash,
  setArtworkHash,
} from "../lib/db";
import { templateAlt } from "../lib/alttext";
import { generateAlt } from "../lib/genalt";
import { validateDrawingJson } from "../lib/validate";
import { contentHash, hasVisibleLayers } from "../../shared/vector";

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

/** How many rows one call may touch. Bounded so a single request stays well
 *  inside the Worker's CPU budget — each row costs an R2 read, a gunzip, two
 *  parses and a SHA-256. */
const HASH_BATCH_MAX = 50;

/**
 * Admin-only: backfill `content_hash` + `layers` for pre-1.2 rows.
 *
 * Termination contract, and the one T20 follows: **call it repeatedly until
 * `processed` is 0**, then check that `SELECT COUNT(*) FROM artworks WHERE
 * content_hash IS NULL` is 0. `processed` counts rows this call actually wrote,
 * so it is the only honest stop signal — a `remaining`-style flag derived from
 * the scan size would never clear if a batch-worth of rows is permanently
 * unprocessable, and would tell the operator to poll forever.
 *
 * Idempotent by construction: the query only sees `content_hash IS NULL`, and
 * `setArtworkHash` only writes a row that is still NULL. A second run over a
 * converged table scans nothing and writes nothing.
 *
 * Per-row failures are collected, never thrown: one row with a missing blob (or
 * a legacy same-user duplicate the unique index refuses) must not strand the
 * other 49. Such rows keep `content_hash = NULL`, which is the correct state —
 * NULL means "no hash", and the remix block is simply off for that piece. A
 * WRONG hash would be far worse: it makes two different drawings look identical
 * and would block a legitimate save as `duplicate_of_other`.
 *
 * Skipped rows can in principle starve the batch (the query is ordered, so 50
 * stuck rows at the head hide everything behind them). That shows up as
 * `processed: 0` with a non-empty `skipped`, and the release step's NULL count
 * catches it — which is why the ids are returned rather than just a tally.
 */
admin.post("/backfill-hash", requireAuth, requireCsrf, async (c) => {
  if (c.get("user")!.role !== "admin") return c.json({ error: "forbidden" }, 403);
  const body = (await c.req.json().catch(() => ({}))) as { batch?: number };
  const batch = Math.min(HASH_BATCH_MAX, Math.max(1, Number(body.batch) || HASH_BATCH_MAX));

  const rows = await listArtworksMissingHash(c.env, batch);

  let processed = 0;
  // Reasons are `missing_blob` | `unreadable_blob` | `duplicate_or_already_set` |
  // `db_error`, or a validate.ts wire code (`bad_json`, `bad_version`, …). Kept
  // per row so the operator can tell "nothing left to do" from "these N rows
  // can never be done".
  const skipped: { id: string; reason: string }[] = [];

  for (const row of rows) {
    // The stored vector is gzipped and written as opaque bytes (see r2.ts), so
    // it has to be inflated before it is JSON at all. Hashing the compressed
    // bytes would produce a plausible-looking hash of the wrong thing.
    let json: string;
    try {
      const obj = await c.env.ART.get(row.vector_key);
      if (!obj) {
        skipped.push({ id: row.id, reason: "missing_blob" });
        continue;
      }
      json = await new Response(obj.body.pipeThrough(new DecompressionStream("gzip"))).text();
    } catch {
      skipped.push({ id: row.id, reason: "unreadable_blob" });
      continue;
    }

    // Same parse the save path uses, so `layers` is derived exactly as a fresh
    // save would derive it, and an unparseable legacy blob yields the same wire
    // code the API would have returned.
    const meta = validateDrawingJson(json);
    if (!meta.ok) {
      skipped.push({ id: row.id, reason: meta.error });
      continue;
    }

    // A row with nothing visible must STAY NULL — same rule the save path
    // applies. Backfilling it would give every blank piece the same hash and
    // hand the unique index a collision it would resolve by leaving all but one
    // of them NULL anyway, only after burning a write on each.
    if (!hasVisibleLayers(meta.drawing)) {
      skipped.push({ id: row.id, reason: "nothing_visible" });
      continue;
    }

    let hash: string;
    try {
      hash = await contentHash(json);
    } catch {
      skipped.push({ id: row.id, reason: "unreadable_blob" });
      continue;
    }

    try {
      // False covers both the legacy same-user duplicate the unique index
      // rejects and a row someone else hashed between the SELECT and here.
      // Neither is distinguishable without another read and neither is worth
      // one — both mean "left as NULL, move on".
      if (await setArtworkHash(c.env, row.id, hash, meta.layers)) processed++;
      else skipped.push({ id: row.id, reason: "duplicate_or_already_set" });
    } catch {
      skipped.push({ id: row.id, reason: "db_error" });
    }
  }

  return c.json({ scanned: rows.length, processed, skipped });
});
