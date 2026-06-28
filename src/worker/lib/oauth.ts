// Google OAuth 2.0 — Authorization Code + PKCE (S256), with id_token signature
// verification against Google's JWKS (cached in KV). See spec §8.

import { jwtVerify, createLocalJWKSet, type JSONWebKeySet, type JWTPayload } from "jose";
import type { Env } from "../types";
import { base64url, randomToken, sha256 } from "./ids";

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_CERTS = "https://www.googleapis.com/oauth2/v3/certs";
const JWKS_TTL = 6 * 3600; // 6h

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export async function createPkce(): Promise<PkcePair> {
  const verifier = randomToken(48);
  const challenge = base64url(await sha256(verifier));
  return { verifier, challenge };
}

export function buildAuthUrl(
  env: Env,
  params: { state: string; nonce: string; challenge: string },
): string {
  const u = new URL(GOOGLE_AUTH);
  u.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: env.GOOGLE_REDIRECT_URI,
    response_type: "code",
    scope: "openid email profile",
    state: params.state,
    nonce: params.nonce,
    code_challenge: params.challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  return u.toString();
}

interface TokenResponse {
  id_token: string;
  access_token?: string;
  expires_in?: number;
}

export async function exchangeCode(env: Env, code: string, verifier: string): Promise<TokenResponse> {
  const res = await fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: env.GOOGLE_REDIRECT_URI,
      grant_type: "authorization_code",
      code_verifier: verifier,
    }),
  });
  if (!res.ok) {
    throw new Error(`token exchange failed: ${res.status}`);
  }
  return (await res.json()) as TokenResponse;
}

async function getJwks(env: Env): Promise<JSONWebKeySet> {
  const cached = await env.JWKS.get<JSONWebKeySet>("google", "json");
  if (cached) return cached;
  const res = await fetch(GOOGLE_CERTS);
  if (!res.ok) throw new Error("jwks fetch failed");
  const jwks = (await res.json()) as JSONWebKeySet;
  await env.JWKS.put("google", JSON.stringify(jwks), { expirationTtl: JWKS_TTL });
  return jwks;
}

export interface IdTokenClaims extends JWTPayload {
  sub: string;
  email?: string;
  name?: string;
  picture?: string;
  email_verified?: boolean;
}

/**
 * Verify an id_token: signature (JWKS), issuer, audience, expiry (via jose), and
 * the nonce we issued. Throws on any failure.
 */
export async function verifyIdToken(env: Env, idToken: string, nonce: string): Promise<IdTokenClaims> {
  const jwks = createLocalJWKSet(await getJwks(env));
  const { payload } = await jwtVerify(idToken, jwks, {
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: env.GOOGLE_CLIENT_ID,
  });
  if (payload.nonce !== nonce) throw new Error("nonce mismatch");
  if (!payload.sub) throw new Error("missing sub");
  return payload as IdTokenClaims;
}
