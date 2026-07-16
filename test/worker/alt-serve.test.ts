// Contract check: every artwork read path returns `altText` as a non-empty
// string — the stored AI value when present, else the deterministic template
// fallback (covering legacy rows where alt_text IS NULL).

import { describe, it, expect } from "vitest";
import app from "../../src/worker/index";
import { makeD1, makeKV, makeR2, makeEnv } from "./helpers";

function seed(db: ReturnType<typeof makeD1>, sessions: ReturnType<typeof makeKV>) {
  const now = Date.now();
  db._db
    .prepare(
      `INSERT INTO users (id, google_sub, apple_sub, email, name, avatar_url, role, flagged, created_at, last_seen_at)
       VALUES ('u1','g1',NULL,'a@b.com','Anmol',NULL,'user',0,?,?)`,
    )
    .run(now, now);
  sessions.store.set("sid1", JSON.stringify({ userId: "u1", csrf: "csrf1", createdAt: now }));

  // art1: AI alt already stored. art2: legacy row, alt_text NULL → template fallback.
  db._db
    .prepare(
      `INSERT INTO artworks (id, user_id, title, visibility, image_key, thumb_key, vector_key, width, height, segments, mirror, palette, remix_of, likes, created_at, alt_text)
       VALUES ('art1','u1','Piece One','public','img/art1.webp','thumb/art1.webp','vec/art1.json.gz',1024,1024,12,1,?, NULL,0,?, 'A dense swirl of crane orange and teal.')`,
    )
    .run(JSON.stringify(["#E84A27", "#2E5E8C"]), now);
  db._db
    .prepare(
      `INSERT INTO artworks (id, user_id, title, visibility, image_key, thumb_key, vector_key, width, height, segments, mirror, palette, remix_of, likes, created_at, alt_text)
       VALUES ('art2','u1','Piece Two','public','img/art2.webp','thumb/art2.webp','vec/art2.json.gz',1024,1024,6,0,?, NULL,0,?, NULL)`,
    )
    .run(JSON.stringify(["#3FA34D"]), now - 1);
}

function env() {
  const DB = makeD1();
  const SESSIONS = makeKV();
  seed(DB, SESSIONS);
  return makeEnv({ DB, SESSIONS, ART: makeR2(), RATELIMIT: makeKV() });
}

describe("altText contract across read paths", () => {
  it("GET /api/artworks/:id returns the stored AI value", async () => {
    const res = await app.request("/api/artworks/art1", {}, env());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { altText: string };
    expect(body.altText).toBe("A dense swirl of crane orange and teal.");
  });

  it("GET /api/artworks/:id falls back to a non-empty template for a NULL row", async () => {
    const res = await app.request("/api/artworks/art2", {}, env());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { altText: string };
    expect(typeof body.altText).toBe("string");
    expect(body.altText.length).toBeGreaterThan(0);
    expect(body.altText).toBe("6-fold rotational mandala in green");
  });

  it("GET /api/gallery includes a non-empty altText on every item", async () => {
    const res = await app.request("/api/gallery", {}, env());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { id: string; altText: string }[] };
    expect(body.items.length).toBe(2);
    for (const item of body.items) {
      expect(typeof item.altText).toBe("string");
      expect(item.altText.length).toBeGreaterThan(0);
    }
  });

  it("GET /api/users/me/artworks includes a non-empty altText on every item", async () => {
    const res = await app.request(
      "/api/users/me/artworks",
      { headers: { Authorization: "Bearer sid1" } },
      env(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { id: string; altText: string }[] };
    expect(body.items.length).toBe(2);
    for (const item of body.items) {
      expect(item.altText.length).toBeGreaterThan(0);
    }
  });
});
