// Kaleidoscope Plus billing: Apple StoreKit grants, App Store Server
// Notifications, the Stripe webhook and the Stripe Checkout redirect (PLAN §2.3).
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
//
// Stripe is never called for real. `globalThis.fetch` is replaced for EVERY test
// in this file by a stub that answers only the two Stripe endpoints the worker
// is allowed to use; anything else is recorded and fails the test in afterEach.
// It records rather than throws on purpose: the routes turn a throwing fetch
// into a 502/503, so a throw would let a negative test pass for the wrong reason.

import "reflect-metadata";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as x509 from "@peculiar/x509";
import { CompactSign } from "jose";
import app from "../../src/worker/index";
import { makeD1, makeKV, makeEnv, seedUser, seedSession, bearer, BASE } from "./helpers";
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

// ---- the Stripe API stub -------------------------------------------------

const STRIPE_API = "https://api.stripe.com";
const CHECKOUT_URL = "https://checkout.stripe.com/c/pay/cs_live_a1KaleidoscopePlus";

interface StripeCall {
  url: string;
  method: string;
  headers: Headers;
  body: string;
  signal: unknown;
}

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** A PaymentIntent as `GET /v1/payment_intents/:id?expand[]=latest_charge`
 *  returns it: succeeded, with its charge expanded and untouched. */
function piReply(
  id: string,
  over: Record<string, unknown> = {},
  charge: Record<string, unknown> = {},
): Response {
  return jsonResponse(200, {
    id,
    object: "payment_intent",
    status: "succeeded",
    amount: 499,
    livemode: true,
    latest_charge: {
      id: "ch_3KaleidoscopePlus01",
      object: "charge",
      payment_intent: id,
      paid: true,
      refunded: false,
      amount_refunded: 0,
      disputed: false,
      ...charge,
    },
    ...over,
  });
}

const defaultCheckoutReply = () =>
  jsonResponse(200, { id: "cs_live_a1KaleidoscopePlus", object: "checkout.session", url: CHECKOUT_URL });

/** What the stub answers per endpoint (tests swap these) and what it saw. */
const S = {
  calls: [] as StripeCall[],
  unexpected: [] as string[],
  pi: (id: string): Response => piReply(id),
  checkout: defaultCheckoutReply as () => Response,
};

const REAL_FETCH = globalThis.fetch;

beforeEach(() => {
  S.calls = [];
  S.unexpected = [];
  S.pi = (id) => piReply(id);
  S.checkout = defaultCheckoutReply;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const call: StripeCall = {
      url,
      method,
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : "",
      signal: init?.signal,
    };
    const u = new URL(url);
    if (u.origin === STRIPE_API && method === "POST" && u.pathname === "/v1/checkout/sessions" && !u.search) {
      S.calls.push(call);
      return S.checkout();
    }
    const pi = /^\/v1\/payment_intents\/([A-Za-z0-9_]+)$/.exec(u.pathname);
    if (
      u.origin === STRIPE_API &&
      method === "GET" &&
      pi &&
      JSON.stringify([...u.searchParams.entries()]) === JSON.stringify([["expand[]", "latest_charge"]])
    ) {
      S.calls.push(call);
      return S.pi(pi[1]!);
    }
    S.unexpected.push(`${method} ${url}`);
    return new Response("unexpected request in test", { status: 599 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
  vi.restoreAllMocks();
  // Fails the test that made the call, by name.
  expect(S.unexpected, "unexpected outbound requests").toEqual([]);
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
    const { DB, env } = ctx(READY);
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
// 4. POST /api/billing/stripe — the webhook
// ==========================================================================

const WHSEC = "whsec_kaleidoscope_test_secret";
/** A LIVE key, so `checkoutConfigured` passes without PLUS_ALLOW_TEST. Never a
 *  real key: every Stripe call in this file goes to the stub above. */
const SK = "sk_live_kaleidoscope_test_only";
const PRICE = "price_1KaleidoscopePlus";
const PI = "pi_3KaleidoscopePlus01";
const SESSION_ID = "cs_live_a1KaleidoscopePlus";
const EVENT_ID = "evt_1KaleidoscopeGrant";
const BUYER_EMAIL = "buyer@example.test";

const nowSec = () => Math.floor(Date.now() / 1000);

async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A `Stripe-Signature` header exactly as Stripe builds it: `t=<unix>,v1=<hex>`
 *  where the MAC is over `"<t>.<raw body>"`, keyed with the whole whsec string. */
async function stripeSign(secret: string, raw: string, t = nowSec()): Promise<string> {
  return `t=${t},v1=${await hmacHex(secret, `${t}.${raw}`)}`;
}

/**
 * THE valid grant event. Every negative below is this object with exactly one
 * field changed. `customer_details.email` is in it on purpose: it is what a
 * real session carries, and the log tests assert it never reaches a log line.
 */
function checkoutEvent(o: {
  event?: Record<string, unknown>;
  session?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
} = {}) {
  return {
    id: EVENT_ID,
    object: "event",
    api_version: "2026-04-22.dahlia",
    type: "checkout.session.completed",
    livemode: true,
    created: 1767225600,
    ...o.event,
    data: {
      object: {
        id: SESSION_ID,
        object: "checkout.session",
        livemode: true,
        mode: "payment",
        status: "complete",
        payment_status: "paid",
        amount_total: 499,
        currency: "usd",
        payment_intent: PI,
        client_reference_id: "u1",
        customer_details: { email: BUYER_EMAIL },
        metadata: { app: "kaleidoscope", product: "plus", user_id: "u1", ...o.metadata },
        ...o.session,
      },
    },
  };
}

function refundEvent(over: Record<string, unknown> = {}) {
  return {
    id: "evt_1KaleidoscopeRefund",
    object: "event",
    type: "charge.refunded",
    livemode: true,
    data: {
      object: {
        id: "ch_3KaleidoscopePlus01",
        object: "charge",
        payment_intent: PI,
        amount: 499,
        amount_refunded: 499,
        refunded: true,
        ...over,
      },
    },
  };
}

function disputeEvent(over: Record<string, unknown> = {}) {
  return {
    id: "evt_1KaleidoscopeDispute",
    object: "event",
    type: "charge.dispute.closed",
    livemode: true,
    data: {
      object: {
        id: "dp_1KaleidoscopePlus01",
        object: "dispute",
        charge: "ch_3KaleidoscopePlus01",
        payment_intent: PI,
        amount: 499,
        status: "lost",
        ...over,
      },
    },
  };
}

/** POST a webhook. `header: null` sends no Stripe-Signature at all. */
async function postStripe(
  env: unknown,
  raw: string,
  o: { secret?: string; header?: string | null; t?: number } = {},
) {
  const header =
    o.header === undefined ? await stripeSign(o.secret ?? WHSEC, raw, o.t) : o.header;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (header !== null) headers["Stripe-Signature"] = header;
  return app.request("/api/billing/stripe", { method: "POST", headers, body: raw }, env as never);
}

const post = (env: unknown, body: object) => postStripe(env, JSON.stringify(body));

function stripeCtx(over: Record<string, unknown> = {}) {
  return ctx({ STRIPE_WEBHOOK_SECRET: WHSEC, STRIPE_SECRET_KEY: SK, ...over });
}


describe("POST /api/billing/stripe — signature", () => {
  it("CONTROL: a correctly-signed paid checkout grants Plus", async () => {
    const { DB, env } = stripeCtx();
    const res = await post(env, checkoutEvent());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, plus: true });
    expect(rows(DB)).toHaveLength(1);
    expect(rows(DB)[0]).toMatchObject({
      source: "stripe",
      external_id: PI,
      user_id: "u1",
      product: "plus",
      environment: "Production",
    });
  });

  it("401s a body signed with the WRONG secret", async () => {
    const { DB, env } = stripeCtx();
    const res = await postStripe(env, JSON.stringify(checkoutEvent()), { secret: "whsec_attacker" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "bad_signature" });
    expect(rows(DB)).toHaveLength(0);
    expect(S.calls).toHaveLength(0);
  });

  it("401s when the body is MUTATED after signing", async () => {
    // A real signature over a real body, then the body changed to one that
    // would otherwise grant Plus to someone else.
    const { DB, env } = stripeCtx();
    const raw = JSON.stringify(checkoutEvent());
    const header = await stripeSign(WHSEC, raw);
    const mutated = raw.replaceAll('"u1"', '"u2"');
    expect(mutated).not.toBe(raw);
    expect((await postStripe(env, mutated, { header })).status).toBe(401);
    expect(rows(DB)).toHaveLength(0);
  });

  it("401s with no header, an empty one, garbage, or a v1 that is not hex", async () => {
    const { DB, env } = stripeCtx();
    const raw = JSON.stringify(checkoutEvent());
    const t = nowSec();
    for (const header of [
      null,
      "",
      "garbage",
      `t=${t}`, // a timestamp and no signature
      `v1=${await hmacHex(WHSEC, `${t}.${raw}`)}`, // a signature and no timestamp
      `t=${t},v1=${"zz".repeat(32)}`,
      `t=${t},v1=${(await hmacHex(WHSEC, `${t}.${raw}`)).slice(0, 63)}`, // truncated
    ]) {
      expect((await postStripe(env, raw, { header })).status, String(header)).toBe(401);
    }
    expect(rows(DB)).toHaveLength(0);
  });

  it("ignores v0: a header whose only valid MAC is under v0 is refused", async () => {
    // v0 is Stripe's legacy test-mode scheme and its libraries ignore it. A
    // verifier that read "any vN" would accept a scheme we never agreed to.
    const { DB, env } = stripeCtx();
    const raw = JSON.stringify(checkoutEvent());
    const t = nowSec();
    const mac = await hmacHex(WHSEC, `${t}.${raw}`);
    expect((await postStripe(env, raw, { header: `t=${t},v0=${mac}` })).status).toBe(401);
    expect(rows(DB)).toHaveLength(0);
    // CONTROL: the same MAC under v1 is accepted.
    expect((await postStripe(env, raw, { header: `t=${t},v0=${mac},v1=${mac}` })).status).toBe(200);
  });

  it("accepts two v1 entries when the SECOND is the valid one (secret rolling)", async () => {
    // While an endpoint secret rolls, Stripe signs with both. A verifier that
    // stopped at the first v1 would drop every delivery for the whole overlap.
    const { DB, env } = stripeCtx();
    const raw = JSON.stringify(checkoutEvent());
    const t = nowSec();
    const old = await hmacHex("whsec_the_old_secret", `${t}.${raw}`);
    const good = await hmacHex(WHSEC, `${t}.${raw}`);
    expect((await postStripe(env, raw, { header: `t=${t},v1=${old},v1=${good}` })).status).toBe(200);
    expect(rows(DB)).toHaveLength(1);
  });

  it("401s a MAC that is valid for a DIFFERENT timestamp than the one in the header", async () => {
    // The timestamp is inside the signed string. If it were not, an attacker
    // could freshen a captured delivery by rewriting `t` alone.
    const { DB, env } = stripeCtx();
    const raw = JSON.stringify(checkoutEvent());
    const t = nowSec();
    const macForEarlier = await hmacHex(WHSEC, `${t - 1000}.${raw}`);
    expect((await postStripe(env, raw, { header: `t=${t},v1=${macForEarlier}` })).status).toBe(401);
    expect(rows(DB)).toHaveLength(0);
  });

  describe("the five-minute window", () => {
    // Pinned clock: with real time a CONTROL at 299s can drift past 300 between
    // signing and verifying, which would make the pair flaky in the wrong way.
    const NOW = 1_767_225_600_000;
    beforeEach(() => {
      vi.spyOn(Date, "now").mockReturnValue(NOW);
    });

    it("401s a correctly-signed delivery 301s old (a captured replay)", async () => {
      const { DB, env } = stripeCtx();
      const raw = JSON.stringify(checkoutEvent());
      expect((await postStripe(env, raw, { t: NOW / 1000 - 301 })).status).toBe(401);
      expect(rows(DB)).toHaveLength(0);
    });

    it("401s a correctly-signed delivery 301s in the FUTURE", async () => {
      const { DB, env } = stripeCtx();
      const raw = JSON.stringify(checkoutEvent());
      expect((await postStripe(env, raw, { t: NOW / 1000 + 301 })).status).toBe(401);
      expect(rows(DB)).toHaveLength(0);
    });

    it("CONTROL: the same delivery 299s old is accepted", async () => {
      const { DB, env } = stripeCtx();
      const raw = JSON.stringify(checkoutEvent());
      expect((await postStripe(env, raw, { t: NOW / 1000 - 299 })).status).toBe(200);
      expect(rows(DB)).toHaveLength(1);
    });
  });

  it("401s every webhook when STRIPE_WEBHOOK_SECRET is unset or blank (fails closed)", async () => {
    for (const secret of [undefined, "", "   "]) {
      const { DB, env } = stripeCtx({ STRIPE_WEBHOOK_SECRET: secret });
      const raw = JSON.stringify(checkoutEvent());
      // The best an attacker can do against an endpoint with no secret…
      expect((await postStripe(env, raw, { header: `t=${nowSec()},v1=${"ab".repeat(32)}` })).status).toBe(401);
      // …and the signature that WOULD be valid under the real secret, so this
      // is not passing merely because the digest differs.
      expect((await postStripe(env, raw)).status).toBe(401);
      expect(rows(DB)).toHaveLength(0);
    }
  });

  it("trims the configured secret: a trailing newline from `wrangler secret put` still verifies", async () => {
    const { DB, env } = stripeCtx({ STRIPE_WEBHOOK_SECRET: `${WHSEC}\n` });
    expect((await post(env, checkoutEvent())).status).toBe(200);
    expect(rows(DB)).toHaveLength(1);
  });

  it("verifies the RAW bytes: re-indented JSON still passes", async () => {
    // HMAC-over-JSON.stringify(parsed) passes every test whose body was built
    // by stringify and then never matches a real webhook.
    const { DB, env } = stripeCtx();
    const canonical = JSON.stringify(checkoutEvent());
    const raw = JSON.stringify(checkoutEvent(), null, 2);
    expect(raw).not.toBe(canonical);
    expect(JSON.stringify(JSON.parse(raw))).toBe(canonical);
    expect((await postStripe(env, raw)).status).toBe(200);
    expect(rows(DB)).toHaveLength(1);
  });

  it("400s a correctly-signed body that is not JSON", async () => {
    const { env } = stripeCtx();
    expect((await postStripe(env, "not json at all")).status).toBe(400);
    expect(S.calls).toHaveLength(0);
  });

  it("takes no session and no CSRF token (Stripe has neither)", async () => {
    // No Authorization, no Cookie, no X-CSRF-Token anywhere in postStripe.
    const { DB, env } = stripeCtx();
    expect((await post(env, checkoutEvent())).status).toBe(200);
    expect(rows(DB)).toHaveLength(1);
  });
});

describe("verifyStripeSignature — direct", () => {
  const NOW = 1_767_225_600_000;
  const raw = '{"id":"evt_1"}';

  it("accepts its own header, and rejects at 301s either side", async () => {
    const { verifyStripeSignature } = await import("../../src/worker/lib/stripe");
    const t = NOW / 1000;
    expect(await verifyStripeSignature(WHSEC, raw, await stripeSign(WHSEC, raw, t), NOW)).toBe(true);
    expect(await verifyStripeSignature(WHSEC, raw, await stripeSign(WHSEC, raw, t - 300), NOW)).toBe(true);
    expect(await verifyStripeSignature(WHSEC, raw, await stripeSign(WHSEC, raw, t - 301), NOW)).toBe(false);
    expect(await verifyStripeSignature(WHSEC, raw, await stripeSign(WHSEC, raw, t + 301), NOW)).toBe(false);
  });

  it("is false for an empty secret or header without throwing", async () => {
    const { verifyStripeSignature } = await import("../../src/worker/lib/stripe");
    const header = await stripeSign(WHSEC, raw, NOW / 1000);
    expect(await verifyStripeSignature("", raw, header, NOW)).toBe(false);
    expect(await verifyStripeSignature(WHSEC, raw, undefined, NOW)).toBe(false);
    expect(await verifyStripeSignature(WHSEC, raw, "", NOW)).toBe(false);
  });

  it("refuses a header with two timestamps rather than guessing which one was signed", async () => {
    const { verifyStripeSignature } = await import("../../src/worker/lib/stripe");
    const t = NOW / 1000;
    const mac = await hmacHex(WHSEC, `${t}.${raw}`);
    expect(await verifyStripeSignature(WHSEC, raw, `t=${t},t=${t - 9999},v1=${mac}`, NOW)).toBe(false);
  });

  it("skips a malformed v1 entry and still checks the well-formed one after it", async () => {
    const { verifyStripeSignature } = await import("../../src/worker/lib/stripe");
    const t = NOW / 1000;
    const mac = await hmacHex(WHSEC, `${t}.${raw}`);
    expect(await verifyStripeSignature(WHSEC, raw, `t=${t},v1=nothex,v1=${mac}`, NOW)).toBe(true);
  });
});

describe("POST /api/billing/stripe — checkout event checks", () => {
  // Each case perturbs exactly ONE field of the same otherwise-valid fixture.
  const cases: [string, Parameters<typeof checkoutEvent>[0], string][] = [
    ["event.livemode false", { event: { livemode: false } }, "test_mode"],
    ["session.livemode false", { session: { livemode: false } }, "test_mode"],
    ["event.livemode missing", { event: { livemode: undefined } }, "test_mode"],
    ["session.livemode missing", { session: { livemode: undefined } }, "test_mode"],
    ["event.livemode the STRING \"true\"", { event: { livemode: "true" } }, "test_mode"],
    ["an object that is not a checkout session", { session: { object: "payment_intent" } }, "not_a_session"],
    ["metadata.app of another app", { metadata: { app: "calque" } }, "wrong_product"],
    ["no metadata.app", { metadata: { app: undefined } }, "wrong_product"],
    ["metadata.product of another product", { metadata: { product: "pro" } }, "wrong_product"],
    ["no metadata.product", { metadata: { product: undefined } }, "wrong_product"],
    ["no metadata at all", { session: { metadata: undefined } }, "wrong_product"],
    ["mode subscription", { session: { mode: "subscription" } }, "wrong_mode"],
    ["payment_status unpaid", { session: { payment_status: "unpaid" } }, "not_paid"],
    ["payment_status no_payment_required", { session: { payment_status: "no_payment_required" } }, "not_paid"],
    ["no payment_status", { session: { payment_status: undefined } }, "not_paid"],
    ["amount_total 0", { session: { amount_total: 0 } }, "not_positive_total"],
    ["amount_total missing", { session: { amount_total: undefined } }, "not_positive_total"],
    ["amount_total as a string", { session: { amount_total: "499" } }, "not_positive_total"],
    ["no payment_intent", { session: { payment_intent: null } }, "missing_payment_intent"],
    ["an expanded payment_intent with no id", { session: { payment_intent: { object: "payment_intent" } } }, "missing_payment_intent"],
    ["no client_reference_id", { session: { client_reference_id: null } }, "unattributed"],
    ["no metadata.user_id", { metadata: { user_id: undefined } }, "unattributed"],
    ["client_reference_id and metadata.user_id disagree", { metadata: { user_id: "u2" } }, "attribution_mismatch"],
  ];

  for (const [name, over, reason] of cases) {
    it(`writes nothing for ${name} → ${reason}, and never calls Stripe`, async () => {
      const { DB, env } = stripeCtx();
      const res = await post(env, checkoutEvent(over));
      // 200 on purpose: Stripe retries non-2xx for three days and none of these
      // will ever succeed on a retry. The security assertion is the empty table.
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, ignored: true, reason });
      expect(rows(DB)).toHaveLength(0);
      // Refused on the event alone: no re-read was spent on it.
      expect(S.calls).toHaveLength(0);
    });
  }

  it("CONTROL: a test-mode event grants under PLUS_ALLOW_TEST, as environment Test", async () => {
    // Proves the test_mode rejections come from the FLAG and not from the
    // fixture being malformed. Asserted at the row level only: whether a Test
    // row COUNTS is liveEntitlement's decision, not this route's.
    for (const over of [{ event: { livemode: false } }, { session: { livemode: false } }]) {
      const { DB, env } = stripeCtx({ PLUS_ALLOW_TEST: "true" });
      expect((await post(env, checkoutEvent(over))).status).toBe(200);
      expect(rows(DB)).toHaveLength(1);
      expect(rows(DB)[0]).toMatchObject({ source: "stripe", external_id: PI, environment: "Test" });
    }
  });

  it("CONTROL: a LIVE event under PLUS_ALLOW_TEST is still recorded as Production", async () => {
    // The flag widens what is accepted; it must not relabel a real payment.
    const { DB, env } = stripeCtx({ PLUS_ALLOW_TEST: "true" });
    expect((await post(env, checkoutEvent())).status).toBe(200);
    expect(rows(DB)[0]).toMatchObject({ environment: "Production" });
  });

  it("CONTROL: an EXPANDED payment_intent object is accepted and keyed by its id", async () => {
    const { DB, env } = stripeCtx();
    const res = await post(env, checkoutEvent({ session: { payment_intent: { id: PI, object: "payment_intent" } } }));
    expect(res.status).toBe(200);
    expect(rows(DB)[0]).toMatchObject({ external_id: PI });
  });

  it("logs a refusal with the event, session and payment intent ids — and never the email", async () => {
    // A refusal that leaves no trace is money taken and nothing granted, with no
    // way to find it again. The ids are what support needs to look it up in
    // Stripe; the buyer's email is what the log must not carry.
    const { env } = stripeCtx();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await post(env, checkoutEvent({ session: { client_reference_id: null } }));
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain(EVENT_ID);
    expect(logged).toContain(SESSION_ID);
    expect(logged).toContain(PI);
    expect(logged).toContain("unattributed");
    expect(logged).not.toContain(BUYER_EMAIL);
    expect(logged).not.toContain(WHSEC);
    expect(logged).not.toContain(SK);
  });
});

describe("POST /api/billing/stripe — flow", () => {
  it("ignores an event type it does not handle, without calling Stripe", async () => {
    const { DB, env } = stripeCtx();
    for (const type of ["payment_intent.succeeded", "checkout.session.expired", "checkout.session.async_payment_failed"]) {
      const res = await post(env, checkoutEvent({ event: { type } }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, ignored: true, reason: "event" });
    }
    expect(rows(DB)).toHaveLength(0);
    expect(S.calls).toHaveLength(0);
  });

  it("ignores a purchase for a user that no longer exists, without a 500 or a Stripe call", async () => {
    const { DB, env } = stripeCtx();
    const res = await post(env, checkoutEvent({ session: { client_reference_id: "ghost" }, metadata: { user_id: "ghost" } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: true, reason: "unknown_user" });
    expect(rows(DB)).toHaveLength(0);
    expect(S.calls).toHaveLength(0);
  });

  it("is idempotent by payment intent", async () => {
    const { DB, env } = stripeCtx();
    const raw = JSON.stringify(checkoutEvent());
    for (let i = 0; i < 3; i++) expect((await postStripe(env, raw)).status).toBe(200);
    // async_payment_succeeded for the SAME session is the same purchase.
    expect((await post(env, checkoutEvent({ event: { type: "checkout.session.async_payment_succeeded" } }))).status).toBe(200);
    expect(rows(DB)).toHaveLength(1);
  });

  it("a delayed method: `completed` unpaid grants nothing, `async_payment_succeeded` grants", async () => {
    const { DB, env } = stripeCtx();
    const first = await post(env, checkoutEvent({ session: { payment_status: "unpaid" } }));
    expect(await first.json()).toMatchObject({ ignored: true, reason: "not_paid" });
    expect(rows(DB)).toHaveLength(0);

    const later = await post(env, checkoutEvent({ event: { id: "evt_later", type: "checkout.session.async_payment_succeeded" } }));
    expect(later.status).toBe(200);
    expect(await later.json()).toEqual({ ok: true, plus: true });
    expect(rows(DB)).toHaveLength(1);
  });

  it("an apple and a stripe entitlement coexist and both report", async () => {
    const { DB, env } = stripeCtx();
    H.stub = async () => validTx();
    await postApple(env, "x");
    await post(env, checkoutEvent());
    expect(await plusSources(env as never, "u1")).toEqual(["apple", "stripe"]);
    expect(rows(DB)).toHaveLength(2);
  });

  it("grants are recorded even while PLUS_ENABLED and the surface are off", async () => {
    // Refusing to RECORD a payment already taken would be far worse than
    // recording one that is not yet useful.
    const { DB, env } = stripeCtx({ PLUS_ENABLED: "false", PLUS_SURFACE_ENABLED: "false" });
    expect((await post(env, checkoutEvent())).status).toBe(200);
    expect(rows(DB)).toHaveLength(1);
  });
});

describe("POST /api/billing/stripe — re-reading the payment before granting", () => {
  it("asks for exactly the event's payment intent, with the charge expanded, pinned and authenticated", async () => {
    const { env } = stripeCtx();
    await post(env, checkoutEvent());
    expect(S.calls).toHaveLength(1);
    const call = S.calls[0]!;
    const u = new URL(call.url);
    expect(call.method).toBe("GET");
    expect(u.origin + u.pathname).toBe(`https://api.stripe.com/v1/payment_intents/${PI}`);
    expect([...u.searchParams.entries()]).toEqual([["expand[]", "latest_charge"]]);
    expect(call.headers.get("Authorization")).toBe(`Bearer ${SK}`);
    expect(call.headers.get("Stripe-Version")).toBe("2026-04-22.dahlia");
    expect(call.signal).toBeInstanceOf(AbortSignal);
  });

  it("a charge refunded BEFORE the grant arrived grants nothing", async () => {
    // The hole the re-read closes: grant webhook delayed (endpoint down, Stripe
    // retrying), refund issued meanwhile, refund event finds no row to
    // tombstone — and the late grant would hand out Plus for free.
    const { DB, env } = stripeCtx();
    S.pi = (id) => piReply(id, {}, { refunded: true, amount_refunded: 499 });
    const res = await post(env, checkoutEvent());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: true, reason: "refunded" });
    expect(rows(DB)).toHaveLength(0);
  });

  it("CONTROL: a PARTIAL refund still grants (only a full refund revokes)", async () => {
    const { DB, env } = stripeCtx();
    S.pi = (id) => piReply(id, {}, { refunded: false, amount_refunded: 100 });
    expect((await post(env, checkoutEvent())).status).toBe(200);
    expect(liveRows(DB)).toHaveLength(1);
  });

  it("a DISPUTED charge still grants — only a LOST dispute revokes", async () => {
    // Disputes take weeks to close and Stripe stops retrying after three days.
    // Refusing here would strand a paying customer whose dispute is then won;
    // a lost dispute arrives as charge.dispute.closed and revokes the row.
    const { DB, env } = stripeCtx();
    S.pi = (id) => piReply(id, {}, { disputed: true });
    expect((await post(env, checkoutEvent())).status).toBe(200);
    expect(liveRows(DB)).toHaveLength(1);
  });

  for (const status of ["processing", "requires_action", "requires_confirmation", "requires_capture", "some_future_status"]) {
    it(`a payment intent still ${status} 503s so Stripe retries, and writes nothing`, async () => {
      const { DB, env } = stripeCtx();
      S.pi = (id) => piReply(id, { status, latest_charge: null });
      const res = await post(env, checkoutEvent());
      expect(res.status).toBe(503);
      expect(rows(DB)).toHaveLength(0);
    });
  }

  it("processing → 503, then the retry after it succeeds grants", async () => {
    const { DB, env } = stripeCtx();
    const raw = JSON.stringify(checkoutEvent());
    S.pi = (id) => piReply(id, { status: "processing", latest_charge: null });
    expect((await postStripe(env, raw)).status).toBe(503);
    expect(rows(DB)).toHaveLength(0);
    S.pi = (id) => piReply(id);
    expect((await postStripe(env, raw)).status).toBe(200);
    expect(liveRows(DB)).toHaveLength(1);
  });

  for (const [status, reason] of [
    ["canceled", "payment_canceled"],
    ["requires_payment_method", "payment_failed"],
  ] as const) {
    it(`a payment intent that is ${status} is a final no (200), not a retry`, async () => {
      const { DB, env } = stripeCtx();
      S.pi = (id) => piReply(id, { status, latest_charge: null });
      const res = await post(env, checkoutEvent());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, ignored: true, reason });
      expect(rows(DB)).toHaveLength(0);
    });
  }

  it("succeeded with the charge NOT expanded is an anomaly: 503, not a grant", async () => {
    const { DB, env } = stripeCtx();
    S.pi = (id) => piReply(id, { latest_charge: "ch_3KaleidoscopePlus01" });
    expect((await post(env, checkoutEvent())).status).toBe(503);
    S.pi = (id) => piReply(id, { latest_charge: null });
    expect((await post(env, checkoutEvent())).status).toBe(503);
    expect(rows(DB)).toHaveLength(0);
  });

  it("a Stripe 500 → 503 and no row; the retry then grants", async () => {
    const { DB, env } = stripeCtx();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    S.pi = () => jsonResponse(500, { error: { type: "api_error" } });
    expect((await post(env, checkoutEvent())).status).toBe(503);
    expect(rows(DB)).toHaveLength(0);
    // Logged with ids, never the key.
    const logged = JSON.stringify(err.mock.calls);
    expect(logged).toContain(PI);
    expect(logged).not.toContain(SK);

    S.pi = (id) => piReply(id);
    expect((await post(env, checkoutEvent())).status).toBe(200);
    expect(rows(DB)).toHaveLength(1);
  });

  it("a 2xx whose body is not JSON → 503, never read as an empty object", async () => {
    const { DB, env } = stripeCtx();
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Asserted by BODY, not just status: read as `{}`, the missing status would
    // also 503 (as payment_pending), and the test could not tell the two apart.
    for (const body of ["<html>gateway</html>", "[]", "null"]) {
      S.pi = () => new Response(body, { status: 200 });
      const res = await post(env, checkoutEvent());
      expect(res.status, body).toBe(503);
      expect(await res.json(), body).toEqual({ error: "stripe_unavailable" });
    }
    expect(rows(DB)).toHaveLength(0);
  });

  it("a network failure or timeout → 503", async () => {
    const { DB, env } = stripeCtx();
    vi.spyOn(console, "error").mockImplementation(() => {});
    S.pi = () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    };
    expect((await post(env, checkoutEvent())).status).toBe(503);
    expect(rows(DB)).toHaveLength(0);
  });

  it("503s without calling Stripe when STRIPE_SECRET_KEY is unset — the payment cannot be confirmed", async () => {
    for (const key of [undefined, "", "  ", "pk_live_publishable"]) {
      const { DB, env } = stripeCtx({ STRIPE_SECRET_KEY: key });
      vi.spyOn(console, "error").mockImplementation(() => {});
      const res = await post(env, checkoutEvent());
      expect(res.status, String(key)).toBe(503);
      expect(rows(DB)).toHaveLength(0);
    }
    expect(S.calls).toHaveLength(0);
  });
});

describe("POST /api/billing/stripe — refunds and disputes", () => {
  it("a FULL refund tombstones the row: kept for support, no longer live", async () => {
    const { DB, env } = stripeCtx();
    await post(env, checkoutEvent());
    expect(liveRows(DB)).toHaveLength(1);
    const before = S.calls.length;

    const res = await post(env, refundEvent());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removed: true });
    expect(rows(DB)).toHaveLength(1);
    expect(liveRows(DB)).toHaveLength(0);
    expect(await hasPlus(env as never, "u1")).toBe(false);
    // Revocation acts on the signed event alone; it never needs a re-read.
    expect(S.calls.length).toBe(before);
  });

  it("a PARTIAL refund does not revoke", async () => {
    const { DB, env } = stripeCtx();
    await post(env, checkoutEvent());
    const res = await post(env, refundEvent({ refunded: false, amount_refunded: 100 }));
    expect(await res.json()).toEqual({ ok: true, ignored: true, reason: "partial_refund" });
    expect(liveRows(DB)).toHaveLength(1);
  });

  it("an UNSIGNED refund cannot revoke", async () => {
    const { DB, env } = stripeCtx();
    await post(env, checkoutEvent());
    expect((await postStripe(env, JSON.stringify(refundEvent()), { secret: "whsec_attacker" })).status).toBe(401);
    expect(liveRows(DB)).toHaveLength(1);
  });

  it("a refund of one payment intent leaves another's row alone", async () => {
    const { DB, env } = stripeCtx();
    await post(env, checkoutEvent());
    await post(
      env,
      checkoutEvent({
        event: { id: "evt_u2" },
        session: { id: "cs_live_u2", payment_intent: "pi_3OtherPurchase02", client_reference_id: "u2" },
        metadata: { user_id: "u2" },
      }),
    );
    expect(rows(DB)).toHaveLength(2);
    await post(env, refundEvent());
    expect(rows(DB)).toHaveLength(2);
    const live = liveRows(DB);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ external_id: "pi_3OtherPurchase02", user_id: "u2" });
  });

  it("a LOST dispute revokes", async () => {
    const { DB, env } = stripeCtx();
    await post(env, checkoutEvent());
    const res = await post(env, disputeEvent());
    expect(await res.json()).toEqual({ ok: true, removed: true });
    expect(liveRows(DB)).toHaveLength(0);
  });

  for (const status of ["won", "warning_closed", "needs_response", undefined]) {
    it(`CONTROL: a dispute closed as ${String(status)} does not`, async () => {
      const { DB, env } = stripeCtx();
      await post(env, checkoutEvent());
      const res = await post(env, disputeEvent({ status }));
      expect(await res.json()).toEqual({ ok: true, ignored: true, reason: "dispute_not_lost" });
      expect(liveRows(DB)).toHaveLength(1);
    });
  }

  it("a refund event whose object is not a charge does not revoke", async () => {
    const { DB, env } = stripeCtx();
    await post(env, checkoutEvent());
    const res = await post(env, refundEvent({ object: "refund" }));
    expect(await res.json()).toMatchObject({ ignored: true, reason: "not_a_charge" });
    expect(liveRows(DB)).toHaveLength(1);
  });

  it("a refund with no payment_intent does not revoke anything", async () => {
    const { DB, env } = stripeCtx();
    await post(env, checkoutEvent());
    const res = await post(env, refundEvent({ payment_intent: null }));
    expect(await res.json()).toMatchObject({ ignored: true, reason: "missing_payment_intent" });
    expect(liveRows(DB)).toHaveLength(1);
  });

  it("a refund for an UNKNOWN payment intent changes nothing and inserts no placeholder", async () => {
    const { DB, env } = stripeCtx();
    const res = await post(env, refundEvent({ payment_intent: "pi_never_granted" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removed: false });
    expect(rows(DB)).toHaveLength(0);
  });
});

// ==========================================================================
// 5. GET /api/billing/checkout
// ==========================================================================

/** Everything checkout needs. Shared with the section-2 budget test. */
const READY = {
  // The SURFACE flag gates checkout, not cap enforcement: if the paywall is
  // visible the buy button behind it has to work (REVIEW L1 split them).
  PLUS_SURFACE_ENABLED: "true",
  STRIPE_SECRET_KEY: SK,
  STRIPE_PRICE_ID: PRICE,
};

describe("GET /api/billing/checkout", () => {
  const get = (env: unknown, sid: string | null = "s1") =>
    app.request(
      "/api/billing/checkout",
      { headers: sid ? bearer(sid) : {} },
      env as never,
    );

  const checkoutCalls = () => S.calls.filter((c) => c.url.includes("/v1/checkout/sessions"));

  // REVIEW.md minor mB5 — this GET SPENDS something: a 10/h budget and a
  // Stripe API call.
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
    expect(S.calls).toHaveLength(0);

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
    for (let i = 0; i < 20; i++) {
      const res = await app.request(
        "/api/billing/checkout",
        { headers: { Cookie: "__Host-kld_session=s1" } },
        env as never,
      );
      expect(res.status).toBe(403);
    }
    expect(S.calls).toHaveLength(0);
    expect((await get(env)).status).toBe(200);
  });

  it("CONTROL: a bearer caller needs no token, since it carries no ambient credential", async () => {
    const { env } = ctx(READY);
    expect((await get(env)).status).toBe(200);
  });

  it("returns the hosted Checkout Session URL Stripe handed back", async () => {
    const { env } = ctx(READY);
    const res = await get(env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: CHECKOUT_URL });
  });

  it("creates the session with EXACTLY the Managed Payments parameters, and nothing else", async () => {
    const { env } = ctx(READY);
    await get(env);
    expect(checkoutCalls()).toHaveLength(1);
    const params = new URLSearchParams(checkoutCalls()[0]!.body);
    // The full set, sorted: an added parameter fails this as surely as a
    // missing one. Managed Payments REJECTS a list of otherwise-ordinary ones.
    expect([...params.entries()].sort()).toEqual(
      [
        ["mode", "payment"],
        ["line_items[0][price]", PRICE],
        ["line_items[0][quantity]", "1"],
        ["managed_payments[enabled]", "true"],
        ["client_reference_id", "u1"],
        ["metadata[app]", "kaleidoscope"],
        ["metadata[product]", "plus"],
        ["metadata[user_id]", "u1"],
        ["payment_intent_data[metadata][app]", "kaleidoscope"],
        ["payment_intent_data[metadata][product]", "plus"],
        ["payment_intent_data[metadata][user_id]", "u1"],
        ["success_url", `${BASE}/?plus=thanks`],
        ["cancel_url", `${BASE}/`],
      ].sort(),
    );
    // Named, so a regression reads as the rule it breaks: each of these is
    // forbidden alongside managed_payments, and ui_mode stays the hosted default.
    for (const forbidden of ["automatic_tax", "payment_method_types", "ui_mode", "customer_update", "tax_id_collection"]) {
      expect([...params.keys()].some((k) => k.startsWith(forbidden)), forbidden).toBe(false);
    }
  });

  it("authenticates with the secret key as a Bearer, pins the API version, form-encodes, and times out", async () => {
    const { env } = ctx(READY);
    await get(env);
    const call = checkoutCalls()[0]!;
    expect(call.method).toBe("POST");
    expect(call.url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect(call.headers.get("Authorization")).toBe(`Bearer ${SK}`);
    expect(call.headers.get("Stripe-Version")).toBe("2026-04-22.dahlia");
    expect(call.headers.get("Content-Type")).toBe("application/x-www-form-urlencoded");
    expect(call.signal).toBeInstanceOf(AbortSignal);
  });

  it("trims whitespace around the configured key and price", async () => {
    const { env } = ctx({ ...READY, STRIPE_SECRET_KEY: ` ${SK}\n`, STRIPE_PRICE_ID: ` ${PRICE} ` });
    expect((await get(env)).status).toBe(200);
    const call = checkoutCalls()[0]!;
    expect(call.headers.get("Authorization")).toBe(`Bearer ${SK}`);
    expect(new URLSearchParams(call.body).get("line_items[0][price]")).toBe(PRICE);
  });

  it("the session it creates is one the webhook actually attributes", async () => {
    // Closes the loop: build the webhook from what checkout really SENT, rather
    // than trusting the two halves separately.
    const { DB, env } = ctx({ ...READY, STRIPE_WEBHOOK_SECRET: WHSEC });
    await get(env);
    const params = new URLSearchParams(checkoutCalls()[0]!.body);
    const meta = {
      app: params.get("metadata[app]"),
      product: params.get("metadata[product]"),
      user_id: params.get("metadata[user_id]"),
    };
    const res = await post(
      env,
      checkoutEvent({ session: { client_reference_id: params.get("client_reference_id") }, metadata: meta }),
    );
    expect(res.status).toBe(200);
    expect(rows(DB)[0]).toMatchObject({ user_id: "u1", source: "stripe", external_id: PI });
  });

  it("requires authentication", async () => {
    const { env } = ctx(READY);
    expect((await get(env, null)).status).toBe(401);
    expect(S.calls).toHaveLength(0);
  });

  it("503s while the Plus surface is off", async () => {
    const { env } = ctx({ ...READY, PLUS_SURFACE_ENABLED: "false" });
    const res = await get(env);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "not_enabled" });
    expect(S.calls).toHaveLength(0);
  });

  // The review window: caps off, surface on.
  it("sells while the surface is on even though caps are not enforced", async () => {
    const { env } = ctx({ ...READY, PLUS_ENABLED: "false" });
    const res = await get(env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { url: string }).url).toBe(CHECKOUT_URL);
  });

  describe("configuration", () => {
    const unconfigured: [string, Record<string, unknown>][] = [
      ["no price", { STRIPE_PRICE_ID: "" }],
      ["a blank price", { STRIPE_PRICE_ID: "   " }],
      ["a price that is not a price_ id", { STRIPE_PRICE_ID: "prod_KaleidoscopePlus" }],
      ["no key", { STRIPE_SECRET_KEY: undefined }],
      ["a blank key", { STRIPE_SECRET_KEY: "  " }],
      ["a publishable key", { STRIPE_SECRET_KEY: "pk_live_kaleidoscope" }],
      ["a garbage key", { STRIPE_SECRET_KEY: "hunter2" }],
      ["a TEST key without PLUS_ALLOW_TEST", { STRIPE_SECRET_KEY: "sk_test_kaleidoscope" }],
      ["a restricted TEST key without PLUS_ALLOW_TEST", { STRIPE_SECRET_KEY: "rk_test_kaleidoscope" }],
    ];
    for (const [name, over] of unconfigured) {
      it(`503 not_configured for ${name}, without calling Stripe`, async () => {
        // A test key on a deploy that cannot grant test payments would send
        // real visitors to a checkout that takes their card and grants nothing.
        const { env } = ctx({ ...READY, ...over });
        const res = await get(env);
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ error: "not_configured" });
        expect(S.calls).toHaveLength(0);
      });
    }

    const configured: [string, Record<string, unknown>][] = [
      ["a test key WITH PLUS_ALLOW_TEST", { STRIPE_SECRET_KEY: "sk_test_kaleidoscope", PLUS_ALLOW_TEST: "true" }],
      ["a live key without PLUS_ALLOW_TEST", { STRIPE_SECRET_KEY: "sk_live_kaleidoscope" }],
      ["a restricted live key", { STRIPE_SECRET_KEY: "rk_live_kaleidoscope" }],
    ];
    for (const [name, over] of configured) {
      it(`CONTROL: ${name} is configured`, async () => {
        const { env } = ctx({ ...READY, ...over });
        expect((await get(env)).status).toBe(200);
        expect(checkoutCalls()).toHaveLength(1);
      });
    }
  });

  // A permanent condition must not burn the retry budget (minor).
  it("keeps answering not_configured however many times it is asked", async () => {
    const { env } = ctx({ ...READY, STRIPE_PRICE_ID: "" });
    for (let i = 0; i < 15; i++) {
      const res = await get(env);
      expect(res.status, `attempt ${i + 1}`).toBe(503);
      expect(await res.json()).toEqual({ error: "not_configured" });
    }
    expect(S.calls).toHaveLength(0);
  });

  it("rate-limits at 10/h, and the 11th does not reach Stripe", async () => {
    const { env } = ctx(READY);
    for (let i = 0; i < 10; i++) expect((await get(env)).status).toBe(200);
    expect((await get(env)).status).toBe(429);
    expect(checkoutCalls()).toHaveLength(10);
  });

  it("a Stripe error → 502 checkout_failed, logged without the key", async () => {
    const { env } = ctx(READY);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    S.checkout = () => jsonResponse(400, { error: { type: "invalid_request_error", code: "parameter_unknown" } });
    const res = await get(env);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "checkout_failed" });
    expect(err).toHaveBeenCalled();
    const logged = JSON.stringify(err.mock.calls);
    expect(logged).toContain("parameter_unknown");
    expect(logged).not.toContain(SK);
  });

  it("a Stripe 500, a network failure, or a non-JSON 2xx → 502", async () => {
    const { env } = ctx(READY);
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const reply of [
      () => jsonResponse(500, { error: { type: "api_error" } }),
      () => {
        throw new TypeError("fetch failed");
      },
      () => new Response("<html>", { status: 200 }),
    ]) {
      S.checkout = reply;
      expect((await get(env)).status).toBe(502);
    }
  });

  it("a reply with no url, or a url that is not https, → 502 rather than a broken redirect", async () => {
    const { env } = ctx(READY);
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const url of [undefined, null, "", "http://checkout.stripe.com/c/pay/x", "javascript:alert(1)"]) {
      S.checkout = () => jsonResponse(200, { id: "cs_1", object: "checkout.session", url });
      const res = await get(env);
      expect(res.status, String(url)).toBe(502);
      expect(await res.json()).toEqual({ error: "checkout_failed" });
    }
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
      ["/api/billing/stripe", { method: "POST" }],
      ["/api/billing/checkout", {}],
    ] as const) {
      const res = await app.request(path, init, env as never);
      expect(res.status).not.toBe(404);
    }
    // …and a genuinely unknown billing path still 404s.
    expect((await app.request("/api/billing/nope", {}, env as never)).status).toBe(404);
  });

  it("the Lemon Squeezy webhook is gone, not left answering", async () => {
    const { env } = ctx();
    const res = await app.request("/api/billing/lemonsqueezy", { method: "POST", body: "{}" }, env as never);
    expect(res.status).toBe(404);
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

  // M2. Stripe retries a grant event for up to three days, and the dashboard
  // (and `stripe events resend`) can send it again. The resend is correctly
  // signed and freshly timestamped, so the tombstone is the only thing that
  // can tell it from the original.
  it("Stripe: completed → charge.refunded → the resent completed", async () => {
    const { DB, env } = stripeCtx();
    const created = JSON.stringify(checkoutEvent());

    expect((await postStripe(env, created)).status).toBe(200);
    expect(await hasPlus(env as never, "u1")).toBe(true);

    expect((await post(env, refundEvent())).status).toBe(200);
    expect(await hasPlus(env as never, "u1")).toBe(false);

    const callsBefore = S.calls.length;
    const retry = await postStripe(env, created); // the same event, re-signed
    expect(retry.status).toBe(200); // 200 on purpose: a non-2xx makes Stripe retry
    expect(await retry.json()).toEqual({ ok: true, ignored: true, reason: "revoked" });
    expect(await hasPlus(env as never, "u1")).toBe(false);
    expect(liveRows(DB)).toHaveLength(0);
    // Refused on our own tombstone, before any re-read was spent on it.
    expect(S.calls.length).toBe(callsBefore);
  });

  it("Stripe: a LOST dispute is just as final", async () => {
    const { DB, env } = stripeCtx();
    await post(env, checkoutEvent());
    await post(env, disputeEvent());
    const retry = await post(env, checkoutEvent({ event: { type: "checkout.session.async_payment_succeeded" } }));
    expect(await retry.json()).toEqual({ ok: true, ignored: true, reason: "revoked" });
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

// Minor list — a purchase refunded BEFORE its grant was processed. The refund
// event finds no row (and inserts no placeholder), so the tombstone cannot catch
// the late grant; only the re-read of the payment can.
describe("a purchase refunded before its grant arrives does not grant", () => {
  it("refund first, delayed grant second: nothing is granted", async () => {
    const { DB, env } = stripeCtx();
    expect(await (await post(env, refundEvent())).json()).toEqual({ ok: true, removed: false });
    expect(rows(DB)).toHaveLength(0);

    // The grant event still says `paid` — it is a snapshot from before the refund.
    S.pi = (id) => piReply(id, {}, { refunded: true, amount_refunded: 499 });
    const res = await post(env, checkoutEvent());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: true, reason: "refunded" });
    expect(rows(DB)).toHaveLength(0);
  });

  it("CONTROL: the same two events, but the re-read shows the charge unrefunded: grants", async () => {
    // Proves the refusal above comes from the re-read and not from the earlier
    // refund event having left some trace behind.
    const { DB, env } = stripeCtx();
    await post(env, refundEvent());
    expect((await post(env, checkoutEvent())).status).toBe(200);
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
