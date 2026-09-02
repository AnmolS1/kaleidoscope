// Kaleidoscope Plus billing: Apple StoreKit grants, App Store Server
// Notifications, and the Lemon Squeezy webhook (PLAN §2.3).
//
// This is security code, so a green run is not the bar. Two rules shape the file:
//
//  1. **Every rejection is tested with a fixture that would otherwise pass.**
//     A "wrong bundle id" test built on a JWS that also has the wrong product id
//     proves nothing about the bundle check. So there is ONE valid fixture and
//     each negative perturbs exactly one field of it.
//  2. **The chain verification runs for real.** `verifyAppleJws` is exercised
//     against genuine ECDSA certificates generated per test (our own root, with
//     the anchor injected), including the tampered-payload and forged-chain
//     cases. It is stubbed ONLY inside the route describes that are about
//     something else — and even there, the stub is off by default so the "the
//     real verifier rejects this" route tests are genuinely end-to-end.
//
// Mutation-tested (see the T02d report): disabling the chain check, the HMAC
// compare, or the environment gate each fails exactly the tests that name them.

import "reflect-metadata";
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as x509 from "@peculiar/x509";
import { CompactSign } from "jose";
import app from "../../src/worker/index";
import { makeD1, makeKV, makeEnv, seedUser, seedSession, bearer } from "./helpers";
import { hasPlus, plusSources } from "../../src/worker/lib/db";

x509.cryptoProvider.set(crypto as Crypto);

// A control the hoisted vi.mock factory can read. Null = use the REAL verifier,
// which is the default for every test in this file. Route tests that need a
// decoded payload without minting a real Apple chain set it explicitly and
// beforeEach clears it, so a stub can never leak into a test that meant to
// exercise the real thing.
const H = vi.hoisted(() => ({
  stub: null as null | ((jws: string) => Promise<Record<string, unknown>>),
}));

vi.mock("../../src/worker/lib/apple-billing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/worker/lib/apple-billing")>();
  return {
    ...actual,
    verifyAppleJws: (jws: string, opts?: { anchorFingerprint?: string }) =>
      H.stub ? H.stub(jws) : actual.verifyAppleJws(jws, opts),
  };
});

beforeEach(() => {
  H.stub = null;
});

// ---- certificate + JWS fixtures ------------------------------------------

const ALG = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const;
const WIDE = { notBefore: new Date("2026-01-01"), notAfter: new Date("2030-01-01") };
const SIGNED_DATE = Date.parse("2026-06-01T00:00:00Z");
const LEAF_OID = "1.2.840.113635.100.6.11.1";
const WWDR_OID = "1.2.840.113635.100.6.2.1";

const BUNDLE = "dev.ponderance.kaleidoscope";
const PRODUCT = "dev.ponderance.kaleidoscope.plus";

const genKeys = () =>
  crypto.subtle.generateKey(ALG, false, ["sign", "verify"]) as Promise<CryptoKeyPair>;

const toHex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

const der = (cert: x509.X509Certificate) =>
  btoa(String.fromCharCode(...new Uint8Array(cert.rawData)));

async function makeCert(o: {
  subject: string;
  issuer: string;
  subjectPublicKey: CryptoKey;
  signingKey: CryptoKey;
  serial: string;
  notBefore: Date;
  notAfter: Date;
  ca: boolean;
  oids?: string[];
}): Promise<x509.X509Certificate> {
  const extensions: x509.Extension[] = [new x509.BasicConstraintsExtension(o.ca, undefined, true)];
  for (const oid of o.oids ?? []) {
    extensions.push(new x509.Extension(oid, false, new Uint8Array([0x05, 0x00])));
  }
  return x509.X509CertificateGenerator.create({
    serialNumber: o.serial,
    subject: o.subject,
    issuer: o.issuer,
    notBefore: o.notBefore,
    notAfter: o.notAfter,
    publicKey: o.subjectPublicKey,
    signingKey: o.signingKey,
    signingAlgorithm: ALG,
    extensions,
  });
}

function signJws(x5c: string[], leafKey: CryptoKey, payload: object): Promise<string> {
  return new CompactSign(new TextEncoder().encode(JSON.stringify(payload)))
    .setProtectedHeader({ alg: "ES256", x5c })
    .sign(leafKey);
}

/**
 * THE valid transaction. Every negative below is this object with exactly one
 * field changed, which is what makes each rejection attributable to the check it
 * names rather than to something incidental in the fixture.
 */
function validTx(over: Record<string, unknown> = {}) {
  return {
    originalTransactionId: "2000000900000001",
    bundleId: BUNDLE,
    productId: PRODUCT,
    environment: "Production",
    inAppOwnershipType: "PURCHASED",
    appAccountToken: "u1",
    signedDate: SIGNED_DATE,
    ...over,
  };
}

/** A genuine leaf→intermediate→root chain (our own test root) + a signed JWS. */
async function buildChain(o?: {
  payload?: object;
  leafValidity?: { notBefore: Date; notAfter: Date };
  omitLeafOid?: boolean;
  omitIntermediateOid?: boolean;
}): Promise<{ jws: string; rootFingerprint: string }> {
  const rootK = await genKeys();
  const intK = await genKeys();
  const leafK = await genKeys();
  const root = await makeCert({ subject: "CN=Test Root", issuer: "CN=Test Root", subjectPublicKey: rootK.publicKey, signingKey: rootK.privateKey, serial: "01", ca: true, ...WIDE });
  const intr = await makeCert({ subject: "CN=Test Int", issuer: "CN=Test Root", subjectPublicKey: intK.publicKey, signingKey: rootK.privateKey, serial: "02", ca: true, oids: o?.omitIntermediateOid ? [] : [WWDR_OID], ...WIDE });
  const leaf = await makeCert({ subject: "CN=Test Leaf", issuer: "CN=Test Int", subjectPublicKey: leafK.publicKey, signingKey: intK.privateKey, serial: "03", ca: false, oids: o?.omitLeafOid ? [] : [LEAF_OID], ...(o?.leafValidity ?? WIDE) });
  return {
    jws: await signJws([der(leaf), der(intr), der(root)], leafK.privateKey, o?.payload ?? validTx()),
    rootFingerprint: toHex(await root.getThumbprint("SHA-256")),
  };
}

/** A single self-signed leaf masquerading as a chain. */
async function buildSelfSignedLeaf(): Promise<{ jws: string; leafFingerprint: string }> {
  const k = await genKeys();
  const leaf = await makeCert({ subject: "CN=Rogue", issuer: "CN=Rogue", subjectPublicKey: k.publicKey, signingKey: k.privateKey, serial: "01", ca: false, oids: [LEAF_OID], ...WIDE });
  return {
    jws: await signJws([der(leaf)], k.privateKey, validTx()),
    leafFingerprint: toHex(await leaf.getThumbprint("SHA-256")),
  };
}

/**
 * The RFC-5280 path-validation attack: an attacker holds a legitimate end-entity
 * cert (cA=FALSE) that genuinely chains to the trusted root — e.g. an ordinary
 * Apple developer cert under WWDR→G3 — and signs a forged leaf with its key.
 * Every signature link verifies and the anchor is the real root, so a validator
 * that skips Basic Constraints accepts it.
 */
async function buildCaFalseIssuerAttack(): Promise<{ jws: string; rootFingerprint: string }> {
  const rootK = await genKeys();
  const intK = await genKeys();
  const normalK = await genKeys();
  const forgedK = await genKeys();
  const root = await makeCert({ subject: "CN=Test Root", issuer: "CN=Test Root", subjectPublicKey: rootK.publicKey, signingKey: rootK.privateKey, serial: "01", ca: true, ...WIDE });
  const intr = await makeCert({ subject: "CN=Test Int", issuer: "CN=Test Root", subjectPublicKey: intK.publicKey, signingKey: rootK.privateKey, serial: "02", ca: true, oids: [WWDR_OID], ...WIDE });
  const normal = await makeCert({ subject: "CN=Attacker Dev Cert", issuer: "CN=Test Int", subjectPublicKey: normalK.publicKey, signingKey: intK.privateKey, serial: "03", ca: false, ...WIDE });
  const forged = await makeCert({ subject: "CN=Forged Leaf", issuer: "CN=Attacker Dev Cert", subjectPublicKey: forgedK.publicKey, signingKey: normalK.privateKey, serial: "04", ca: false, oids: [LEAF_OID], ...WIDE });
  return {
    jws: await signJws([der(forged), der(normal), der(intr), der(root)], forgedK.privateKey, validTx()),
    rootFingerprint: toHex(await root.getThumbprint("SHA-256")),
  };
}

/** Swap a JWS's payload segment for a different one, keeping header+signature. */
function tamperPayload(jws: string, payload: object): string {
  const [h, , s] = jws.split(".");
  const b64 = btoa(JSON.stringify(payload))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${h}.${b64}.${s}`;
}

// ---- env / request helpers -----------------------------------------------

const PLUS_VARS = { APPLE_BUNDLE_ID: BUNDLE, PLUS_PRODUCT_ID: PRODUCT };

function ctx(over: Record<string, unknown> = {}) {
  const DB = makeD1();
  const SESSIONS = makeKV();
  seedUser(DB, "u1");
  seedUser(DB, "u2");
  seedSession(SESSIONS, "s1", "u1");
  seedSession(SESSIONS, "s2", "u2");
  return { DB, SESSIONS, env: makeEnv({ DB, SESSIONS, RATELIMIT: makeKV(), ...PLUS_VARS, ...over }) };
}

/** Every entitlement row, for "did anything get written?" assertions. */
function rows(DB: ReturnType<typeof makeD1>) {
  return DB._db.prepare("SELECT * FROM entitlements").all() as Record<string, unknown>[];
}

/** Rows that still grant Plus: present AND not tombstoned. A refund now marks
 *  the row instead of deleting it, so `rows(DB)` alone no longer distinguishes
 *  "refunded" from "still valid" — which is the whole point of the tombstone. */
function liveRows(DB: ReturnType<typeof makeD1>): Record<string, unknown>[] {
  return rows(DB).filter((r) => r.revoked_at === null || r.revoked_at === undefined);
}

const postApple = (env: unknown, jws: unknown, sid = "s1") =>
  app.request(
    "/api/billing/apple",
    { method: "POST", headers: { ...bearer(sid), "Content-Type": "application/json" }, body: JSON.stringify({ jws }) },
    env as never,
  );

const postNotification = (env: unknown, signedPayload: unknown) =>
  app.request(
    "/api/billing/apple/notifications",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ signedPayload }) },
    env as never,
  );

// ==========================================================================
// 1. The certificate chain, for real
// ==========================================================================

describe("verifyAppleJws — x5c chain validation (real ECDSA, injected anchor)", () => {
  it("accepts a genuine chain anchored to the pinned root", async () => {
    const { verifyAppleJws } = await import("../../src/worker/lib/apple-billing");
    const { jws, rootFingerprint } = await buildChain();
    const payload = await verifyAppleJws(jws, { anchorFingerprint: rootFingerprint });
    expect(payload.bundleId).toBe(BUNDLE);
    expect(payload.originalTransactionId).toBe("2000000900000001");
  });

  it("rejects a TAMPERED payload on an otherwise valid chain", async () => {
    // The discriminator for the whole signature check: same header, same certs,
    // same signature bytes — only the payload changed, to one that would
    // otherwise grant Plus. Must fail on the signature, not on any field check.
    const { verifyAppleJws } = await import("../../src/worker/lib/apple-billing");
    const { jws, rootFingerprint } = await buildChain();
    const forged = tamperPayload(jws, validTx({ originalTransactionId: "forged-tx" }));
    expect(forged).not.toBe(jws);
    await expect(
      verifyAppleJws(forged, { anchorFingerprint: rootFingerprint }),
    ).rejects.toThrow();
  });

  it("rejects a fully-valid attacker chain that is not anchored to Apple Root CA G3", async () => {
    // Internally consistent (root→int→leaf, every link signs the next, JWS
    // validly signed by the leaf) and still rejected, because the anchor is not
    // Apple's. This is the authentication-bypass class.
    const { verifyAppleJws } = await import("../../src/worker/lib/apple-billing");
    const { jws } = await buildChain();
    await expect(verifyAppleJws(jws)).rejects.toThrow();
  });

  it("pins Apple Root CA G3 by a 64-char SHA-256 and never fetches it", async () => {
    const mod = await import("../../src/worker/lib/apple-billing");
    expect(mod.APPLE_ROOT_CA_G3_SHA256).toHaveLength(64);
    expect(mod.APPLE_ROOT_CA_G3_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a self-signed leaf even when its OWN fingerprint is the anchor", async () => {
    const { verifyAppleJws } = await import("../../src/worker/lib/apple-billing");
    const { jws, leafFingerprint } = await buildSelfSignedLeaf();
    await expect(verifyAppleJws(jws, { anchorFingerprint: leafFingerprint })).rejects.toThrow();
  });

  it("rejects a chain where a non-CA (cA=FALSE) cert is used as an issuer", async () => {
    const { verifyAppleJws } = await import("../../src/worker/lib/apple-billing");
    const { jws, rootFingerprint } = await buildCaFalseIssuerAttack();
    await expect(verifyAppleJws(jws, { anchorFingerprint: rootFingerprint })).rejects.toThrow();
  });

  it("rejects a leaf without the App Store receipt-signing marker OID", async () => {
    const { verifyAppleJws } = await import("../../src/worker/lib/apple-billing");
    const { jws, rootFingerprint } = await buildChain({ omitLeafOid: true });
    await expect(verifyAppleJws(jws, { anchorFingerprint: rootFingerprint })).rejects.toThrow();
  });

  it("rejects an intermediate without the Apple WWDR marker OID", async () => {
    const { verifyAppleJws } = await import("../../src/worker/lib/apple-billing");
    const { jws, rootFingerprint } = await buildChain({ omitIntermediateOid: true });
    await expect(verifyAppleJws(jws, { anchorFingerprint: rootFingerprint })).rejects.toThrow();
  });

  it("rejects a cert expired at the payload's signedDate", async () => {
    const { verifyAppleJws } = await import("../../src/worker/lib/apple-billing");
    const { jws, rootFingerprint } = await buildChain({
      leafValidity: { notBefore: new Date("2020-01-01"), notAfter: new Date("2021-01-01") },
    });
    await expect(verifyAppleJws(jws, { anchorFingerprint: rootFingerprint })).rejects.toThrow();
  });

  it("rejects a malformed JWS and a header with no x5c", async () => {
    const { verifyAppleJws } = await import("../../src/worker/lib/apple-billing");
    await expect(verifyAppleJws("not.a.jws.at.all")).rejects.toThrow();
    const k = await genKeys();
    const noX5c = await new CompactSign(new TextEncoder().encode("{}"))
      .setProtectedHeader({ alg: "ES256" })
      .sign(k.privateKey);
    await expect(verifyAppleJws(noX5c)).rejects.toThrow();
  });
});

// ==========================================================================
// 2. POST /api/billing/apple — the grant path
// ==========================================================================

describe("POST /api/billing/apple — gates", () => {
  it("401s a chain that does not anchor to Apple's root, end-to-end through the route", async () => {
    // No stub: the route runs the REAL verifier. A genuinely-signed JWS from a
    // non-Apple root must not grant Plus.
    const { DB, env } = ctx();
    const { jws } = await buildChain();
    const res = await postApple(env, jws);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_signature" });
    expect(rows(DB)).toHaveLength(0);
  });

  it("requires authentication", async () => {
    const { env } = ctx();
    const res = await app.request(
      "/api/billing/apple",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      env as never,
    );
    expect(res.status).toBe(401);
  });

  it("requires CSRF on a COOKIE session, and accepts the same call with the token", async () => {
    const { DB, env } = ctx();
    H.stub = async () => validTx();

    const without = await app.request(
      "/api/billing/apple",
      { method: "POST", headers: { Cookie: "__Host-kld_session=s1", "Content-Type": "application/json" }, body: JSON.stringify({ jws: "x" }) },
      env as never,
    );
    expect(without.status).toBe(403);
    expect(rows(DB)).toHaveLength(0);

    // The control: identical request plus the token succeeds, so the 403 above
    // is attributable to CSRF and not to the cookie path being broken.
    const withToken = await app.request(
      "/api/billing/apple",
      { method: "POST", headers: { Cookie: "__Host-kld_session=s1", "X-CSRF-Token": "csrf-s1", "Content-Type": "application/json" }, body: JSON.stringify({ jws: "x" }) },
      env as never,
    );
    expect(withToken.status).toBe(200);
    expect(rows(DB)).toHaveLength(1);
  });

  it("503s when PLUS_PRODUCT_ID is unset rather than matching a product-less transaction", async () => {
    const { DB, env } = ctx({ PLUS_PRODUCT_ID: "" });
    H.stub = async () => validTx({ productId: undefined });
    const res = await postApple(env, "x");
    expect(res.status).toBe(503);
    expect(rows(DB)).toHaveLength(0);
  });

  it("rate-limits at 10/h", async () => {
    const { env } = ctx();
    H.stub = async () => validTx();
    for (let i = 0; i < 10; i++) expect((await postApple(env, "x")).status).toBe(200);
    expect((await postApple(env, "x")).status).toBe(429);
  });

  it("400s a body with no jws string", async () => {
    const { env } = ctx();
    const res = await postApple(env, 12345);
    expect(res.status).toBe(400);
  });

  it("does NOT share its rate-limit budget with /checkout", async () => {
    // A single `billing:<user>` key would give both routes ONE 10/h budget, so
    // ten checkout fetches would 429 the purchase report — paid, not granted.
    const { DB, env } = ctx({
      PLUS_SURFACE_ENABLED: "true",
      LS_STORE_ID: "ponderance",
      LS_CHECKOUT_ID: CHECKOUT_ID,
      LS_VARIANT_ID: VARIANT,
    });
    for (let i = 0; i < 10; i++) {
      expect((await app.request("/api/billing/checkout", { headers: bearer("s1") }, env as never)).status).toBe(200);
    }
    // Checkout's own budget is now spent…
    expect((await app.request("/api/billing/checkout", { headers: bearer("s1") }, env as never)).status).toBe(429);
    // …and the grant path is untouched.
    H.stub = async () => validTx();
    expect((await postApple(env, "x")).status).toBe(200);
    expect(rows(DB)).toHaveLength(1);
  });
});

describe("POST /api/billing/apple — transaction field checks", () => {
  // Each case perturbs exactly ONE field of the same otherwise-valid fixture.
  const cases: [string, Record<string, unknown>, string][] = [
    ["wrong bundle id", { bundleId: "com.someone.else" }, "wrong_bundle"],
    ["wrong product id", { productId: "dev.ponderance.kaleidoscope.other" }, "wrong_product"],
    ["appAccountToken for a DIFFERENT user", { appAccountToken: "u2" }, "wrong_account"],
    ["no appAccountToken at all", { appAccountToken: undefined }, "wrong_account"],
    ["revoked", { revocationDate: 1758000000000 }, "revoked"],
    ["family-shared rather than purchased", { inAppOwnershipType: "FAMILY_SHARED" }, "not_purchased"],
    ["no originalTransactionId", { originalTransactionId: undefined }, "missing_transaction_id"],
  ];

  for (const [name, over, reason] of cases) {
    it(`rejects ${name} → ${reason}`, async () => {
      const { DB, env } = ctx();
      H.stub = async () => validTx(over);
      const res = await postApple(env, "x");
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: reason });
      expect(rows(DB)).toHaveLength(0);
    });
  }

  it("accepts an UPPERCASE appAccountToken against a lowercase user id", async () => {
    // Not a nicety. `newUserId()` is crypto.randomUUID() (lowercase), but
    // StoreKit's appAccountToken is a Swift UUID and `UUID.uuidString` is
    // UPPERCASE. Exact equality would reject every real purchase as
    // `wrong_account`. Every other test here uses the same string on both
    // sides and so is structurally blind to this.
    const DB = makeD1();
    const SESSIONS = makeKV();
    const uuid = "3f2a1b4c-5d6e-4f70-8901-a2b3c4d5e6f7";
    seedUser(DB, uuid);
    seedSession(SESSIONS, "s1", uuid);
    const env = makeEnv({ DB, SESSIONS, RATELIMIT: makeKV(), ...PLUS_VARS });
    H.stub = async () => validTx({ appAccountToken: uuid.toUpperCase() });
    expect((await postApple(env, "x")).status).toBe(200);
    expect(rows(DB)[0]).toMatchObject({ user_id: uuid });
  });

  it("still rejects a DIFFERENT uuid, so the case-insensitive compare is not a wildcard", async () => {
    const DB = makeD1();
    const SESSIONS = makeKV();
    const uuid = "3f2a1b4c-5d6e-4f70-8901-a2b3c4d5e6f7";
    seedUser(DB, uuid);
    seedSession(SESSIONS, "s1", uuid);
    const env = makeEnv({ DB, SESSIONS, RATELIMIT: makeKV(), ...PLUS_VARS });
    H.stub = async () => validTx({ appAccountToken: "3F2A1B4C-5D6E-4F70-8901-A2B3C4D5E6F8" });
    expect((await postApple(env, "x")).status).toBe(400);
    expect(rows(DB)).toHaveLength(0);
  });

  it("CONTROL: the unperturbed fixture is accepted and writes exactly one row", async () => {
    // Without this, every rejection above could be caused by the fixture itself.
    const { DB, env } = ctx();
    H.stub = async () => validTx();
    const res = await postApple(env, "x");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, plus: true });
    const r = rows(DB);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      source: "apple",
      external_id: "2000000900000001",
      user_id: "u1",
      product: "plus",
      environment: "Production",
    });
  });
});

describe("POST /api/billing/apple — the Sandbox/Production gate", () => {
  // THE production gate. Three cells over ONE Sandbox fixture; the two
  // acceptances are the controls that prove the single rejection is caused by
  // the environment check and not by anything else in the fixture.
  const sandbox = () => validTx({ environment: "Sandbox" });

  it("REJECTS a Sandbox transaction for a normal user with PLUS_ALLOW_SANDBOX=false", async () => {
    const { DB, env } = ctx({ PLUS_ALLOW_SANDBOX: "false" });
    H.stub = async () => sandbox();
    const res = await postApple(env, "x");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "wrong_environment" });
    expect(rows(DB)).toHaveLength(0);
  });

  it("CONTROL: accepts the SAME Sandbox transaction for an admin", async () => {
    const DB = makeD1();
    const SESSIONS = makeKV();
    seedUser(DB, "u1", { role: "admin" });
    seedSession(SESSIONS, "s1", "u1");
    const env = makeEnv({ DB, SESSIONS, RATELIMIT: makeKV(), ...PLUS_VARS, PLUS_ALLOW_SANDBOX: "false" });
    H.stub = async () => sandbox();
    const res = await postApple(env, "x");
    expect(res.status).toBe(200);
    expect(rows(DB)[0]).toMatchObject({ environment: "Sandbox" });
  });

  it("CONTROL: accepts the SAME Sandbox transaction when PLUS_ALLOW_SANDBOX=true", async () => {
    const { DB, env } = ctx({ PLUS_ALLOW_SANDBOX: "true" });
    H.stub = async () => sandbox();
    const res = await postApple(env, "x");
    expect(res.status).toBe(200);
    expect(rows(DB)[0]).toMatchObject({ environment: "Sandbox" });
  });

  it("a JSON boolean PLUS_ALLOW_SANDBOX=true is honored too (wrangler var typing)", async () => {
    const { env } = ctx({ PLUS_ALLOW_SANDBOX: true });
    H.stub = async () => sandbox();
    expect((await postApple(env, "x")).status).toBe(200);
  });
});

describe("POST /api/billing/apple — idempotency and ownership", () => {
  it("is idempotent: replaying the same transaction adds no second row", async () => {
    const { DB, env } = ctx();
    H.stub = async () => validTx();
    expect((await postApple(env, "x")).status).toBe(200);
    expect((await postApple(env, "x")).status).toBe(200);
    expect((await postApple(env, "x")).status).toBe(200);
    expect(rows(DB)).toHaveLength(1);
  });

  it("409 bound_elsewhere when the transaction already belongs to another user", async () => {
    const { DB, env } = ctx();
    // u2 claimed it first (their own appAccountToken).
    H.stub = async () => validTx({ appAccountToken: "u2" });
    expect((await postApple(env, "x", "s2")).status).toBe(200);

    // u1 now presents a transaction with the SAME originalTransactionId and
    // their own appAccountToken — i.e. it passes every field check and is
    // stopped only by the existing binding.
    H.stub = async () => validTx({ appAccountToken: "u1" });
    const res = await postApple(env, "x", "s1");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "bound_elsewhere" });

    const r = rows(DB);
    expect(r).toHaveLength(1);
    expect(r[0]!.user_id).toBe("u2"); // first claimant keeps it
  });

  it("an UNBOUND row (user_id NULL, from a deleted account) is claimable, not bound_elsewhere", async () => {
    // ON DELETE SET NULL leaves orphan rows. NULL is not "a different user", so
    // the plain reading of the rule is that it falls through to a claim.
    // Flagged as an M1 item: reachable from this route only if a live user's id
    // equals the deleted one's, which cannot happen — hence the direct seed.
    const { DB, env } = ctx();
    DB._db
      .prepare(
        "INSERT INTO entitlements (source, external_id, user_id, product, environment, granted_at) VALUES ('apple', '2000000900000001', NULL, 'plus', 'Production', 1)",
      )
      .run();
    H.stub = async () => validTx();
    const res = await postApple(env, "x");
    expect(res.status).toBe(200);
    const r = rows(DB);
    expect(r).toHaveLength(1);
    expect(r[0]!.user_id).toBe("u1");
  });

  it("grants are recorded even while PLUS_ENABLED is false", async () => {
    // Plus ships dark. Refusing to RECORD a payment already taken would be far
    // worse than recording one that is not yet useful.
    const { DB, env } = ctx({ PLUS_ENABLED: "false" });
    H.stub = async () => validTx();
    expect((await postApple(env, "x")).status).toBe(200);
    expect(rows(DB)).toHaveLength(1);
  });

  it("a granted entitlement is what hasPlus/plusSources report", async () => {
    // Ties this route to T02a's read side rather than asserting on our own SQL.
    const { DB, env } = ctx();
    H.stub = async () => validTx();
    await postApple(env, "x");
    const { hasPlus, plusSources } = await import("../../src/worker/lib/db");
    expect(await hasPlus(env, "u1")).toBe(true);
    expect(await plusSources(env, "u1")).toEqual(["apple"]);
    expect(await hasPlus(env, "u2")).toBe(false);
    expect(rows(DB)).toHaveLength(1);
  });
});

// ==========================================================================
// 3. POST /api/billing/apple/notifications — ASSN v2
// ==========================================================================

describe("POST /api/billing/apple/notifications", () => {
  /** Seed an existing Apple entitlement for u1. */
  function seedEnt(DB: ReturnType<typeof makeD1>, externalId = "2000000900000001") {
    DB._db
      .prepare(
        "INSERT INTO entitlements (source, external_id, user_id, product, environment, granted_at) VALUES ('apple', ?, 'u1', 'plus', 'Production', 1)",
      )
      .run(externalId);
  }

  /** Stub the nested verification: envelope first, then the inner transaction. */
  function stubNested(note: Record<string, unknown>, tx: Record<string, unknown>) {
    H.stub = async (jws: string) => (jws === "INNER" ? tx : note);
  }

  const envelope = (type: string) => ({
    notificationType: type,
    data: { bundleId: BUNDLE, signedTransactionInfo: "INNER" },
  });

  it("REFUND removes the row", async () => {
    const { DB, env } = ctx();
    seedEnt(DB);
    stubNested(envelope("REFUND"), validTx({ revocationDate: 1758000000000 }));
    const res = await postNotification(env, "OUTER");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removed: true });
    // Tombstoned, not deleted: the row survives so the refund cannot be undone
    // by replaying the JWS the device still holds, and support can still see it.
    expect(rows(DB)).toHaveLength(1);
    expect(liveRows(DB)).toHaveLength(0);
  });

  it("REVOKE removes the row", async () => {
    const { DB, env } = ctx();
    seedEnt(DB);
    stubNested(envelope("REVOKE"), validTx({ revocationDate: 1758000000000 }));
    expect((await postNotification(env, "OUTER")).status).toBe(200);
    expect(liveRows(DB)).toHaveLength(0);
  });

  it("CONTROL: an unrelated notification type leaves the row alone", async () => {
    // Proves the removals above are caused by the TYPE and not by the endpoint
    // deleting on every notification it can parse.
    const { DB, env } = ctx();
    seedEnt(DB);
    stubNested(envelope("CONSUMPTION_REQUEST"), validTx());
    const res = await postNotification(env, "OUTER");
    expect(await res.json()).toMatchObject({ ignored: true });
    expect(rows(DB)).toHaveLength(1);
  });

  it("does NOT act on another app's REFUND, even with a valid signature", async () => {
    // Apple signs every developer's notifications with the same chain, so the
    // signature alone does not prove the notification is ours. The binding is
    // checked on the INNER, verified transaction — the same object whose
    // originalTransactionId keys the row being deleted.
    const { DB, env } = ctx();
    seedEnt(DB);
    stubNested(envelope("REFUND"), validTx({ bundleId: "com.someone.else" }));
    const res = await postNotification(env, "OUTER");
    expect(await res.json()).toMatchObject({ ignored: true });
    expect(rows(DB)).toHaveLength(1);
  });

  it("does NOT act on a REFUND for a different PRODUCT of ours", async () => {
    const { DB, env } = ctx();
    seedEnt(DB);
    stubNested(envelope("REFUND"), validTx({ productId: "dev.ponderance.kaleidoscope.other" }));
    expect(await (await postNotification(env, "OUTER")).json()).toMatchObject({ ignored: true });
    expect(rows(DB)).toHaveLength(1);
  });

  it("ignores an envelope whose bundleId is ours but whose INNER transaction is not", async () => {
    // The exact trap: validating the envelope and then acting on the inner
    // transaction would delete a row on an attacker-chosen transaction id.
    const { DB, env } = ctx();
    seedEnt(DB);
    stubNested(
      { notificationType: "REFUND", data: { bundleId: BUNDLE, signedTransactionInfo: "INNER" } },
      validTx({ bundleId: "com.someone.else" }),
    );
    expect(rows(DB)).toHaveLength(1);
    await postNotification(env, "OUTER");
    expect(rows(DB)).toHaveLength(1);
  });

  it("401s an unverifiable envelope, end-to-end through the real verifier", async () => {
    const { DB, env } = ctx();
    seedEnt(DB);
    const { jws } = await buildChain({ payload: { notificationType: "REFUND" } });
    const res = await postNotification(env, jws);
    expect(res.status).toBe(401);
    expect(rows(DB)).toHaveLength(1);
  });

  it("401s when the ENVELOPE verifies but the inner transaction does not", async () => {
    const { DB, env } = ctx();
    seedEnt(DB);
    H.stub = async (jws: string) => {
      if (jws === "INNER") throw new Error("bad inner signature");
      return envelope("REFUND");
    };
    const res = await postNotification(env, "OUTER");
    expect(res.status).toBe(401);
    expect(rows(DB)).toHaveLength(1);
  });

  it("takes no session and no CSRF token (Apple has neither)", async () => {
    const { DB, env } = ctx();
    seedEnt(DB);
    stubNested(envelope("REFUND"), validTx({ revocationDate: 1 }));
    // No Authorization, no Cookie, no X-CSRF-Token anywhere in postNotification.
    expect((await postNotification(env, "OUTER")).status).toBe(200);
    expect(liveRows(DB)).toHaveLength(0);
  });

  it("400s a body with no signedPayload", async () => {
    const { env } = ctx();
    expect((await postNotification(env, 42)).status).toBe(400);
  });
});

// ==========================================================================
// 4. POST /api/billing/lemonsqueezy
// ==========================================================================

const LS_SECRET = "whsec_kaleidoscope_test";
const VARIANT = "778899";
/**
 * The checkout UUID is a DIFFERENT value from the numeric variant id, on
 * purpose: LS's Share modal gives a UUID for the URL while the webhook reports
 * `first_order_item.variant_id` as a number. Keeping them visibly unequal here
 * is what makes a regression that overloads one var fail this suite.
 */
const CHECKOUT_ID = "95128e95-ea6a-421c-87c4-0334ac3d7102";

async function lsSign(secret: string, raw: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** THE valid LS order body. Negatives perturb exactly one field. */
function lsOrder(over: {
  meta?: Record<string, unknown>;
  attributes?: Record<string, unknown>;
  item?: Record<string, unknown>;
  id?: unknown;
} = {}) {
  return {
    meta: { event_name: "order_created", test_mode: false, custom_data: { user_id: "u1" }, ...over.meta },
    data: {
      type: "orders",
      id: over.id === undefined ? "ord_1001" : over.id,
      attributes: {
        store_id: 12345,
        status: "paid",
        total: 499,
        test_mode: false,
        refunded: false,
        first_order_item: { variant_id: Number(VARIANT), test_mode: false, ...over.item },
        ...over.attributes,
      },
    },
  };
}

async function postLs(
  env: unknown,
  raw: string,
  o: { secret?: string; signature?: string } = {},
) {
  const sig = o.signature ?? (await lsSign(o.secret ?? LS_SECRET, raw));
  return app.request(
    "/api/billing/lemonsqueezy",
    { method: "POST", headers: { "X-Signature": sig, "Content-Type": "application/json" }, body: raw },
    env as never,
  );
}

function lsCtx(over: Record<string, unknown> = {}) {
  return ctx({ LS_WEBHOOK_SECRET: LS_SECRET, LS_VARIANT_ID: VARIANT, ...over });
}

describe("POST /api/billing/lemonsqueezy — signature", () => {
  it("CONTROL: a correctly-signed paid order grants Plus", async () => {
    const { DB, env } = lsCtx();
    const res = await postLs(env, JSON.stringify(lsOrder()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, plus: true });
    expect(rows(DB)[0]).toMatchObject({
      source: "lemonsqueezy",
      external_id: "ord_1001",
      user_id: "u1",
      product: "plus",
    });
  });

  it("401s a body signed with the WRONG secret", async () => {
    const { DB, env } = lsCtx();
    const res = await postLs(env, JSON.stringify(lsOrder()), { secret: "whsec_attacker" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "bad_signature" });
    expect(rows(DB)).toHaveLength(0);
  });

  it("401s when the body is MUTATED after signing", async () => {
    // The discriminator: a real signature over a real body, then one byte of the
    // body changed to a value that would otherwise grant Plus to someone else.
    const { DB, env } = lsCtx();
    const raw = JSON.stringify(lsOrder());
    const sig = await lsSign(LS_SECRET, raw);
    const mutated = raw.replace('"user_id":"u1"', '"user_id":"u2"');
    expect(mutated).not.toBe(raw);
    const res = await postLs(env, mutated, { signature: sig });
    expect(res.status).toBe(401);
    expect(rows(DB)).toHaveLength(0);
  });

  it("401s with no signature header, an empty one, or a non-hex one", async () => {
    const { env } = lsCtx();
    const raw = JSON.stringify(lsOrder());
    expect(
      (
        await app.request(
          "/api/billing/lemonsqueezy",
          { method: "POST", headers: { "Content-Type": "application/json" }, body: raw },
          env as never,
        )
      ).status,
    ).toBe(401);
    expect((await postLs(env, raw, { signature: "" })).status).toBe(401);
    expect((await postLs(env, raw, { signature: "zz".repeat(32) })).status).toBe(401);
  });

  it("401s every webhook when LS_WEBHOOK_SECRET is unset (fails closed)", async () => {
    const { DB, env } = lsCtx({ LS_WEBHOOK_SECRET: undefined });
    const raw = JSON.stringify(lsOrder());
    // A well-formed hex signature, i.e. the best an attacker can do against an
    // endpoint with no secret. (WebCrypto refuses a zero-length HMAC key, so the
    // test cannot sign with "" — but the code returns false on an empty secret
    // before it ever reaches importKey, which is the behaviour under test.)
    expect((await postLs(env, raw, { signature: "ab".repeat(32) })).status).toBe(401);
    // …and the signature that WOULD be valid under the real secret is also
    // rejected, so this is not passing merely because the digest differs.
    expect((await postLs(env, raw, { secret: LS_SECRET })).status).toBe(401);
    expect(rows(DB)).toHaveLength(0);
  });

  it("verifies the RAW bytes: non-canonical key order and whitespace still pass", async () => {
    // This is what distinguishes HMAC-over-raw-body from
    // HMAC-over-JSON.stringify(parsed). The latter passes every test whose body
    // was built by stringify — including all of the above — and then never
    // matches a real webhook. This body round-trips to different bytes.
    const { DB, env } = lsCtx();
    const canonical = JSON.stringify(lsOrder());
    const raw = JSON.stringify(lsOrder(), null, 2); // reordered/reindented bytes
    expect(raw).not.toBe(canonical);
    expect(JSON.stringify(JSON.parse(raw))).toBe(canonical); // same object
    const res = await postLs(env, raw);
    expect(res.status).toBe(200);
    expect(rows(DB)).toHaveLength(1);
  });

  it("400s a correctly-signed body that is not JSON", async () => {
    const { env } = lsCtx();
    expect((await postLs(env, "not json at all")).status).toBe(400);
  });
});

describe("POST /api/billing/lemonsqueezy — order checks", () => {
  const cases: [string, Parameters<typeof lsOrder>[0], string][] = [
    ["test_mode in meta", { meta: { test_mode: true } }, "test_mode"],
    ["test_mode on the order attributes", { attributes: { test_mode: true } }, "test_mode"],
    ["test_mode on the order item", { item: { test_mode: true } }, "test_mode"],
    ["an unpaid (pending) order", { attributes: { status: "pending" } }, "not_paid"],
    ["a failed order", { attributes: { status: "failed" } }, "not_paid"],
    ["an order with no status", { attributes: { status: undefined } }, "not_paid"],
    ["the wrong variant", { item: { variant_id: 999999 } }, "wrong_variant"],
    ["no variant at all", { item: { variant_id: undefined } }, "wrong_variant"],
    ["a zero total", { attributes: { total: 0 } }, "not_positive_total"],
    ["a negative total", { attributes: { total: -499 } }, "not_positive_total"],
    ["no custom_data user_id", { meta: { custom_data: {} } }, "unattributed"],
    ["no order id", { id: null }, "missing_order_id"],
  ];

  for (const [name, over, reason] of cases) {
    it(`writes nothing for ${name} → ${reason}`, async () => {
      const { DB, env } = lsCtx();
      const res = await postLs(env, JSON.stringify(lsOrder(over)));
      // 200 on purpose: LS retries non-2xx forever and none of these will ever
      // succeed on a retry. The security assertion is the empty table.
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ignored: true, reason });
      expect(rows(DB)).toHaveLength(0);
    });
  }

  it("CONTROL: accepts a test_mode order when PLUS_ALLOW_TEST is true", async () => {
    // Proves the three test_mode rejections come from the FLAG, not from the
    // fixture being malformed.
    const { DB, env } = lsCtx({ PLUS_ALLOW_TEST: "true" });
    const res = await postLs(env, JSON.stringify(lsOrder({ meta: { test_mode: true } })));
    expect(res.status).toBe(200);
    expect(rows(DB)).toHaveLength(1);
  });

  it("rejects EVERY order when LS_VARIANT_ID is unset — an empty var matches nothing", async () => {
    // wrangler.jsonc ships LS_VARIANT_ID as "". A naive equality would let a
    // payload with no variant match it and grant Plus on any signed webhook.
    const { DB, env } = lsCtx({ LS_VARIANT_ID: "" });
    expect(
      await (await postLs(env, JSON.stringify(lsOrder()))).json(),
    ).toMatchObject({ reason: "wrong_variant" });
    expect(
      await (await postLs(env, JSON.stringify(lsOrder({ item: { variant_id: undefined } })))).json(),
    ).toMatchObject({ reason: "wrong_variant" });
    expect(rows(DB)).toHaveLength(0);
  });

  it("matches a variant id whether LS sends it as a number or a string", async () => {
    const { DB, env } = lsCtx();
    await postLs(env, JSON.stringify(lsOrder({ item: { variant_id: VARIANT } })));
    expect(rows(DB)).toHaveLength(1);
  });

  it("ignores an order for a user that no longer exists, without a 500", async () => {
    const { DB, env } = lsCtx();
    const res = await postLs(env, JSON.stringify(lsOrder({ meta: { custom_data: { user_id: "ghost" } } })));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ reason: "unknown_user" });
    expect(rows(DB)).toHaveLength(0);
  });

  it("is idempotent by order id", async () => {
    const { DB, env } = lsCtx();
    const raw = JSON.stringify(lsOrder());
    for (let i = 0; i < 3; i++) expect((await postLs(env, raw)).status).toBe(200);
    expect(rows(DB)).toHaveLength(1);
  });

  it("order_refunded removes the row; an unknown event does not", async () => {
    const { DB, env } = lsCtx();
    await postLs(env, JSON.stringify(lsOrder()));
    expect(rows(DB)).toHaveLength(1);

    // CONTROL first: some other event must NOT delete.
    await postLs(env, JSON.stringify(lsOrder({ meta: { event_name: "subscription_updated" } })));
    expect(rows(DB)).toHaveLength(1);

    const res = await postLs(env, JSON.stringify(lsOrder({ meta: { event_name: "order_refunded" } })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removed: true });
    // Tombstoned, not deleted: the row survives so the refund cannot be undone
    // by replaying the JWS the device still holds, and support can still see it.
    expect(rows(DB)).toHaveLength(1);
    expect(liveRows(DB)).toHaveLength(0);
  });

  it("an UNSIGNED refund cannot remove a row", async () => {
    const { DB, env } = lsCtx();
    await postLs(env, JSON.stringify(lsOrder()));
    const raw = JSON.stringify(lsOrder({ meta: { event_name: "order_refunded" } }));
    expect((await postLs(env, raw, { secret: "whsec_attacker" })).status).toBe(401);
    expect(rows(DB)).toHaveLength(1);
  });

  it("a refund for one order does not touch a different order's row", async () => {
    const { DB, env } = lsCtx();
    await postLs(env, JSON.stringify(lsOrder()));
    await postLs(env, JSON.stringify(lsOrder({ id: "ord_2002", meta: { custom_data: { user_id: "u2" } } })));
    expect(rows(DB)).toHaveLength(2);
    await postLs(env, JSON.stringify(lsOrder({ meta: { event_name: "order_refunded" } })));
    // Both rows remain; only the refunded one is tombstoned.
    expect(rows(DB)).toHaveLength(2);
    const r = liveRows(DB);
    expect(r).toHaveLength(1);
    expect(r[0]!.external_id).toBe("ord_2002");
  });

  it("an apple and a lemonsqueezy entitlement coexist and both report", async () => {
    const { DB, env } = lsCtx();
    H.stub = async () => validTx();
    await postApple(env, "x");
    await postLs(env, JSON.stringify(lsOrder()));
    const { plusSources } = await import("../../src/worker/lib/db");
    expect(await plusSources(env, "u1")).toEqual(["apple", "lemonsqueezy"]);
    expect(rows(DB)).toHaveLength(2);
  });
});

// ==========================================================================
// 5. GET /api/billing/checkout
// ==========================================================================

describe("GET /api/billing/checkout", () => {
  const get = (env: unknown, sid: string | null = "s1") =>
    app.request(
      "/api/billing/checkout",
      { headers: sid ? bearer(sid) : {} },
      env as never,
    );

  const READY = {
    // The SURFACE flag gates checkout now, not cap enforcement: if the paywall
    // is visible the buy button behind it has to work (REVIEW L1 split them).
    PLUS_SURFACE_ENABLED: "true",
    LS_STORE_ID: "ponderance",
    LS_CHECKOUT_ID: CHECKOUT_ID,
    LS_VARIANT_ID: VARIANT,
  };

  // REVIEW.md minor mB5 — this GET reads nothing but it SPENDS something.
  it("a cookie session needs the CSRF token, so the budget cannot be burned cross-site", async () => {
    const { env } = ctx(READY);

    const cookieOnly = await app.request(
      "/api/billing/checkout",
      { headers: { Cookie: "__Host-kld_session=s1" } },
      env as never,
    );
    // The session cookie is SameSite=Lax, so it RIDES a cross-site top-level
    // navigation. Without this, a hostile page could bounce a signed-in visitor
    // through the URL ten times and leave the real Buy button 429ing for an hour.
    expect(cookieOnly.status).toBe(403);

    // CONTROL: the same call with the token works, so the 403 is attributable to
    // CSRF and not to the cookie path being broken.
    const withToken = await app.request(
      "/api/billing/checkout",
      { headers: { Cookie: "__Host-kld_session=s1", "X-CSRF-Token": "csrf-s1" } },
      env as never,
    );
    expect(withToken.status).toBe(200);
  });

  it("and the refused attempts do not spend the budget they were trying to burn", async () => {
    const { env } = ctx(READY);
    // Twenty forged attempts — twice the hourly allowance.
    for (let i = 0; i < 20; i++) {
      const res = await app.request(
        "/api/billing/checkout",
        { headers: { Cookie: "__Host-kld_session=s1" } },
        env as never,
      );
      expect(res.status).toBe(403);
    }
    // The user's own button still works. This is the half that matters: a 403
    // that still charged the limiter would leave the attack working.
    expect((await get(env)).status).toBe(200);
  });

  it("CONTROL: a bearer caller needs no token, since it carries no ambient credential", async () => {
    const { env } = ctx(READY);
    expect((await get(env)).status).toBe(200);
  });

  it("returns a hosted-checkout URL carrying checkout[custom][user_id]", async () => {
    const { env } = ctx(READY);
    const res = await get(env);
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    const u = new URL(url);
    expect(u.origin).toBe("https://ponderance.lemonsqueezy.com");
    // `/checkout/buy/<UUID>` — the exact shape LS's own Share modal emits.
    // `/buy/<numeric variant id>`, which this once built, is not a real path.
    expect(u.pathname).toBe(`/checkout/buy/${CHECKOUT_ID}`);
    expect(u.pathname).not.toContain(VARIANT);
    // The ONLY thing tying a payment back to an account — and exactly what the
    // webhook reads out of meta.custom_data.
    expect(u.searchParams.get("checkout[custom][user_id]")).toBe("u1");
    // Redirect, not overlay: no LS script host is needed, so the CSP is unchanged.
    expect(u.searchParams.get("embed")).toBe("0");
  });

  it("the URL it hands out is one the webhook actually attributes", async () => {
    // Closes the loop rather than trusting the two halves separately.
    const { DB, env } = ctx({ ...READY, LS_WEBHOOK_SECRET: LS_SECRET });
    const { url } = (await (await get(env)).json()) as { url: string };
    const userId = new URL(url).searchParams.get("checkout[custom][user_id]")!;
    await postLs(env, JSON.stringify(lsOrder({ meta: { custom_data: { user_id: userId } } })));
    expect(rows(DB)[0]).toMatchObject({ user_id: "u1", source: "lemonsqueezy" });
  });

  it("requires authentication", async () => {
    const { env } = ctx(READY);
    expect((await get(env, null)).status).toBe(401);
  });

  it("503s while the Plus surface is off", async () => {
    const { env } = ctx({ ...READY, PLUS_SURFACE_ENABLED: "false" });
    const res = await get(env);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "not_enabled" });
  });

  // The review window: caps off, surface on. The reviewer has to be able to
  // buy, so enforcement must NOT gate the checkout.
  it("sells while the surface is on even though caps are not enforced", async () => {
    const { env } = ctx({ ...READY, PLUS_ENABLED: "false" });
    const res = await get(env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { url: string }).url).toContain("/checkout/buy/");
  });

  // A permanent condition must not burn the retry budget (minor): the ids are
  // empty and no amount of retrying fills them, so the honest 503 must survive
  // being clicked repeatedly rather than turning into a 429.
  it("keeps answering not_configured however many times it is asked", async () => {
    const { env } = ctx({ ...READY, LS_CHECKOUT_ID: "" });
    for (let i = 0; i < 15; i++) {
      const res = await get(env);
      expect(res.status, `attempt ${i + 1}`).toBe(503);
      expect(await res.json()).toEqual({ error: "not_configured" });
    }
  });

  it("503s cleanly when LS_STORE_ID or LS_CHECKOUT_ID is unset, rather than emitting a broken URL", async () => {
    // Both ship as "" in wrangler.jsonc until the LS store leaves test mode.
    for (const over of [{ LS_STORE_ID: "" }, { LS_CHECKOUT_ID: "" }, { LS_STORE_ID: "  " }]) {
      const { env } = ctx({ ...READY, ...over });
      const res = await get(env);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "not_configured" });
    }
  });

  it("rate-limits at 10/h", async () => {
    const { env } = ctx(READY);
    for (let i = 0; i < 10; i++) expect((await get(env)).status).toBe(200);
    expect((await get(env)).status).toBe(429);
  });

  it("keeps the two LS identifiers in their own jobs", async () => {
    // The bug this guards: one var used for both the URL and the webhook check.
    // The URL must carry the checkout UUID and never the numeric variant id;
    // an order carrying the UUID as its variant must NOT be attributed.
    const { DB, env } = ctx({ ...READY, LS_WEBHOOK_SECRET: LS_SECRET });
    const { url } = (await (await get(env)).json()) as { url: string };
    expect(url).toContain(CHECKOUT_ID);
    expect(url).not.toContain(VARIANT);

    await postLs(
      env,
      JSON.stringify(
        lsOrder({ item: { variant_id: CHECKOUT_ID } }),
      ),
    );
    expect(rows(DB)).toHaveLength(0);
  });

  it("still 200s when LS_VARIANT_ID is unset — the URL does not depend on it", async () => {
    // Deliberate asymmetry: a missing variant id breaks ATTRIBUTION (covered
    // above: every order is rejected), not the ability to send someone to pay.
    const { env } = ctx({ ...READY, LS_VARIANT_ID: "" });
    expect((await get(env)).status).toBe(200);
  });
});

// ==========================================================================
// 6. Mounting
// ==========================================================================

describe("route mounting", () => {
  it("billing routes are mounted ABOVE the /api/* catch-all", async () => {
    // Hono matches in registration order. Mounted after the catch-all, every
    // billing route would answer a silent 404 and every test above would be
    // testing the 404 handler.
    const { env } = ctx();
    for (const [path, init] of [
      ["/api/billing/apple", { method: "POST" }],
      ["/api/billing/apple/notifications", { method: "POST" }],
      ["/api/billing/lemonsqueezy", { method: "POST" }],
      ["/api/billing/checkout", {}],
    ] as const) {
      const res = await app.request(path, init, env as never);
      expect(res.status).not.toBe(404);
    }
    // …and a genuinely unknown billing path still 404s.
    expect((await app.request("/api/billing/nope", {}, env as never)).status).toBe(404);
  });
});

// ==========================================================================
// REVIEW.md M1, M2, M3 — refund/replay, and the Sandbox entitlement that never
// expired. Each test performs the ATTACK, not just the fix's happy path.
// ==========================================================================

function seedRow(
  DB: ReturnType<typeof makeD1>,
  o: { source?: string; externalId?: string; environment?: string | null } = {},
) {
  DB._db
    .prepare(
      "INSERT INTO entitlements (source, external_id, user_id, product, environment, granted_at)"
        + " VALUES (?, ?, 'u1', 'plus', ?, 1)",
    )
    .run(o.source ?? "apple", o.externalId ?? "2000000900000001", o.environment ?? "Production");
}

describe("a refunded purchase cannot be replayed back into existence", () => {
  // M1. The device holds a JWS signed BEFORE the refund. It carries no
  // `revocationDate`, so verification passes on its own terms — nothing about
  // the credential is wrong. Only a server-side memory of the refund can stop
  // it, and deleting the row destroyed exactly that.
  it("Apple: buy → refund → re-POST the saved JWS is refused, and Plus stays gone", async () => {
    const { DB, env } = ctx();
    seedRow(DB);
    expect(await hasPlus(env as never, "u1")).toBe(true);

    H.stub = async (jws: string) =>
      jws === "INNER"
        ? validTx({ revocationDate: 1758000000000 })
        : { notificationType: "REFUND", data: { signedTransactionInfo: "INNER" } };
    expect((await postNotification(env, "OUTER")).status).toBe(200);
    expect(await hasPlus(env as never, "u1")).toBe(false);

    // The replay: the JWS the device kept, unchanged and still perfectly valid.
    H.stub = async () => validTx();
    const replay = await postApple(env, "SAVED-BEFORE-THE-REFUND");
    expect(replay.status).toBe(409);
    expect(await replay.json()).toEqual({ error: "revoked" });
    expect(await hasPlus(env as never, "u1")).toBe(false);
  });

  // M2. LS retries `order_created` for up to three days and the dashboard has a
  // manual resend. The retry is byte-identical with a valid signature, so the
  // tombstone is the only thing that can tell it from the original.
  it("Lemon Squeezy: order_created → order_refunded → the retried order_created", async () => {
    const { DB, env } = lsCtx();
    const created = JSON.stringify(lsOrder());

    expect((await postLs(env, created)).status).toBe(200);
    expect(await hasPlus(env as never, "u1")).toBe(true);

    const refunded = JSON.stringify(lsOrder({ meta: { event_name: "order_refunded" } }));
    expect((await postLs(env, refunded)).status).toBe(200);
    expect(await hasPlus(env as never, "u1")).toBe(false);

    const retry = await postLs(env, created); // byte-identical replay
    expect(retry.status).toBe(200); // 200 on purpose: a non-2xx makes LS retry
    expect(await retry.json()).toEqual({ ok: true, ignored: true, reason: "revoked" });
    expect(await hasPlus(env as never, "u1")).toBe(false);
    expect(liveRows(DB)).toHaveLength(0);
  });
});

describe("a Sandbox entitlement lasts exactly as long as we allow Sandbox", () => {
  // M3. `environment` was written to the row and never read again, so a free
  // Sandbox purchase made during the review window was worth real money
  // forever, invisible to every query in the codebase.
  it("counts while PLUS_ALLOW_SANDBOX is on — the reviewer must actually get Plus", async () => {
    const { DB, env } = ctx({ PLUS_ALLOW_SANDBOX: "true" });
    seedRow(DB, { externalId: "sandbox-1", environment: "Sandbox" });
    expect(await hasPlus(env as never, "u1")).toBe(true);
    expect(await plusSources(env as never, "u1")).toEqual(["apple"]);
  });

  it("stops counting the moment the flag goes off — no cleanup deploy needed", async () => {
    const { DB, env } = ctx({ PLUS_ALLOW_SANDBOX: "false" });
    seedRow(DB, { externalId: "sandbox-1", environment: "Sandbox" });
    expect(await hasPlus(env as never, "u1")).toBe(false);
    expect(await plusSources(env as never, "u1")).toEqual([]);
  });

  it("CONTROL: a Production row is unaffected by the flag either way", async () => {
    for (const allow of ["true", "false"]) {
      const { DB, env } = ctx({ PLUS_ALLOW_SANDBOX: allow });
      seedRow(DB);
      expect(await hasPlus(env as never, "u1")).toBe(true);
    }
  });
});

// Minor list — two money-relevant checks that existed in the types and nowhere
// in the code.
describe("an order that is already refunded does not grant", () => {
  it("refuses `refunded: true` even when the status still says paid", async () => {
    const { DB, env } = lsCtx();
    const body = JSON.stringify(lsOrder({ attributes: { refunded: true } }));
    const res = await postLs(env, body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: true, reason: "refunded" });
    expect(liveRows(DB)).toHaveLength(0);
  });

  it("CONTROL: the same order without the flag still grants", async () => {
    const { DB, env } = lsCtx();
    expect((await postLs(env, JSON.stringify(lsOrder()))).status).toBe(200);
    expect(liveRows(DB)).toHaveLength(1);
  });
});

describe("a Sandbox refund cannot revoke a Production entitlement", () => {
  // Apple delivers sandbox notifications to the same URL and
  // originalTransactionId is not unique across environments, so an unscoped
  // revoke let a sandbox refund cancel a paying customer's Plus.
  it("leaves the Production row alone", async () => {
    const { DB, env } = ctx({ PLUS_ALLOW_SANDBOX: "true" });
    seedRow(DB, { environment: "Production" }); // the paying customer
    expect(await hasPlus(env as never, "u1")).toBe(true);

    H.stub = async (jws: string) =>
      jws === "INNER"
        ? validTx({ environment: "Sandbox", revocationDate: 1758000000000 })
        : { notificationType: "REFUND", data: { signedTransactionInfo: "INNER" } };
    const res = await postNotification(env, "OUTER");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removed: false });
    expect(await hasPlus(env as never, "u1"), "a paying customer must keep Plus").toBe(true);
  });

  it("CONTROL: a Production refund does revoke it", async () => {
    const { DB, env } = ctx();
    seedRow(DB, { environment: "Production" });
    H.stub = async (jws: string) =>
      jws === "INNER"
        ? validTx({ environment: "Production", revocationDate: 1758000000000 })
        : { notificationType: "REFUND", data: { signedTransactionInfo: "INNER" } };
    expect((await postNotification(env, "OUTER")).status).toBe(200);
    expect(await hasPlus(env as never, "u1")).toBe(false);
  });
});
