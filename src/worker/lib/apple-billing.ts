// App Store JWS verification for Kaleidoscope Plus (PLAN §2.3, billing rows).
//
// Ported from ~/GitHub/calque `src/worker/apple/verify.ts`, which is proven on
// workerd. Two things are deliberately kept from that implementation and are the
// whole security story:
//
//  1. The trust anchor is PINNED and never fetched. A network-fetched root is
//     not an anchor.
//  2. A valid Apple signature proves "some App Store app", not "Kaleidoscope".
//     Binding to our bundle id + product id is a SEPARATE check and it is the
//     one that stops another developer's genuinely-signed transaction from
//     minting Plus here.
//
// reflect-metadata must load before @peculiar/x509 (its tsyringe DI needs it).
import "reflect-metadata";
import { compactVerify } from "jose";
import * as x509 from "@peculiar/x509";
import type { Env } from "../types";
import { envFlag } from "./validate";

x509.cryptoProvider.set(crypto as Crypto);

/**
 * SHA-256 thumbprint (over the DER) of **Apple Root CA - G3**, the trust anchor
 * for App Store JWS signing. Source: apple.com/certificateauthority/
 * (AppleRootCA-G3.cer), self-signed, valid 2014-2039.
 *
 * PLAN §2.3 says "embed the cert"; pinning its SHA-256 is the same control over
 * the same bytes — the fingerprint identifies exactly one certificate — while
 * being far cheaper to audit than a base64 blob nobody will ever re-derive.
 * An internally-consistent x5c chain that does NOT terminate in this exact root
 * is an attacker forgery and is rejected.
 */
export const APPLE_ROOT_CA_G3_SHA256 =
  "63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c756f3017b3a8c488c3653e9179";

// Apple App Store marker OIDs (from apple/app-store-server-library ChainVerifier,
// cross-checked Node + Python). The leaf must be an App Store JWS/receipt-signing
// cert and the intermediate must be Apple WWDR — "chains to G3" is NOT enough, or
// any Apple-issued end-entity cert could sign forged transactions.
/**
 * The most certificates an `x5c` may contain before we refuse to parse it.
 *
 * Apple sends three (leaf → WWDR intermediate → root). The ceiling exists
 * because parsing happens before the signature is verified, on a route with no
 * other credential, so an oversized chain is free CPU for whoever sends it.
 */
const MAX_CHAIN_CERTS = 5;

const APPLE_LEAF_MARKER_OID = "1.2.840.113635.100.6.11.1";
const APPLE_WWDR_INTERMEDIATE_OID = "1.2.840.113635.100.6.2.1";

export interface VerifyAppleJwsOptions {
  /**
   * Trust anchor: expected root-cert SHA-256 fingerprint (hex, no colons).
   * Defaults to Apple Root CA G3. Overridden only in tests (to a test CA);
   * production always pins G3.
   */
  anchorFingerprint?: string;
}

/**
 * Verify an Apple App Store JWS and return its decoded JSON payload, or throw.
 *
 * Validates the full x5c certificate chain (leaf → intermediate → root):
 *  1. the root (last cert) is pinned by SHA-256 to Apple Root CA G3;
 *  2. every link is signed by the next cert up, and each issuer asserts Basic
 *     Constraints cA=TRUE (RFC 5280 path validation);
 *  3. the leaf carries the App Store receipt-signing marker OID and the
 *     intermediate carries the Apple WWDR marker OID;
 *  4. the JWS signature verifies against the leaf's public key, restricted to
 *     ES256 (no algorithm substitution);
 *  5. every cert is within its validity window at the payload's signedDate.
 *
 * Any failure throws (fail-closed) — no entitlement is ever granted on a JWS we
 * cannot fully trust to Apple's root.
 */
export async function verifyAppleJws(
  jws: string,
  opts: VerifyAppleJwsOptions = {},
): Promise<Record<string, unknown>> {
  const anchor = (opts.anchorFingerprint ?? APPLE_ROOT_CA_G3_SHA256).toLowerCase();

  const parts = jws.split(".");
  if (parts.length !== 3) throw new Error("malformed_jws");

  const header = decodeSegment(parts[0]!);
  const x5c: unknown[] = Array.isArray(header.x5c) ? header.x5c : [];
  // A real Apple chain is leaf + intermediate + root. A single cert (e.g. a
  // self-signed leaf) is never a trustworthy chain, even if its own fingerprint
  // were pinned — reject on length before anything else.
  if (x5c.length < 2 || !x5c.every((c): c is string => typeof c === "string")) {
    throw new Error("apple_chain_too_short");
  }
  // CAP THE CHAIN BEFORE PARSING ANY OF IT (S1).
  //
  // The route is unauthenticated by design — the signature IS the credential —
  // so the work done before that signature is checked is reachable by anyone.
  // Every cert in x5c was parsed up front, and X.509 parsing is not cheap:
  // measured 2 certs → 50ms, 3000 → 783ms, linear. A real Apple chain is
  // leaf + intermediate + root; five is already generous for a future
  // cross-signed anchor, and nothing legitimate approaches it.
  if (x5c.length > MAX_CHAIN_CERTS) throw new Error("apple_chain_too_long");
  const certs = x5c.map((b64) => new x509.X509Certificate(b64));

  // 1) Pin the anchor: the root (last cert) must be Apple Root CA G3.
  const root = certs[certs.length - 1]!;
  if (toHex(await root.getThumbprint("SHA-256")) !== anchor) {
    throw new Error("apple_untrusted_root");
  }
  // The root must be self-signed (a self-issued anchor).
  if (!(await root.verify({ publicKey: await root.publicKey.export(), signatureOnly: true }))) {
    throw new Error("apple_root_not_self_signed");
  }

  // 2) Verify each chain link: certs[i] is signed by certs[i+1], and every
  // issuer asserts Basic Constraints cA=TRUE. The cA check is mandatory RFC 5280
  // path validation: without it, any end-entity cert that merely chains to
  // Apple's root (e.g. an ordinary Apple developer cert under WWDR→G3) could be
  // used to sign a forged leaf and forge transactions.
  for (let i = 0; i < certs.length - 1; i++) {
    const issuer = certs[i + 1]!;
    const bc = issuer.getExtension(x509.BasicConstraintsExtension);
    if (!bc || bc.ca !== true) throw new Error("apple_issuer_not_ca");
    const issuerKey = await issuer.publicKey.export();
    if (!(await certs[i]!.verify({ publicKey: issuerKey, signatureOnly: true }))) {
      throw new Error("apple_broken_chain_link");
    }
  }

  // 3) Assert Apple's identity markers: the leaf is an App Store receipt-signing
  // cert and the intermediate is Apple WWDR. Blocks using a real Apple end-entity
  // cert (dev/distribution) directly as the leaf to sign forged transactions.
  if (!certHasOid(certs[0]!, APPLE_LEAF_MARKER_OID)) {
    throw new Error("apple_leaf_not_receipt_signing");
  }
  if (!certHasOid(certs[1]!, APPLE_WWDR_INTERMEDIATE_OID)) {
    throw new Error("apple_intermediate_not_wwdr");
  }

  // 4) Verify the JWS signature with the (now-trusted) leaf public key, pinned
  // to ES256 so a forged header can't downgrade/substitute the algorithm.
  const leafKey = await certs[0]!.publicKey.export();
  const { payload: bytes } = await compactVerify(jws, leafKey, { algorithms: ["ES256"] });
  const payload = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;

  // 5) Every cert must be valid at the payload's signedDate (Apple's rule).
  const signedDate =
    typeof payload.signedDate === "number" ? new Date(payload.signedDate) : new Date();
  for (const cert of certs) {
    if (signedDate < cert.notBefore || signedDate > cert.notAfter) {
      throw new Error("apple_cert_expired_at_signed_date");
    }
  }

  return payload;
}

function certHasOid(cert: x509.X509Certificate, oid: string): boolean {
  return cert.extensions.some((e) => e.type === oid);
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function decodeSegment(seg: string): Record<string, unknown> {
  const b64 = seg.replace(/-/g, "+").replace(/_/g, "/");
  const json = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
  return JSON.parse(json) as Record<string, unknown>;
}

// ---- binding a verified transaction to Kaleidoscope Plus -------------------

/** The App Store transaction fields we act on. */
export interface AppleTransactionInfo {
  originalTransactionId?: unknown;
  /** The app the transaction belongs to. Apple signs every app's JWS with the
   *  same chain, so this must be checked against our bundle id. */
  bundleId?: unknown;
  productId?: unknown;
  /** "Production" | "Sandbox". */
  environment?: unknown;
  /** "PURCHASED" | "FAMILY_SHARED" — Family Sharing is off for this product,
   *  but a shared transaction would still verify, so reject it explicitly. */
  inAppOwnershipType?: unknown;
  /** The app sets appAccountToken = our user id at purchase time. */
  appAccountToken?: unknown;
  /** ms epoch; present means Apple took the purchase back. */
  revocationDate?: unknown;
}

export type TransactionCheck =
  | { ok: true; originalTransactionId: string; environment: string }
  | { ok: false; reason: string };

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/**
 * Decide whether a VERIFIED transaction grants Plus to `userId`.
 *
 * Split out from `verifyAppleJws` on purpose: signature validity and product
 * attribution are different failures. The signature says "Apple really signed
 * this"; everything here says "…and it is OUR app, OUR product, and THIS user".
 *
 * `allowSandbox` is the review-window switch (§2.3): App Review purchases run in
 * Sandbox, so during review either `PLUS_ALLOW_SANDBOX=true` or an admin account
 * is how a Sandbox receipt is accepted. It defaults to false, so the production
 * gate is what happens when nobody configures anything.
 */
export function checkTransaction(
  tx: AppleTransactionInfo,
  o: { bundleId: string; productId: string; userId: string; allowSandbox: boolean },
): TransactionCheck {
  const originalTransactionId = str(tx.originalTransactionId);
  if (!originalTransactionId) return { ok: false, reason: "missing_transaction_id" };

  // Bind to Kaleidoscope. A valid Apple signature only proves "some App Store
  // app" — without these two checks any developer's signed transaction is a
  // free Plus grant here.
  if (str(tx.bundleId) !== o.bundleId) return { ok: false, reason: "wrong_bundle" };
  if (str(tx.productId) !== o.productId) return { ok: false, reason: "wrong_product" };

  // The environment must be one Apple actually issues, not merely
  // "not Production" (minor). `allowSandbox` used to accept ANY other string —
  // including an empty one, or a value an attacker chose — so a transaction
  // with a missing or invented environment sailed through the review-window
  // switch. Apple emits "Production", "Sandbox", and "Xcode" for a local
  // StoreKit test session.
  const environment = str(tx.environment) ?? "";
  const ALLOWED_NON_PRODUCTION = new Set(["Sandbox", "Xcode"]);
  if (environment !== "Production") {
    if (!o.allowSandbox || !ALLOWED_NON_PRODUCTION.has(environment)) {
      return { ok: false, reason: "wrong_environment" };
    }
  }

  if (str(tx.inAppOwnershipType) !== "PURCHASED") {
    return { ok: false, reason: "not_purchased" };
  }
  // Any revocationDate at all — Apple only sets it when the purchase is gone.
  if (tx.revocationDate !== undefined && tx.revocationDate !== null) {
    return { ok: false, reason: "revoked" };
  }
  // The app stamps our user id into appAccountToken at purchase time. Without
  // this, a captured JWS could be replayed by a different signed-in user.
  //
  // Compared case-INSENSITIVELY, which is not sloppiness. `newUserId()` is
  // `crypto.randomUUID()`, so our ids are lowercase UUIDs, but StoreKit's
  // `appAccountToken` is a Swift `UUID` and `UUID.uuidString` is UPPERCASE.
  // Exact equality would therefore reject every real purchase with
  // `wrong_account` — a paid-but-not-granted failure that no test using the
  // same string on both sides can see. Case carries no meaning in a UUID.
  const token = str(tx.appAccountToken);
  if (!token || token.toLowerCase() !== o.userId.toLowerCase()) {
    return { ok: false, reason: "wrong_account" };
  }

  return { ok: true, originalTransactionId, environment };
}

/** Whether this env accepts Sandbox transactions for a user with this role. */
export function sandboxAllowed(env: Env, role: string | undefined): boolean {
  return envFlag(env.PLUS_ALLOW_SANDBOX) || role === "admin";
}
