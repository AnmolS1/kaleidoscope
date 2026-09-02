// Shared Worker types and Env bindings. Bindings marked optional are added in
// Phase 4 (provisioning); the minimal static-deploy build does not require them.

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  ART: R2Bucket;
  SESSIONS: KVNamespace;
  OAUTH: KVNamespace;
  RATELIMIT: KVNamespace;
  JWKS: KVNamespace;
  AI: Ai; // Workers AI binding (name suggestions)
  GOOGLE_CLIENT_ID: string; // secret
  GOOGLE_CLIENT_SECRET: string; // secret
  SESSION_SECRET: string; // secret
  TURNSTILE_SECRET_KEY: string; // secret
  PUBLIC_BASE_URL: string; // var
  GOOGLE_REDIRECT_URI: string; // var
  TURNSTILE_SITE_KEY: string; // var (public)
  APPLE_BUNDLE_ID: string; // var — audience for native Sign in with Apple tokens
  // Dev/test only: enables /api/auth/test-login. NEVER set in production secrets/vars.
  ALLOW_TEST_LOGIN?: string;

  // ---- 1.2: Plus + the free public-post cap --------------------------------
  //
  // Every one of these is declared in wrangler.jsonc, NOT the dashboard: a
  // deploy wipes dashboard vars, so a var that only lives there disappears the
  // next time we ship and the feature silently changes behavior.
  //
  // All typed `string` even where the value reads as a number or a boolean.
  // wrangler.jsonc's `vars` preserves JSON types, so writing `false` there would
  // hand the runtime a real boolean while `"false"` hands it a string — and
  // `x === "true"` fails silently against the former. Strings in the config,
  // strings in the type, and one coercion helper (`envFlag`/`envInt`) that is
  // tolerant of both.

  /** Epoch (ms) the free public cap counts from. Parsed with Number.parseInt;
   *  NaN is a 500, never an accidentally-unlimited or accidentally-zero cap. */
  CAP_EPOCH?: string;
  FREE_PUBLIC_CAP?: string; // "10"
  FREE_LAYER_CAP?: string; // "3"
  PLUS_LAYER_CAP?: string; // "8"
  /** Master switch. While false there is NO cap anywhere — shipping a cap with
   *  no way to pay to lift it would just be a broken product. */
  PLUS_ENABLED?: string;
  PLUS_ALLOW_SANDBOX?: string; // accept StoreKit Sandbox receipts (review window)
  PLUS_ALLOW_TEST?: string; // accept Lemon Squeezy test-mode webhooks
  PLUS_PRODUCT_ID?: string; // "dev.ponderance.kaleidoscope.plus"
  LS_STORE_ID?: string; // store SLUG (subdomain), e.g. "kaleidoscope-plus"
  LS_CHECKOUT_ID?: string; // UUID from the Share modal — used in the checkout URL
  LS_VARIANT_ID?: string; // NUMERIC variant id — used to verify the webhook
  LS_WEBHOOK_SECRET?: string; // secret
  LS_API_KEY?: string; // secret
}

/** Where a Plus entitlement came from. */
export type PlusSource = "apple" | "lemonsqueezy" | "comp";

export interface Entitlement {
  source: PlusSource;
  external_id: string;
  user_id: string | null;
  product: string;
  environment: string | null;
  granted_at: number;
}

export type Visibility = "public" | "unlisted" | "private";
export type Role = "user" | "admin";

export interface User {
  id: string;
  google_sub: string | null; // nullable since Apple-only users have no Google identity
  apple_sub: string | null;
  email: string | null;
  name: string | null;
  avatar_url: string | null;
  role: Role;
  flagged: number;
  created_at: number;
  last_seen_at: number;
}

export interface Artwork {
  id: string;
  user_id: string;
  title: string;
  visibility: Visibility;
  image_key: string;
  thumb_key: string;
  vector_key: string;
  width: number;
  height: number;
  segments: number;
  mirror: number;
  palette: string | null;
  remix_of: string | null;
  likes: number;
  created_at: number;
  alt_text: string | null;
  /** sha256 of the render-equivalent projection. NULL on legacy rows until the
   *  T02c backfill runs — the remix block is simply off for those. */
  content_hash: string | null;
  layers: number;
  updated_at: number | null;
  /** First time this piece went public; kept when it is later unpublished. */
  published_at: number | null;
}

// Public-facing user shape returned by /api/me.
export interface SessionUser {
  id: string;
  name: string | null;
  avatar: string | null;
  role: Role;
  flagged: boolean;
}
