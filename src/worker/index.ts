import { Hono } from "hono";
import type { AppEnv } from "./middleware";
import { loadAuth, requireAuth, requireCsrf } from "./middleware";
import { securityHeaders, originCheck } from "./security";
import { auth } from "./routes/auth";
import { artworks } from "./routes/artworks";
import { gallery } from "./routes/gallery";
import { admin } from "./routes/admin";
import { og } from "./routes/og";
import { permalink } from "./routes/permalink";
import { listArtworkIdsByUser, deleteUser, plusSources, countPublicSince } from "./lib/db";
import { deleteArtworkObjects, keys } from "./lib/r2";
import { destroySession } from "./lib/session";
import { capPolicy, envFlag, envInt } from "./lib/validate";
import type { SessionUser, PlusSource, Env } from "./types";

/** The Plus/cap block on /api/me. Parsed on web by T03 and on iOS by T13. */
interface PlusState {
  active: boolean;
  sources: PlusSource[];
  publicCount: number;
  publicCap: number | null;
  layerCap: number;
  enabled: boolean;
}

const freeLayerCap = (env: Env) => envInt(env.FREE_LAYER_CAP, 3);
const plusLayerCap = (env: Env) => envInt(env.PLUS_LAYER_CAP, 8);

// The Worker runs only for routes matched by `run_worker_first` (/api/*, /og/*);
// everything else is served from Workers Static Assets (SPA fallback) at the edge.
const app = new Hono<AppEnv>();

app.use("*", securityHeaders);
app.use("*", originCheck);
app.use("*", loadAuth);

app.get("/api/health", (c) => c.json({ ok: true }));

// Current user + CSRF token (the client replays the token on mutations).
//
// Since 1.2 this also carries the Plus/cap state, so the client never has to
// derive policy itself: `layerCap` is the number the layer UI enforces and
// `publicCount`/`publicCap` is what the save dialog and account menu display.
// The counter uses the SAME predicate as the conditional publish — if the two
// drift, the number shown stops describing the cap actually enforced.
app.get("/api/me", async (c) => {
  const user = c.get("user");
  const session = c.get("session");
  const out: SessionUser | null = user
    ? {
        id: user.id,
        name: user.name,
        avatar: user.avatar_url,
        role: user.role,
        flagged: !!user.flagged,
      }
    : null;

  const enabled = envFlag(c.env.PLUS_ENABLED);
  let plus: PlusState | null = null;
  if (user) {
    const sources = await plusSources(c.env, user.id);
    const active = sources.length > 0;
    const policy = capPolicy(c.env, active);
    if (!policy.ok) return c.json({ error: "server_misconfigured" }, 500);
    plus = {
      active,
      sources,
      // While Plus is dark there is no cap to report and everyone gets the full
      // layer count — shipping the restriction before the way to lift it would
      // just be taking a feature away.
      publicCount: policy.enforced ? await countPublicSince(c.env, user.id, policy.epoch) : 0,
      publicCap: policy.enforced ? policy.cap : null,
      layerCap: !enabled || active ? plusLayerCap(c.env) : freeLayerCap(c.env),
      enabled,
    };
  }

  return c.json({
    user: out,
    csrf: session?.data.csrf ?? null,
    turnstileSiteKey: c.env.TURNSTILE_SITE_KEY,
    plus,
  });
});

// Account deletion (App Store Guideline 5.1.1(v)). Removes the user's artwork
// blobs + avatar from R2, then the user row (artwork rows cascade via FK), then
// the current session. We deliberately do NOT try to enumerate the user's other
// KV sessions — KV isn't queryable by value, and deleting the user row already
// neuters every session (loadAuth → getUserById → null → logged out); any
// stragglers simply TTL-expire.
app.delete("/api/me", requireAuth, requireCsrf, async (c) => {
  const user = c.get("user")!;

  const ids = await listArtworkIdsByUser(c.env, user.id);
  for (const id of ids) await deleteArtworkObjects(c.env, id);
  await c.env.ART.delete(keys.avatar(user.id));

  await deleteUser(c.env, user.id); // cascades artwork rows

  const session = c.get("session");
  if (session) await destroySession(c, session.id);

  return c.json({ ok: true });
});

app.route("/api/auth", auth);
app.route("/api/artworks", artworks);
app.route("/api", gallery); // /api/gallery, /api/users/me/artworks
app.route("/api/admin", admin);
app.route("/og", og);
app.route("/", permalink); // /p/:id (OG injection) + /sitemap.xml

// Unknown API routes → JSON 404 (not the SPA shell).
app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));

export default app;
