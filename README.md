# Kaleidoscope

A symmetry drawing toy — scribble and watch it bloom into a mandala. Draw and
download for free with no account; sign in to save pieces to a hosted gallery,
get a shareable permalink, and remix others' work.

**Live:** https://kaleidoscope.ponderance.dev

## Stack

- **Frontend:** Preact + `@preact/signals` + TypeScript. The drawing engine is a
  pure-TS, framework-free module (`src/client/engine`) — unit-tested and shared
  by the live renderer and every exporter.
- **Drawing model:** a **vector stroke list** (normalized, resolution-independent
  coordinates), not pixels. This one decision gives undo/redo, infinite-res
  export, SVG, animated replay, remix, and tiny (KB-scale) saves for free — the
  PNG is just one render of the data.
- **Hosting:** a single **Cloudflare Worker** with **Workers Static Assets** (SPA
  at the edge) + a **Hono** API in the same Worker. `run_worker_first` routes
  `/api/*`, `/og/*`, `/p/*`, and `/sitemap.xml` to the Worker; everything else is
  served from the edge cache.
- **Auth:** Google OAuth 2.0 (Authorization Code + PKCE/S256) with id_token
  verification against Google's JWKS; **opaque, server-side sessions in KV** (the
  cookie is only a random id, never a JWT — instant revocation). CSRF
  double-submit + Origin allowlist.
- **Storage:** **D1** (users + artwork metadata), **R2** (gzipped vector JSON =
  source of truth, plus webp renders), **KV** (sessions, OAuth transient state,
  rate-limit counters, JWKS cache).
- **Abuse defense:** Cloudflare **Turnstile** on save + KV rate limits. No monthly
  cap; the `flagged`/`role` columns exist for future curation.

## Develop

```bash
npm install
npm run dev          # vite + worker in workerd (http://localhost:5173)
npm run typecheck    # tsc -b (project refs: client / worker / node)
npm run lint
npm test             # vitest unit tests
npm run test:e2e     # playwright (expects the dev server)
npm run build
npm run deploy       # vite build + wrangler deploy (generated config)
```

Local secrets live in `.dev.vars` (gitignored). For local OAuth it overrides
`PUBLIC_BASE_URL`/`GOOGLE_REDIRECT_URI` to `localhost:5173`, and sets
`ALLOW_TEST_LOGIN=true` to enable `POST /api/auth/test-login` (a dev/test-only
session bypass; **never** set in production).

## Capacity & cost

Comfortably handles far more than "a few hundred concurrent":

- The SPA (HTML/JS/CSS/fonts) is **static, served from Cloudflare's edge cache** →
  concurrency is effectively unbounded.
- **Drawing is 100% client-side** — zero server cost while someone draws. The
  Worker only runs on sign-in and save/gallery reads.
- A save is one Turnstile verify + a couple of KV/D1 writes + a few small R2 puts
  (a few KB of vector + small webp). Gallery reads are one indexed D1 query +
  edge-cached R2 images.
- Free tiers (Workers 100k req/day, D1, R2 10 GB, KV, Turnstile, Google OAuth)
  cover this comfortably; the $5/mo Workers Paid plan (10M req) is the only likely
  cost if it gets popular. Storage stays small because the source of truth is
  vector JSON, not big PNGs.

## Operational notes / handoffs

- **Turnstile** currently uses Cloudflare's always-pass **test keys** (the
  provisioning API token lacked the Turnstile scope). To enable real bot
  protection: create a Turnstile widget in the dashboard for
  `kaleidoscope.ponderance.dev`, then update `TURNSTILE_SITE_KEY` (var in
  `wrangler.jsonc`) and `wrangler secret put TURNSTILE_SECRET_KEY`.
- **Admin:** after first sign-in, grant yourself admin:
  `wrangler d1 execute kaleidoscope --remote --command "UPDATE users SET role='admin' WHERE email='you@example.com'"`.
- **Web Analytics:** cookieless; enable via Cloudflare dashboard automatic setup
  (the CSP already allows the beacon origins).

## Tests

- **Vitest** units: symmetry group math (`forEachImage` C_n/D_n), stroke
  normalize/serialize round-trips, SVG export correctness, validation caps.
- **Playwright** e2e: draw → download without login; mock sign-in (test-login) →
  save → permalink (with OG) → gallery → remix → delete.

`./old` is the original jQuery toy, kept untouched as a reference.
