import { describe, it, expect, afterEach } from "vitest";
import app from "../../src/worker/index";
import { makeD1, makeKV, makeR2, makeEnv } from "./helpers";

const VALID_DRAWING = JSON.stringify({
  v: 1,
  bg: "light",
  sym: { segments: 6, mirror: true },
  strokes: [{ tool: "solid", color: "#ff0000", size: 10, opacity: 1, pts: [[0, 0, 0.5], [0.1, 0.1, 0.5]] }],
});

function seedUserSession(db: ReturnType<typeof makeD1>, sessions: ReturnType<typeof makeKV>) {
  const now = Date.now();
  db._db
    .prepare(
      `INSERT INTO users (id, google_sub, apple_sub, email, name, avatar_url, role, flagged, created_at, last_seen_at)
       VALUES ('u1','g1',NULL,'a@b.com','Anmol',NULL,'user',0,?,?)`,
    )
    .run(now, now);
  sessions.store.set("sid1", JSON.stringify({ userId: "u1", csrf: "csrf1", createdAt: now }));
  return { sid: "sid1", csrf: "csrf1" };
}

function saveForm(withTurnstile: boolean) {
  const fd = new FormData();
  fd.set("drawing", VALID_DRAWING);
  fd.set("image", new File([new Uint8Array([1, 2, 3])], "image.png", { type: "image/png" }));
  fd.set("thumb", new File([new Uint8Array([4, 5, 6])], "thumb.png", { type: "image/png" }));
  fd.set("title", "My piece");
  fd.set("visibility", "public");
  fd.set("width", "1024");
  fd.set("height", "1024");
  if (withTurnstile) fd.set("turnstile", "some-token");
  return fd;
}

describe("POST /api/artworks — native (Bearer) save", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("saves via Bearer with NO turnstile token and never calls the Turnstile API", async () => {
    const DB = makeD1();
    const SESSIONS = makeKV();
    const ART = makeR2();
    const { sid } = seedUserSession(DB, SESSIONS);
    const env = makeEnv({ DB, SESSIONS, ART, RATELIMIT: makeKV() });

    let turnstileCalled = false;
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes("siteverify")) turnstileCalled = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const res = await app.request(
      "/api/artworks",
      { method: "POST", headers: { Authorization: `Bearer ${sid}` }, body: saveForm(false) },
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; url: string };
    expect(body.id).toBeTruthy();
    expect(turnstileCalled).toBe(false);

    // Row persisted with derived metadata.
    const row = DB._db.prepare("SELECT * FROM artworks WHERE id = ?").get(body.id) as {
      user_id: string;
      segments: number;
      mirror: number;
    };
    expect(row.user_id).toBe("u1");
    expect(row.segments).toBe(6);
    expect(row.mirror).toBe(1);
    // Vector + renders written to R2.
    expect(ART.store.has(`vec/${body.id}.json.gz`)).toBe(true);
    expect(ART.store.has(`img/${body.id}.webp`)).toBe(true);
  });

  it("still enforces Turnstile for cookie (web) auth — empty token → 403", async () => {
    const DB = makeD1();
    const SESSIONS = makeKV();
    const { sid } = seedUserSession(DB, SESSIONS);
    const env = makeEnv({ DB, SESSIONS, ART: makeR2(), RATELIMIT: makeKV() });

    const res = await app.request(
      "/api/artworks",
      {
        method: "POST",
        headers: { Cookie: `__Host-kld_session=${sid}`, "X-CSRF-Token": "csrf1" },
        body: saveForm(false), // no turnstile
      },
      env,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "turnstile_failed" });
  });
});

describe("DELETE /api/me — account deletion", () => {
  it("removes artwork blobs + avatar + user row (cascading artworks) + session", async () => {
    const DB = makeD1({ foreignKeys: true });
    const SESSIONS = makeKV();
    const ART = makeR2();
    const now = Date.now();
    DB._db
      .prepare(
        `INSERT INTO users (id, google_sub, apple_sub, email, name, avatar_url, role, flagged, created_at, last_seen_at)
         VALUES ('u1','g1',NULL,'a@b.com','Anmol',NULL,'user',0,?,?)`,
      )
      .run(now, now);
    for (const id of ["art1", "art2"]) {
      DB._db
        .prepare(
          `INSERT INTO artworks (id, user_id, title, visibility, image_key, thumb_key, vector_key, width, height, segments, mirror, palette, remix_of, likes, created_at)
           VALUES (?, 'u1','T','public',?,?,?,1024,1024,6,1,NULL,NULL,0,?)`,
        )
        .run(id, `img/${id}.webp`, `thumb/${id}.webp`, `vec/${id}.json.gz`, now);
    }
    SESSIONS.store.set("sid1", JSON.stringify({ userId: "u1", csrf: "csrf1", createdAt: now }));
    const env = makeEnv({ DB, SESSIONS, ART });

    const res = await app.request(
      "/api/me",
      { method: "DELETE", headers: { Authorization: `Bearer sid1` } },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // User + artworks gone (cascade).
    expect((DB._db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n).toBe(0);
    expect((DB._db.prepare("SELECT COUNT(*) AS n FROM artworks").get() as { n: number }).n).toBe(0);
    // R2 blobs for both artworks + the avatar were deleted.
    for (const id of ["art1", "art2"]) {
      expect(ART.deleted).toContain(`vec/${id}.json.gz`);
      expect(ART.deleted).toContain(`img/${id}.webp`);
      expect(ART.deleted).toContain(`thumb/${id}.webp`);
      expect(ART.deleted).toContain(`og/${id}.webp`);
    }
    expect(ART.deleted).toContain("avatar/u1");
    // Session revoked.
    expect(SESSIONS.store.has("sid1")).toBe(false);
  });
});
