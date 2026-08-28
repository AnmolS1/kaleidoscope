// GET /api/artworks/hash/:sha — the save dialog's pre-flight. It runs the
// moment the dialog opens so the user learns "you already saved this" or
// "someone else has this drawing" BEFORE typing a title. The POST checks are
// the safety net; this is the UX.

import { describe, it, expect } from "vitest";
import app from "../../src/worker/index";
import { contentHash } from "../../src/shared/vector";
import { ogDescription } from "../../src/worker/routes/permalink";
import {
  makeD1,
  makeKV,
  makeR2,
  makeEnv,
  drawingV1,
  drawingV2MixedSym,
  seedUser,
  seedArtwork,
  seedSession,
  saveForm,
  bearer,
} from "./helpers";

const SHA_A = "a".repeat(64);

function ctx() {
  const DB = makeD1();
  const SESSIONS = makeKV();
  const RATELIMIT = makeKV();
  seedUser(DB, "u1");
  seedUser(DB, "u2", { name: "Other Person" });
  seedSession(SESSIONS, "s1", "u1");
  return { DB, RATELIMIT, env: makeEnv({ DB, SESSIONS, ART: makeR2(), RATELIMIT }) };
}

function preflight(env: unknown, sha: string, sid = "s1") {
  return app.request(`/api/artworks/hash/${sha}`, { headers: bearer(sid) }, env as never);
}

describe("GET /api/artworks/hash/:sha", () => {
  it("reports both null when nothing matches", async () => {
    const { env } = ctx();
    const res = await preflight(env, SHA_A);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mine: null, other: null });
  });

  it("reports the caller's own piece", async () => {
    const { DB, env } = ctx();
    seedArtwork(DB, { id: "mine", user_id: "u1", content_hash: SHA_A, visibility: "private" });
    expect(await (await preflight(env, SHA_A)).json()).toEqual({ mine: "mine", other: null });
  });

  it("reports another user's viewable piece with its title and author", async () => {
    const { DB, env } = ctx();
    seedArtwork(DB, {
      id: "theirs",
      user_id: "u2",
      content_hash: SHA_A,
      visibility: "public",
      title: "Ember Lattice",
    });
    expect(await (await preflight(env, SHA_A)).json()).toEqual({
      mine: null,
      other: { id: "theirs", title: "Ember Lattice", author: "Other Person" },
    });
  });

  it("treats another user's UNLISTED piece as viewable", async () => {
    // canView is `visibility !== 'private'` — unlisted means unlisted, not secret.
    const { DB, env } = ctx();
    seedArtwork(DB, { id: "theirs", user_id: "u2", content_hash: SHA_A, visibility: "unlisted" });
    const body = (await (await preflight(env, SHA_A)).json()) as { other: { id: string } | null };
    expect(body.other?.id).toBe("theirs");
  });

  it("never discloses another user's PRIVATE piece", async () => {
    const { DB, env } = ctx();
    seedArtwork(DB, { id: "secret", user_id: "u2", content_hash: SHA_A, visibility: "private" });
    expect(await (await preflight(env, SHA_A)).json()).toEqual({ mine: null, other: null });
  });

  it("reports mine and theirs together when both exist", async () => {
    const { DB, env } = ctx();
    seedArtwork(DB, { id: "mine", user_id: "u1", content_hash: SHA_A });
    seedArtwork(DB, { id: "theirs", user_id: "u2", content_hash: SHA_A, title: "T" });
    const body = (await (await preflight(env, SHA_A)).json()) as {
      mine: string;
      other: { id: string };
    };
    expect(body.mine).toBe("mine");
    expect(body.other.id).toBe("theirs");
  });

  it("rejects a malformed hash with 400 before touching the database", async () => {
    const { env } = ctx();
    for (const sha of ["nothex", "A".repeat(64), "a".repeat(63), "a".repeat(65)]) {
      const res = await preflight(env, sha);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "bad_hash" });
    }
  });

  it("401s an unauthenticated caller", async () => {
    const { env } = ctx();
    const res = await app.request(`/api/artworks/hash/${SHA_A}`, {}, env as never);
    expect(res.status).toBe(401);
  });

  it("is rate limited at 120/h", async () => {
    const { RATELIMIT, env } = ctx();
    RATELIMIT.store.set("rl:hash:u1:h", "120");
    const res = await preflight(env, SHA_A);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
  });

  it("agrees with what a subsequent save actually does", async () => {
    // The pre-flight is only worth anything if it predicts the POST. Save a
    // drawing, then ask the pre-flight about that same drawing's hash.
    const { env } = ctx();
    const d = drawingV1(42);
    const saved = await app.request(
      "/api/artworks",
      { method: "POST", headers: bearer("s1"), body: saveForm({ drawing: d }) },
      env as never,
    );
    const { id } = (await saved.json()) as { id: string };

    const body = (await (await preflight(env, await contentHash(d))).json()) as { mine: string | null };
    expect(body.mine).toBe(id);
  });

  it("finds a v2 layered piece by the hash the client would compute", async () => {
    const { env } = ctx();
    const d = drawingV2MixedSym(3);
    const saved = await app.request(
      "/api/artworks",
      { method: "POST", headers: bearer("s1"), body: saveForm({ drawing: d }) },
      env as never,
    );
    expect(saved.status).toBe(201);
    const { id } = (await saved.json()) as { id: string };
    const body = (await (await preflight(env, await contentHash(d))).json()) as { mine: string | null };
    expect(body.mine).toBe(id);
  });
});

describe("layered pieces — segments 0 metadata and copy", () => {
  it("a mixed-symmetry v2 save stores segments 0, layers 2, and layered alt text", async () => {
    const { DB, env } = ctx();
    const res = await app.request(
      "/api/artworks",
      { method: "POST", headers: bearer("s1"), body: saveForm({ drawing: drawingV2MixedSym(1) }) },
      env as never,
    );
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const row = DB._db.prepare("SELECT segments, mirror, layers, alt_text FROM artworks WHERE id=?").get(id) as {
      segments: number;
      mirror: number;
      layers: number;
      alt_text: string;
    };
    expect(row.segments).toBe(0);
    expect(row.mirror).toBe(0);
    expect(row.layers).toBe(2);
    // "0-fold rotational mandala" would be a confident, wrong description.
    expect(row.alt_text).toBe("layered mandala in green");
  });

  it("a single-symmetry v2 save keeps a real fold count", async () => {
    const { DB, env } = ctx();
    const d = JSON.stringify({
      v: 2,
      bg: "light",
      layers: [1, 2].map((n) => ({
        id: `l${n}`,
        name: `Layer ${n}`,
        visible: true,
        opacity: 1,
        sym: { segments: 9, mirror: true },
        strokes: [{ tool: "solid", color: "#8e44ad", size: 5, opacity: 1, pts: [[n / 10, 0, 1], [0.4, 0.4, 1]] }],
      })),
    });
    const res = await app.request(
      "/api/artworks",
      { method: "POST", headers: bearer("s1"), body: saveForm({ drawing: d }) },
      env as never,
    );
    const { id } = (await res.json()) as { id: string };
    const row = DB._db.prepare("SELECT segments, mirror, layers, alt_text FROM artworks WHERE id=?").get(id) as {
      segments: number;
      mirror: number;
      layers: number;
      alt_text: string;
    };
    expect(row).toMatchObject({ segments: 9, mirror: 1, layers: 2 });
    expect(row.alt_text).toBe("9-fold mirrored mandala in purple");
  });

  it("the permalink OG description says 'a layered kaleidoscope drawing', not 0-fold", () => {
    // Social scrapers cache this string, so a wrong one is pinned in previews.
    // The route itself needs HTMLRewriter (a workerd global absent from the Node
    // test environment), so the copy is tested at the function that builds it.
    expect(ogDescription({ title: "Drift", author_name: "Other Person", segments: 0 })).toBe(
      "Drift by Other Person — a layered kaleidoscope drawing.",
    );
    expect(ogDescription({ title: "Drift", author_name: null, segments: 9 })).toBe(
      "Drift — a 9-fold kaleidoscope drawing.",
    );
  });

  it("GET /api/artworks/:id exposes layers, contentHash and updatedAt", async () => {
    const { DB, env } = ctx();
    const res = await app.request(
      "/api/artworks",
      { method: "POST", headers: bearer("s1"), body: saveForm({ drawing: drawingV2MixedSym(5) }) },
      env as never,
    );
    const { id } = (await res.json()) as { id: string };

    const meta = (await (
      await app.request(`/api/artworks/${id}`, { headers: bearer("s1") }, env as never)
    ).json()) as { layers: number; contentHash: string; updatedAt: number; segments: number };
    expect(meta.layers).toBe(2);
    expect(meta.segments).toBe(0);
    expect(meta.contentHash).toBe(await contentHash(drawingV2MixedSym(5)));
    expect(meta.updatedAt).toBeGreaterThan(0);
    void DB;
  });
});
