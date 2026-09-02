// REVIEW.md M4 and M5 — two ways a private drawing stopped being private.
//
// Both are "the code does what it says, and what it says is wrong in one
// context": a save-path default reused on the edit path becomes a coercion that
// publishes, and a cache directive correct for public art is a disclosure for
// private art.

import { describe, it, expect } from "vitest";
import app from "../../src/worker/index";
import {
  makeD1, makeKV, makeR2, makeEnv, seedUser, seedSession, seedArtwork, bearer,
} from "./helpers";

function ctx() {
  const DB = makeD1();
  const SESSIONS = makeKV();
  const ART = makeR2();
  seedUser(DB, "u1");
  seedSession(SESSIONS, "s1", "u1");
  seedArtwork(DB, { id: "a1", user_id: "u1", visibility: "private" });
  return { DB, ART, env: makeEnv({ DB, SESSIONS, ART, RATELIMIT: makeKV() }) };
}

const visibilityOf = (DB: ReturnType<typeof makeD1>, id = "a1") =>
  (DB._db.prepare("SELECT visibility FROM artworks WHERE id=?").get(id) as { visibility: string })
    .visibility;

function patch(env: unknown, body: unknown) {
  return app.request(
    "/api/artworks/a1",
    {
      method: "PATCH",
      headers: { ...bearer("s1"), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env as never,
  );
}

describe("PATCH does not publish a private piece by coercion (M4)", () => {
  // Each of these used to fold to "public" through `cleanVisibility`, which is
  // the SAVE-path default. On an edit it is a coercion: a client renaming a
  // private piece with a slightly-wrong visibility field published it.
  const notVisibilities: Array<[string, unknown]> = [
    ["null", null],
    ["capitalised", "Private"],
    ["trailing space", "unlisted "],
    ["number", 0],
    ["object", {}],
    ["empty string", ""],
    ["true", true],
  ];

  for (const [name, value] of notVisibilities) {
    it(`400s on ${name}, and the piece stays private`, async () => {
      const { DB, env } = ctx();
      const res = await patch(env, { title: "renamed", visibility: value });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "bad_visibility" });
      expect(visibilityOf(DB)).toBe("private");
    });
  }

  it("CONTROL: the three real values still work, and absent still means unchanged", async () => {
    for (const v of ["unlisted", "private"] as const) {
      const { DB, env } = ctx();
      expect((await patch(env, { visibility: v })).status).toBe(200);
      expect(visibilityOf(DB)).toBe(v);
    }
    const { DB, env } = ctx();
    expect((await patch(env, { title: "just a rename" })).status).toBe(200);
    expect(visibilityOf(DB)).toBe("private");
  });
});

describe("private artwork bytes are not publicly cacheable (M5)", () => {
  // The URL carries no per-user component, so `public, max-age=31536000` tells
  // the browser cache, any intermediary, and a Cloudflare "Cache Everything"
  // rule that they may keep a private drawing and serve it to someone else.
  //
  // NOTE the absence of an `if (res.status !== 200) skip` here. The first
  // version of this test had one, seeded R2 under the wrong key prefix, got 404
  // for every request and passed while asserting nothing at all. Every response
  // status is asserted, so a fixture that stops serving fails loudly instead of
  // quietly proving nothing.
  function serving(visibility: string, id: string) {
    const DB = makeD1();
    const SESSIONS = makeKV();
    const ART = makeR2({
      [`img/${id}.webp`]: new Uint8Array([1, 2, 3]),
      [`thumb/${id}.webp`]: new Uint8Array([1, 2, 3]),
    });
    seedUser(DB, "u1");
    seedSession(SESSIONS, "s1", "u1");
    seedArtwork(DB, { id, user_id: "u1", visibility });
    return makeEnv({ DB, SESSIONS, ART, RATELIMIT: makeKV() });
  }

  it("image and thumb are private for a private piece", async () => {
    const env = serving("private", "a1");
    for (const path of ["/api/artworks/a1/image", "/api/artworks/a1/thumb"]) {
      const res = await app.request(path, { headers: bearer("s1") }, env as never);
      expect(res.status, `${path} must actually serve, or this test proves nothing`).toBe(200);
      const cc = res.headers.get("Cache-Control") ?? "";
      expect(cc, `${path} must not be publicly cacheable`).not.toMatch(/(^|[ ,])public/);
      expect(cc).toMatch(/private/);
      expect(cc).toMatch(/max-age=31536000/); // still immutable, just not shared
    }
  });

  it("CONTROL: a public piece keeps the immutable PUBLIC directive", async () => {
    const env = serving("public", "pub");
    const res = await app.request("/api/artworks/pub/image", { headers: bearer("s1") }, env as never);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toMatch(/(^|[ ,])public/);
  });

  it("an unlisted piece is shareable by link, so it stays publicly cacheable", async () => {
    const env = serving("unlisted", "unl");
    const res = await app.request("/api/artworks/unl/image", { headers: bearer("s1") }, env as never);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toMatch(/(^|[ ,])public/);
  });
});
