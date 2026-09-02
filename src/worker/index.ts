import { Hono } from "hono";
import type { AppEnv } from "./middleware";
import { loadAuth, requireAuth, requireCsrf } from "./middleware";
import { securityHeaders, originCheck } from "./security";
import { auth } from "./routes/auth";
import { artworks } from "./routes/artworks";
import { gallery } from "./routes/gallery";
import { admin } from "./routes/admin";
import { billing } from "./routes/billing";
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
  /** Caps are ENFORCED (`PLUS_ENABLED`). Governs the layer cap and public cap. */
  enabled: boolean;
  /**
   * The Plus UI is VISIBLE (`PLUS_SURFACE_ENABLED`) — paywall, Restore, upsell.
   *
   * Separate from `enabled` because App Review has to be able to FIND the
   * purchase before the caps that motivate it are switched on. One flag meant
   * the reviewer saw no Plus row, no paywall, no Restore and no product, which
   * rejects the binary under Guideline 2.1, not just the IAP.
   */
  surface: boolean;
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
  // Assigned in both branches below — signed in and signed out each build
  // their own block (S18), so there is no "no plus" case left to default to.
  let plus: PlusState;
  if (user) {
    const sources = await plusSources(c.env, user.id);
    const active = sources.length > 0;
    const policy = capPolicy(c.env, active);
    if (!policy.ok) {
      // A malformed CAP_EPOCH or FREE_PUBLIC_CAP is a deploy error, and the cap
      // must fail CLOSED — but not here. This response carries the session and
      // the CSRF token, so answering 500 leaves the client unable to bootstrap
      // at all: no sign-in, no gallery, no saving, over a typo in a var that
      // governs only the public-post cap. The publish paths (POST /api/artworks
      // and PATCH → public) still 500, so nothing is published against a cap
      // nobody can compute; the rest of the app keeps working.
      //
      // Degrading to the same shape as PLUS_ENABLED=false is deliberate: that
      // is the shipped state until the IAP is approved, so it is known-good,
      // and it errs toward giving capability rather than removing it.
      //
      // Logged at error level because a silent degrade is how a config typo
      // survives a release — this is the only place it would otherwise surface.
      console.error(
        "cap policy misconfigured — /api/me degraded to plus-disabled; publishes still fail closed",
        { capEpoch: c.env.CAP_EPOCH, freePublicCap: c.env.FREE_PUBLIC_CAP },
      );
      const layers = plusLayerCap(c.env);
      plus = {
        active,
        sources,
        publicCount: 0,
        publicCap: null,
        // The surface survives a cap misconfiguration: it is governed by its own
        // flag and does not depend on CAP_EPOCH parsing. Hiding the paywall
        // because the cap is broken would take Restore down with it — and a user
        // who has already paid still needs to restore.
        surface: envFlag(c.env.PLUS_SURFACE_ENABLED),
        // PLUS_LAYER_CAP may be the malformed var; envInt hands back NaN for a
        // set-but-unparseable value, and NaN would serialize as null and break
        // the client's layer gate.
        layerCap: Number.isFinite(layers) ? layers : 8,
        enabled: false,
      };
      return c.json({
        user: out,
        csrf: session?.data.csrf ?? null,
        turnstileSiteKey: c.env.TURNSTILE_SITE_KEY,
        plus,
      });
    }
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
      surface: envFlag(c.env.PLUS_SURFACE_ENABLED),
    };
  } else {
    // SIGNED OUT still gets a plus block (REVIEW S18).
    //
    // The surface flag is a property of the DEPLOY, not of a user, and sending
    // nothing here made the whole Plus surface invisible to anyone signed out —
    // which is how `PlusSignIn` became an unreachable state and how Restore
    // ended up with no signed-out entry point at all. Someone who reinstalls
    // and has not signed in could not find "Restore purchase" anywhere, and
    // Apple expects restore to be reachable.
    //
    // Every USER-SPECIFIC field is the safe, empty answer, so nothing here can
    // grant anything: `active: false` means `owned()` stays false, `enabled:
    // false` means no cap is claimed, and both clients already resolve
    // "surface on, not signed in" to their sign-in state.
    plus = {
      active: false,
      sources: [],
      publicCount: 0,
      publicCap: null,
      layerCap: plusLayerCap(c.env),
      enabled: false,
      surface: envFlag(c.env.PLUS_SURFACE_ENABLED),
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
app.route("/api/billing", billing); // Plus: StoreKit, ASSN, LS webhook, checkout
app.route("/og", og);
app.route("/", permalink); // /p/:id (OG injection) + /sitemap.xml

// Unknown API routes → JSON 404 (not the SPA shell).
app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));

export default app;
