import { Hono } from "hono";
import type { AppEnv } from "./middleware";
import { loadAuth } from "./middleware";
import { securityHeaders, originCheck } from "./security";
import { auth } from "./routes/auth";
import { artworks } from "./routes/artworks";
import { gallery } from "./routes/gallery";
import { admin } from "./routes/admin";
import { og } from "./routes/og";
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
  return c.json({ user: out, csrf: session?.data.csrf ?? null });
});

app.route("/api/auth", auth);
app.route("/api/artworks", artworks);
app.route("/api", gallery); // /api/gallery, /api/users/me/artworks
app.route("/api/admin", admin);
app.route("/og", og);

// Unknown API routes → JSON 404 (not the SPA shell).
app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));

export default app;
