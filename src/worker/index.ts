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
import { listArtworkIdsByUser, deleteUser } from "./lib/db";
import { deleteArtworkObjects, keys } from "./lib/r2";
import { destroySession } from "./lib/session";
import type { SessionUser } from "./types";

// The Worker runs only for routes matched by `run_worker_first` (/api/*, /og/*);
// everything else is served from Workers Static Assets (SPA fallback) at the edge.
const app = new Hono<AppEnv>();

app.use("*", securityHeaders);
app.use("*", originCheck);
app.use("*", loadAuth);

app.get("/api/health", (c) => c.json({ ok: true }));

// Current user + CSRF token (the client replays the token on mutations).
app.get("/api/me", (c) => {
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
  return c.json({
    user: out,
    csrf: session?.data.csrf ?? null,
    turnstileSiteKey: c.env.TURNSTILE_SITE_KEY,
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
