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
}

// Public-facing user shape returned by /api/me.
export interface SessionUser {
  id: string;
  name: string | null;
  avatar: string | null;
  role: Role;
  flagged: boolean;
}
