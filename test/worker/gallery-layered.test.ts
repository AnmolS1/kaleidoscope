// Gallery and my-pieces cards must be able to say "Layered".
//
// `segments === 0` is the contract signal for "the visible layers disagree", NOT
// for 0-fold symmetry. Neither list endpoint returned it, so no card on either
// platform could render the copy DESIGN.md specifies — the clients were not at
// fault, the data never arrived.
//
// The columns were always in the rows (both queries are SELECT *), so this is
// serialization. The tests assert the FIELDS ARE PRESENT and carry the layered
// signal, because "the response was 200" is true either way.
import { describe, expect, it } from "vitest";
import app from "../../src/worker/index";
import { makeD1, makeEnv, makeKV, seedArtwork, seedSession, seedUser, BASE } from "./helpers";

function ctx() {
  const DB = makeD1();
  const SESSIONS = makeKV();
  const env = makeEnv({ DB, SESSIONS });
  return { DB, SESSIONS, env };
}

interface Card {
  id: string;
  segments: number;
  mirror: boolean;
  layers: number;
}

describe("list endpoints carry the layered signal", () => {
  it("GET /api/gallery returns segments, mirror and layers", async () => {
    const { DB, env } = ctx();
    seedUser(DB, "u1");
    // segments 0 = mixed symmetry across visible layers = "Layered".
    seedArtwork(DB, { id: "mixed", user_id: "u1", visibility: "public", segments: 0 });
    const res = await app.request(`${BASE}/api/gallery`, {}, env as never);
    expect(res.status).toBe(200);
    const card = ((await res.json()) as { items: Card[] }).items[0];
    expect(card.segments).toBe(0);
    expect(card).toHaveProperty("layers");
    expect(card).toHaveProperty("mirror");
  });

  // Control: a single-symmetry piece keeps a real fold count, so a card cannot
  // just print "Layered" for everything.
  it("a single-symmetry piece still reports its fold count", async () => {
    const { DB, env } = ctx();
    seedUser(DB, "u1");
    seedArtwork(DB, { id: "plain", user_id: "u1", visibility: "public", segments: 9 });
    const res = await app.request(`${BASE}/api/gallery`, {}, env as never);
    const card = ((await res.json()) as { items: Card[] }).items[0];
    expect(card.segments).toBe(9);
  });

  it("GET /api/users/me/artworks returns them too", async () => {
    const { DB, SESSIONS, env } = ctx();
    seedUser(DB, "u1");
    seedSession(SESSIONS, "s1", "u1");
    seedArtwork(DB, { id: "mine", user_id: "u1", visibility: "private", segments: 0 });
    const res = await app.request(
      `${BASE}/api/users/me/artworks`,
      { headers: { Authorization: "Bearer s1" } },
      env as never,
    );
    expect(res.status).toBe(200);
    const card = ((await res.json()) as { items: Card[] }).items[0];
    expect(card.segments).toBe(0);
    expect(card).toHaveProperty("layers");
  });
});
