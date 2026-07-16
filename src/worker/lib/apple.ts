// Sign in with Apple — native flow. The iOS app performs the Apple auth and
// sends us the resulting identity token (a JWT). We verify it against Apple's
// public JWKS (cached in KV), exactly like the Google id_token path in oauth.ts.
// No Apple secret/key is needed: native verification only checks Apple's public
// keys with aud == our bundle id.

import { jwtVerify, createLocalJWKSet, type JSONWebKeySet, type JWTPayload } from "jose";
import type { Env } from "../types";
import { sha256 } from "./ids";

const APPLE_ISS = "https://appleid.apple.com";
const APPLE_CERTS = "https://appleid.apple.com/auth/keys";
const JWKS_TTL = 6 * 3600; // 6h, mirrors the Google JWKS cache

async function getAppleJwks(env: Env): Promise<JSONWebKeySet> {
  const cached = await env.JWKS.get<JSONWebKeySet>("apple", "json");
  if (cached) return cached;
  const res = await fetch(APPLE_CERTS);
  if (!res.ok) throw new Error("apple jwks fetch failed");
  const jwks = (await res.json()) as JSONWebKeySet;
  await env.JWKS.put("apple", JSON.stringify(jwks), { expirationTtl: JWKS_TTL });
  return jwks;
}

/** Lowercase hex of SHA-256(input) — matches the digest the iOS app sets as the
 *  request nonce (Apple echoes that hashed value back in the token's nonce claim). */
async function sha256Hex(input: string): Promise<string> {
  const bytes = await sha256(input);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/** Truthy for both Apple's stringified booleans ("true") and real booleans. */
function asBool(v: unknown): boolean {
  return v === true || v === "true";
}

export interface AppleIdentity {
  sub: string;
  email?: string;
  email_verified?: boolean;
  is_private_email?: boolean;
}

interface AppleClaims extends JWTPayload {
  sub: string;
  email?: string;
  email_verified?: boolean | string;
  is_private_email?: boolean | string;
  nonce?: string;
}

/**
 * Verify an Apple identity token: signature (JWKS), issuer, audience (our bundle
 * id), expiry (via jose), and that the token's nonce equals SHA-256(rawNonce)
 * the app committed to. Throws on any failure.
 */
export async function verifyAppleIdentityToken(
  env: Env,
  identityToken: string,
  rawNonce: string,
): Promise<AppleIdentity> {
  const jwks = createLocalJWKSet(await getAppleJwks(env));
  const { payload } = await jwtVerify(identityToken, jwks, {
    issuer: APPLE_ISS,
    audience: env.APPLE_BUNDLE_ID,
  });
  const claims = payload as AppleClaims;

  const expected = await sha256Hex(rawNonce);
  if (!claims.nonce || claims.nonce !== expected) throw new Error("nonce mismatch");
  if (!claims.sub) throw new Error("missing sub");

  return {
    sub: claims.sub,
    email: claims.email,
    email_verified: asBool(claims.email_verified),
    is_private_email: asBool(claims.is_private_email),
  };
}
