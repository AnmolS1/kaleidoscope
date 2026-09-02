// REVIEW.md minor — "likes are unbounded per user".
//
// `artworks.likes` was a bare counter the route bumped on every POST, with no
// record of who pressed it. The hourly rate limit shaped a single account's
// climb into a slower one; it did not cap it. Migration 0007 adds the missing
// half, and the route becomes idempotent.

import { describe, it, expect } from "vitest";
import app from "../../src/worker/index";
import { makeD1, makeKV, makeR2, makeEnv, seedUser, seedArtwork, seedSession, bearer } from "./helpers";

function ctx() {
  const DB = makeD1();
  const SESSIONS = makeKV();
  const ART = makeR2();
  const RATELIMIT = makeKV();
  seedUser(DB, "u1");
  seedUser(DB, "u2", { name: "Other Person" });
  seedSession(SESSIONS, "s1", "u1");
  seedSession(SESSIONS, "s2", "u2");
  seedArtwork(DB, { id: "a1", user_id: "u1", visibility: "public" });
  return { DB, SESSIONS, env: makeEnv({ DB, SESSIONS, ART, RATELIMIT }) };
}

const like = (env: unknown, sid: string) =>
  app.request("/api/artworks/a1/like", { method: "POST", headers: bearer(sid) }, env as never);

const count = (DB: { _db: { prepare(q: string): { get(...a: unknown[]): unknown } } }) =>
  (DB._db.prepare("SELECT likes FROM artworks WHERE id = 'a1'").get() as { likes: number }).likes;

describe("POST /api/artworks/:id/like", () => {
  it("counts one person once, however many times they press", async () => {
    const { DB, env } = ctx();

    const first = await like(env, "s1");
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ likes: 1 });

    for (let i = 0; i < 5; i++) {
      const again = await like(env, "s1");
      // 200, not an error: the button has nothing useful to say about "you
      // already did that", and a failure here would read as a broken request.
      expect(again.status).toBe(200);
      expect(await again.json()).toEqual({ likes: 1 });
    }
    expect(count(DB)).toBe(1);
  });

  it("CONTROL: two different people are two likes", async () => {
    const { DB, env } = ctx();
    await like(env, "s1");
    await like(env, "s2");
    expect(count(DB)).toBe(2);
  });

  it("is keyed on the PERSON, not the session", async () => {
    const { DB, SESSIONS, env } = ctx();
    seedSession(SESSIONS, "s1b", "u1"); // same person, second device
    await like(env, "s1");
    await like(env, "s1b");
    // A session-keyed implementation passes every other test in this file and
    // fails this one, which is why it is here.
    expect(count(DB)).toBe(1);
  });

  it("records who liked what, so the count is reconstructable", async () => {
    const { DB, env } = ctx();
    await like(env, "s1");
    await like(env, "s2");
    const rows = DB._db
      .prepare("SELECT artwork_id, user_id FROM artwork_likes ORDER BY user_id")
      .all() as Array<{ artwork_id: string; user_id: string }>;
    expect(rows).toEqual([
      { artwork_id: "a1", user_id: "u1" },
      { artwork_id: "a1", user_id: "u2" },
    ]);
  });

  it("still refuses a piece the caller cannot see", async () => {
    const { DB, env } = ctx();
    seedArtwork(DB, { id: "a2", user_id: "u2", visibility: "private" });
    const res = await app.request(
      "/api/artworks/a2/like",
      { method: "POST", headers: bearer("s1") },
      env as never,
    );
    expect(res.status).toBe(404);
  });
});
