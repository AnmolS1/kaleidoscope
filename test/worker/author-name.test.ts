// A public wall shows a FIRST name, not a full one.
//
// "public gallery posts should only include first name. last name feels like
// too much to just throw up." Applied in the worker so the surname never leaves
// the server for public content — the OG description had the same problem, and
// fixing it per client would have left it in the JSON.

import { describe, it, expect } from "vitest";
import app from "../../src/worker/index";
import { publicAuthorName } from "../../src/shared/authorname";
import {
  makeD1, makeKV, makeR2, makeEnv, seedUser, seedSession, seedArtwork, bearer,
} from "./helpers";

describe("publicAuthorName", () => {
  const CASES: Array<[string, string | null | undefined, string | null]> = [
    ["a normal full name", "Anmol Saxena", "Anmol"],
    ["three parts", "Mary Jane Watson", "Mary"],
    ["a mononym is returned whole", "Prince", "Prince"],
    ["surrounding whitespace", "  Ada  Lovelace ", "Ada"],
    ["a non-breaking space still splits", "Ada Lovelace", "Ada"],
    ["an ideographic space still splits", "山田　太郎", "山田"],
    ["empty is nothing, not an empty byline", "   ", null],
    ["null", null, null],
    ["undefined", undefined, null],
  ];
  for (const [why, input, expected] of CASES) {
    it(why, () => expect(publicAuthorName(input)).toBe(expected));
  }
});

describe("the API never serializes a surname for someone else's piece", () => {
  function ctx() {
    const DB = makeD1();
    const SESSIONS = makeKV();
    seedUser(DB, "u1", { name: "Anmol Saxena" });
    seedUser(DB, "u2", { name: "Someone Else" });
    seedSession(SESSIONS, "s1", "u1");
    seedSession(SESSIONS, "s2", "u2");
    seedArtwork(DB, { id: "a1", user_id: "u1", visibility: "public", title: "Bloom" });
    // The permalink route injects OG tags into the SPA shell, so it needs an
    // ASSETS binding to have a shell to inject into.
    const shell = () =>
      new Response("<!doctype html><html><head></head><body></body></html>", {
        headers: { "content-type": "text/html" },
      });
    return {
      DB,
      env: makeEnv({
        DB, SESSIONS, ART: makeR2(), RATELIMIT: makeKV(),
        ASSETS: { fetch: async () => shell() },
      }),
    };
  }

  it("the gallery card carries the first name only", async () => {
    const { env } = ctx();
    const res = await app.request("/api/gallery", {}, env as never);
    const body = await res.text();
    expect(body).toContain("Anmol");
    expect(body).not.toContain("Saxena");
  });

  it("the artwork detail does too, for the owner and for a stranger", async () => {
    const { env } = ctx();
    for (const headers of [{}, bearer("s1"), bearer("s2")]) {
      const res = await app.request("/api/artworks/a1", { headers }, env as never);
      const body = await res.text();
      expect(body).toContain("Anmol");
      expect(body, JSON.stringify(headers)).not.toContain("Saxena");
    }
  });

  it("and so does the OG description, which scrapers cache", async () => {
    // The ROUTE cannot run here — it needs HTMLRewriter, a workerd global Node
    // does not have — but the string it serves is built by `ogDescription`, and
    // that is testable directly. `preflight.test.ts` established the seam;
    // asserting it here keeps the author rule in one place.
    const { ogDescription } = await import("../../src/worker/routes/permalink");
    expect(ogDescription({ title: "Bloom", author_name: "Anmol Saxena", segments: 9 }))
      .toBe("Bloom by Anmol — a 9-fold kaleidoscope drawing.");
  });

  it("CONTROL: /api/me still gives you your OWN full name", async () => {
    // The trim is about what OTHER people see. Your own account page has every
    // right to your name, and a fix that took it away would be a different bug.
    const { env } = ctx();
    const res = await app.request("/api/me", { headers: bearer("s1") }, env as never);
    const body = (await res.json()) as { user: { name: string | null } };
    expect(body.user.name).toBe("Anmol Saxena");
  });
});
