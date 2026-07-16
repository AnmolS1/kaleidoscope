import { describe, it, expect, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import app from "../../src/worker/index";
import { makeD1, makeKV, makeEnv } from "./helpers";

// A stored session + its user, seeded into the D1 + SESSIONS fakes.
function seedSession(db: ReturnType<typeof makeD1>, sessions: ReturnType<typeof makeKV>) {
  const now = Date.now();
  db._db
    .prepare(
      `INSERT INTO users (id, google_sub, apple_sub, email, name, avatar_url, role, flagged, created_at, last_seen_at)
       VALUES ('u1','g1',NULL,'a@b.com','Anmol',NULL,'user',0,?,?)`,
    )
    .run(now, now);
  const sid = "session-id-abc";
  const csrf = "csrf-token-xyz";
  sessions.store.set(sid, JSON.stringify({ userId: "u1", csrf, createdAt: now }));
  return { sid, csrf };
}

describe("Bearer sessions + CSRF", () => {
  it("logout via Bearer succeeds without an X-CSRF-Token and revokes the session", async () => {
    const DB = makeD1();
    const SESSIONS = makeKV();
    const { sid } = seedSession(DB, SESSIONS);
    const env = makeEnv({ DB, SESSIONS });

    const res = await app.request(
      "/api/auth/logout",
      { method: "POST", headers: { Authorization: `Bearer ${sid}` } },
      env,
    );
    expect(res.status).toBe(204);
    expect(SESSIONS.store.has(sid)).toBe(false); // revoked
  });

  it("rejects a cookie-authenticated mutation with no CSRF token (403)", async () => {
    const DB = makeD1();
    const SESSIONS = makeKV();
    const { sid } = seedSession(DB, SESSIONS);
    const env = makeEnv({ DB, SESSIONS });

    const res = await app.request(
      "/api/auth/logout",
      { method: "POST", headers: { Cookie: `__Host-kld_session=${sid}` } },
      env,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "bad_csrf" });
  });

  it("accepts a cookie-authenticated mutation WITH the matching CSRF token", async () => {
    const DB = makeD1();
    const SESSIONS = makeKV();
    const { sid, csrf } = seedSession(DB, SESSIONS);
    const env = makeEnv({ DB, SESSIONS });

    const res = await app.request(
      "/api/auth/logout",
      { method: "POST", headers: { Cookie: `__Host-kld_session=${sid}`, "X-CSRF-Token": csrf } },
      env,
    );
    expect(res.status).toBe(204);
  });
});

describe("POST /api/auth/apple", () => {
  const rawNonce = "raw-nonce-123";

  async function appleSetup() {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    jwk.kid = "apple-test";
    jwk.alg = "RS256";
    jwk.use = "sig";
    const jwks = { keys: [jwk] };
    // Apple's JWKS endpoint is the only network call verifyAppleIdentityToken makes.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(jwks), { headers: { "content-type": "application/json" } })) as typeof fetch;
    return { privateKey };
  }

  async function signToken(
    privateKey: CryptoKey,
    claims: { sub: string; email?: string; email_verified?: boolean; aud?: string; nonce?: string },
  ) {
    const hashed = createHash("sha256").update(rawNonce).digest("hex");
    const body: Record<string, unknown> = { nonce: claims.nonce ?? hashed };
    if (claims.email) body.email = claims.email;
    if (claims.email_verified !== undefined) body.email_verified = claims.email_verified;
    return new SignJWT(body)
      .setProtectedHeader({ alg: "RS256", kid: "apple-test" })
      .setIssuer("https://appleid.apple.com")
      .setAudience(claims.aud ?? "dev.ponderance.kaleidoscope")
      .setSubject(claims.sub)
      .setExpirationTime("1h")
      .sign(privateKey);
  }

  afterEach(() => {
    // vitest restores nothing automatically; drop our fetch stub.
    // (Each test re-stubs in appleSetup, so this is just hygiene.)
  });

  it("creates a new Apple user on first sign-in and returns token/csrf/user", async () => {
    const { privateKey } = await appleSetup();
    const DB = makeD1();
    const SESSIONS = makeKV();
    const JWKS = makeKV();
    const env = makeEnv({ DB, SESSIONS, JWKS });

    const identityToken = await signToken(privateKey, {
      sub: "apple-sub-1",
      email: "new@icloud.com",
      email_verified: true,
    });
    const res = await app.request(
      "/api/auth/apple",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identityToken, rawNonce, name: "Apple Person" }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; csrf: string; user: { id: string; name: string } };
    expect(body.token).toBeTruthy();
    expect(body.csrf).toBeTruthy();
    expect(body.user.name).toBe("Apple Person");

    const row = DB._db.prepare("SELECT * FROM users WHERE apple_sub = 'apple-sub-1'").get() as {
      id: string;
      email: string;
      google_sub: string | null;
    };
    expect(row.email).toBe("new@icloud.com");
    expect(row.google_sub).toBeNull();
    // The returned session token is a real, resolvable session.
    expect(SESSIONS.store.has(body.token)).toBe(true);
  });

  it("links Apple to an existing Google user by verified email (no duplicate)", async () => {
    const { privateKey } = await appleSetup();
    const DB = makeD1();
    const now = Date.now();
    DB._db
      .prepare(
        `INSERT INTO users (id, google_sub, apple_sub, email, name, avatar_url, role, flagged, created_at, last_seen_at)
         VALUES ('g-user','g-sub',NULL,'shared@gmail.com','Google Name',NULL,'user',0,?,?)`,
      )
      .run(now, now);
    const env = makeEnv({ DB, SESSIONS: makeKV(), JWKS: makeKV() });

    const identityToken = await signToken(privateKey, {
      sub: "apple-sub-2",
      email: "shared@gmail.com",
      email_verified: true,
    });
    const res = await app.request(
      "/api/auth/apple",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identityToken, rawNonce }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { id: string } };
    expect(body.user.id).toBe("g-user"); // linked, not a new row

    const count = DB._db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
    expect(count.n).toBe(1);
    const row = DB._db.prepare("SELECT apple_sub, name FROM users WHERE id='g-user'").get() as {
      apple_sub: string;
      name: string;
    };
    expect(row.apple_sub).toBe("apple-sub-2");
    expect(row.name).toBe("Google Name"); // existing name preserved, not clobbered
  });

  it("rejects a token with the wrong audience (401)", async () => {
    const { privateKey } = await appleSetup();
    const env = makeEnv({ DB: makeD1(), SESSIONS: makeKV(), JWKS: makeKV() });
    const identityToken = await signToken(privateKey, { sub: "x", aud: "com.evil.app" });
    const res = await app.request(
      "/api/auth/apple",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identityToken, rawNonce }),
      },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("rejects a token whose nonce doesn't match rawNonce (401)", async () => {
    const { privateKey } = await appleSetup();
    const env = makeEnv({ DB: makeD1(), SESSIONS: makeKV(), JWKS: makeKV() });
    const identityToken = await signToken(privateKey, { sub: "x", nonce: "deadbeef" });
    const res = await app.request(
      "/api/auth/apple",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identityToken, rawNonce }),
      },
      env,
    );
    expect(res.status).toBe(401);
  });
});
