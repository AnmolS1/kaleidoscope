import { Hono } from "hono";
import type { Env } from "./types";

// The Worker only runs for routes matched by `run_worker_first` in wrangler.jsonc
// (`/api/*` and `/og/*`). Everything else is served from Workers Static Assets at
// the edge, with SPA fallback to index.html. Routes are fleshed out in Phase 5.
const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ ok: true }));

// Unknown API routes return JSON 404 (not the SPA shell).
app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));
app.all("/og/*", (c) => c.text("not found", 404));

export default app;
