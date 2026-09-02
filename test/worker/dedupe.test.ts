// Content-hash dedupe on save: the same user re-saving the same picture gets
// their existing piece back untouched, and another user's picture is refused.
//
// "The same picture" is the render-equivalent hash from src/shared/vector.ts,
// so it deliberately ignores things that do not change the render — layer ids,
// layer names, hidden layers.

import { describe, it, expect } from "vitest";
import app from "../../src/worker/index";
import { CAPS } from "../../src/worker/lib/validate";
import { contentHash, deserialize, serialize } from "../../src/shared/vector";
import {
  BASE,
  makeD1,
  makeKV,
  makeR2,
  makeEnv,
  drawingV1,
  seedUser,
  seedArtwork,
  seedSession,
  saveForm,
  bearer,
} from "./helpers";

function ctx(over: Record<string, unknown> = {}) {
  const DB = makeD1();
  const SESSIONS = makeKV();
  const ART = makeR2();
  const RATELIMIT = makeKV();
  seedUser(DB, "u1");
  seedUser(DB, "u2", { name: "Other Person" });
  seedSession(SESSIONS, "s1", "u1");
  seedSession(SESSIONS, "s2", "u2");
  return { DB, SESSIONS, ART, RATELIMIT, env: makeEnv({ DB, SESSIONS, ART, RATELIMIT, ...over }) };
}

function save(env: unknown, body: FormData, sid = "s1") {
  return app.request("/api/artworks", { method: "POST", headers: bearer(sid), body }, env as never);
}

describe("POST /api/artworks — same-user dedupe", () => {
  it("a second save of the same drawing returns 200 deduped with the ORIGINAL id", async () => {
    const { DB, env } = ctx();
    const d = drawingV1(7);

    const first = await save(env, saveForm({ drawing: d, title: "Original" }));
    expect(first.status).toBe(201);
    const { id } = (await first.json()) as { id: string };

    const second = await save(env, saveForm({ drawing: d, title: "A different title" }));
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ id, url: `${BASE}/p/${id}`, deduped: true });

    // Exactly one row, and it still carries the ORIGINAL title: dedupe never
    // mutates. Re-saving is not an edit; title changes go through PATCH.
    const rows = DB._db.prepare("SELECT id, title FROM artworks").all() as { id: string; title: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Original");
  });

  it("dedupe never flips the existing piece's visibility", async () => {
    const { DB, env } = ctx();
    const d = drawingV1(8);
    const first = await save(env, saveForm({ drawing: d, visibility: "private" }));
    const { id } = (await first.json()) as { id: string };

    const second = await save(env, saveForm({ drawing: d, visibility: "public" }));
    expect(second.status).toBe(200);
    expect(
      (DB._db.prepare("SELECT visibility FROM artworks WHERE id=?").get(id) as { visibility: string })
        .visibility,
    ).toBe("private");
  });

  it("does not charge the rate limit for a deduped save", async () => {
    // The whole point of doing the dedupe check BEFORE checkAll: a save that
    // writes nothing must not consume one of the user's hourly slots.
    const { RATELIMIT, env } = ctx();
    const d = drawingV1(9);
    await save(env, saveForm({ drawing: d }));
    const afterWrite = RATELIMIT.store.get("rl:save:u1:h");

    await save(env, saveForm({ drawing: d }));
    expect(RATELIMIT.store.get("rl:save:u1:h")).toBe(afterWrite);
  });

  it("does not write R2 objects for a deduped save", async () => {
    const { ART, env } = ctx();
    const d = drawingV1(10);
    await save(env, saveForm({ drawing: d }));
    const keysAfterFirst = [...ART.store.keys()].sort();

    await save(env, saveForm({ drawing: d }));
    expect([...ART.store.keys()].sort()).toEqual(keysAfterFirst);
  });

  it("a genuinely different drawing is NOT deduped", async () => {
    const { DB, env } = ctx();
    expect((await save(env, saveForm({ drawing: drawingV1(1) }))).status).toBe(201);
    expect((await save(env, saveForm({ drawing: drawingV1(2) }))).status).toBe(201);
    expect((DB._db.prepare("SELECT COUNT(*) AS n FROM artworks").get() as { n: number }).n).toBe(2);
  });

  it("the same picture under a different background is a different piece", async () => {
    const { env } = ctx();
    await save(env, saveForm({ drawing: drawingV1(3, { bg: "light" }) }));
    expect((await save(env, saveForm({ drawing: drawingV1(3, { bg: "dark" }) }))).status).toBe(201);
  });

  it("a v2 re-save of a v1 piece deduplicates — the hash is version-independent", async () => {
    // A v1 drawing upgrades to exactly one visible layer at opacity 1, so the
    // render-equivalent projection is identical. Loading an old piece in a new
    // client and saving it back must not create a twin.
    const { DB, env } = ctx();
    const v1 = drawingV1(11);
    const first = await save(env, saveForm({ drawing: v1 }));
    const { id } = (await first.json()) as { id: string };

    const v2Equivalent = JSON.stringify({
      v: 2,
      bg: "light",
      layers: [
        {
          id: "l1",
          name: "Layer 1",
          visible: true,
          opacity: 1,
          sym: { segments: 6, mirror: true },
          strokes: JSON.parse(v1).strokes,
        },
      ],
    });
    // Same hash by construction, before we even ask the API.
    expect(await contentHash(v2Equivalent)).toBe(await contentHash(v1));

    const second = await save(env, saveForm({ drawing: v2Equivalent }));
    expect(second.status).toBe(200);
    expect(((await second.json()) as { id: string }).id).toBe(id);
    expect((DB._db.prepare("SELECT COUNT(*) AS n FROM artworks").get() as { n: number }).n).toBe(1);
  });

  it("renaming a layer does not make a new piece (the hash drops names)", async () => {
    const { env } = ctx();
    const mk = (name: string) =>
      JSON.stringify({
        v: 2,
        bg: "light",
        layers: [
          {
            id: "l1",
            name,
            visible: true,
            opacity: 1,
            sym: { segments: 6, mirror: false },
            strokes: [{ tool: "solid", color: "#123456", size: 4, opacity: 1, pts: [[0, 0, 1], [0.2, 0.2, 1]] }],
          },
        ],
      });
    await save(env, saveForm({ drawing: mk("Background") }));
    const again = await save(env, saveForm({ drawing: mk("Renamed entirely") }));
    expect(again.status).toBe(200);
    expect(((await again.json()) as { deduped: boolean }).deduped).toBe(true);
  });
});

describe("POST /api/artworks — other-user duplicate block", () => {
  it("409 duplicate_of_other, naming the piece when it is viewable", async () => {
    const { DB, env } = ctx();
    const d = drawingV1(21);
    seedArtwork(DB, {
      id: "theirs",
      user_id: "u2",
      visibility: "public",
      content_hash: await contentHash(d),
      title: "Theirs",
    });

    const res = await save(env, saveForm({ drawing: d }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "duplicate_of_other", of: "theirs" });
    // Nothing was written for the would-be duplicate.
    expect((DB._db.prepare("SELECT COUNT(*) AS n FROM artworks").get() as { n: number }).n).toBe(1);
  });

  it("blocks on another user's PRIVATE piece without disclosing its id", async () => {
    const { env, DB } = ctx();
    const d = drawingV1(22);
    seedArtwork(DB, {
      id: "secret",
      user_id: "u2",
      visibility: "private",
      content_hash: await contentHash(d),
    });

    const res = await save(env, saveForm({ drawing: d }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "duplicate_of_other" });
  });

  it("prefers naming a viewable match over a private one with the same hash", async () => {
    const { env, DB } = ctx();
    const d = drawingV1(23);
    const hash = await contentHash(d);
    seedUser(DB, "u3");
    seedArtwork(DB, { id: "priv", user_id: "u2", visibility: "private", content_hash: hash, created_at: 1 });
    seedArtwork(DB, { id: "pub", user_id: "u3", visibility: "public", content_hash: hash, created_at: 2 });

    const res = await save(env, saveForm({ drawing: d }));
    expect(await res.json()).toEqual({ error: "duplicate_of_other", of: "pub" });
  });

  it("does not charge the rate limit for a blocked save", async () => {
    const { DB, RATELIMIT, env } = ctx();
    const d = drawingV1(24);
    seedArtwork(DB, { id: "theirs", user_id: "u2", content_hash: await contentHash(d) });

    await save(env, saveForm({ drawing: d }));
    expect(RATELIMIT.store.get("rl:save:u1:h")).toBeUndefined();
  });

  it("the owner of a piece is never blocked by their own hash", async () => {
    const { DB, env } = ctx();
    const d = drawingV1(25);
    seedArtwork(DB, { id: "mine", user_id: "u1", content_hash: await contentHash(d) });
    const res = await save(env, saveForm({ drawing: d }));
    expect(res.status).toBe(200); // deduped, not 409
  });

  it("legacy rows with a NULL hash never match anything", async () => {
    // Until the T02c backfill runs, pre-1.2 pieces have no hash. SQL NULL never
    // equals anything, so they simply do not participate — the remix block is
    // off for them, which is documented and intended.
    const { DB, env } = ctx();
    seedArtwork(DB, { id: "legacy", user_id: "u2", content_hash: null });
    const res = await save(env, saveForm({ drawing: drawingV1(26) }));
    expect(res.status).toBe(201);
  });
});

describe("POST /api/artworks — the unique index is the real guarantee", () => {
  it("a save that LOSES the read-then-insert race still answers 200 deduped", async () => {
    // The dedupe SELECT and the INSERT are not one atomic step, so two saves of
    // the same drawing in flight together both pass the SELECT and one loses at
    // the index. That must produce the same answer the checked path gives, not
    // a 500.
    //
    // Reproduced by blinding the handler's FIRST dedupe SELECT exactly once,
    // which is precisely the window a concurrent save occupies. The row is
    // really there, so the INSERT really does hit the constraint.
    const { DB, ART, env } = ctx();
    const d = drawingV1(31);
    const hash = await contentHash(d);
    seedArtwork(DB, { id: "winner", user_id: "u1", content_hash: hash });

    const realPrepare = DB.prepare.bind(DB);
    let blinded = false;
    (DB as unknown as { prepare: unknown }).prepare = (sql: string) => {
      const stmt = realPrepare(sql);
      if (!blinded && sql.includes("user_id = ? AND content_hash = ?")) {
        blinded = true;
        return { ...stmt, bind: (...a: unknown[]) => ({ ...stmt.bind(...a), first: async () => null }) };
      }
      return stmt;
    };

    const before = [...ART.store.keys()];
    const res = await save(env, saveForm({ drawing: d }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: "winner",
      url: `${BASE}/p/winner`,
      deduped: true,
    });

    // Still one row, and the blobs written before the failed insert were
    // cleaned up — no row will ever reference or delete them otherwise.
    expect((DB._db.prepare("SELECT COUNT(*) AS n FROM artworks").get() as { n: number }).n).toBe(1);
    expect([...ART.store.keys()].sort()).toEqual(before.sort());
  });

  it("insertArtwork raises DuplicateHashError (not a raw SQL error) on a hash collision", async () => {
    const { insertArtwork, DuplicateHashError } = await import("../../src/worker/lib/db");
    const DB = makeD1();
    seedUser(DB, "u1");
    const env = makeEnv({ DB });
    const base = {
      user_id: "u1",
      title: "T",
      visibility: "unlisted" as const,
      image_key: "i",
      thumb_key: "t",
      vector_key: "v",
      width: 1024,
      height: 1024,
      segments: 6,
      mirror: 1,
      palette: null,
      remix_of: null,
      created_at: 1,
      alt_text: "a",
      content_hash: "deadbeef",
      layers: 1,
    };
    await insertArtwork(env, { ...base, id: "a1" });
    await expect(insertArtwork(env, { ...base, id: "a2" })).rejects.toBeInstanceOf(DuplicateHashError);

    // A different hash for the same user is fine, as is the same hash for
    // another user — the index is deliberately per-user.
    await insertArtwork(env, { ...base, id: "a3", content_hash: "cafe" });
    seedUser(DB, "u2");
    await insertArtwork(env, { ...base, id: "a4", user_id: "u2" });
    expect((DB._db.prepare("SELECT COUNT(*) AS n FROM artworks").get() as { n: number }).n).toBe(3);
  });
});

// REVIEW.md minor mA3 — everything blank looks alike, so nothing blank may own
// the dedupe key.
describe("a drawing with nothing visible is never deduped", () => {
  const allHidden = (color: string) =>
    JSON.stringify({
      v: 2,
      bg: "light",
      layers: [
        {
          id: "l1",
          name: "Layer 1",
          visible: false,
          opacity: 1,
          sym: { segments: 6, mirror: true },
          strokes: [
            { tool: "solid", color, size: 6, opacity: 1, pts: [[0, 0, 1], [0.1, 0.1, 1]] },
          ],
        },
      ],
    });

  it("two blanks holding DIFFERENT hidden work are two pieces, not one", async () => {
    const { DB, env } = ctx();

    const a = await save(env, saveForm({ drawing: allHidden("#E84A27"), title: "Hidden red" }));
    expect(a.status).toBe(201);
    const b = await save(env, saveForm({ drawing: allHidden("#1D9E75"), title: "Hidden green" }));
    // The whole point: 201 with a NEW id, not 200 deduped onto the first.
    expect(b.status).toBe(201);

    const idA = ((await a.json()) as { id: string }).id;
    const idB = ((await b.json()) as { id: string }).id;
    expect(idB).not.toBe(idA);

    const rows = DB._db.prepare("SELECT id, content_hash FROM artworks ORDER BY id").all() as Array<{
      id: string;
      content_hash: string | null;
    }>;
    expect(rows).toHaveLength(2);
    // NULL is the mechanism — the unique index is partial and exempts it.
    expect(rows.every((r) => r.content_hash === null)).toBe(true);
  });

  it("another user's blank is not refused as a duplicate either", async () => {
    const { env } = ctx();
    expect((await save(env, saveForm({ drawing: allHidden("#E84A27"), title: "Mine" }))).status).toBe(201);
    const theirs = await save(env, saveForm({ drawing: allHidden("#E84A27"), title: "Theirs" }), "s2");
    // Byte-identical, and still not a 409: nobody owns "blank".
    expect(theirs.status).toBe(201);
  });

  it("CONTROL: an identical VISIBLE drawing still dedupes", async () => {
    const { env } = ctx();
    const visible = allHidden("#E84A27").replace('"visible":false', '"visible":true');
    expect((await save(env, saveForm({ drawing: visible, title: "One" }))).status).toBe(201);
    const again = await save(env, saveForm({ drawing: visible, title: "Two" }));
    expect(again.status).toBe(200);
    expect(((await again.json()) as { deduped: boolean }).deduped).toBe(true);
  });
});

// A save whose CANONICAL form crosses the byte cap the input passed.
//
// `deserialize` caps the input; the row stores `serialize(meta.drawing)`, which
// is a different string. Canonicalizing usually shrinks it, but an input that is
// already canonical grows by exactly the v1 -> v2 layer wrapper — measured at
// +67 bytes — with nothing to compensate. Stored, that piece is unreadable by
// every reader (`?v=1`, `?v=2`, iOS, the backfill) while its `content_hash`,
// computed from the CALLER's bytes, makes the row look healthy.
describe("the bytes we STORE are capped, not just the bytes we were sent", () => {
  const enc = new TextEncoder();
  /** A canonical v1 drawing with `n` points — `serialize` changes no number. */
  const v1 = (n: number) =>
    JSON.stringify({
      v: 1,
      bg: "light",
      sym: { segments: 6, mirror: true },
      strokes: [
        {
          tool: "solid",
          color: "#e84a27",
          size: 6,
          opacity: 1,
          pts: Array.from({ length: n }, (_, i) => [((i % 800) - 400) / 1000, 0.123, 0.5]),
        },
      ],
    });

  /** Largest point count whose `size(json)` still satisfies `fits`. */
  function largest(size: (json: string) => number): string {
    let lo = 100;
    let hi = 30000;
    while (lo < hi) {
      const m = Math.ceil((lo + hi) / 2);
      if (size(v1(m)) <= CAPS.vectorBytes) lo = m;
      else hi = m - 1;
    }
    return v1(lo);
  }
  /** The largest drawing the INPUT cap accepts — whose STORED form overflows. */
  const largestAccepted = () => largest((j) => enc.encode(j).length);
  /** The largest whose CANONICAL form fits, which is the honest limit.
   *  Guarded because `deserialize` throws on a candidate the INPUT cap already
   *  refuses, and a throw inside the search is not a size. */
  const largestStorable = () =>
    largest((j) => {
      if (enc.encode(j).length > CAPS.vectorBytes) return Number.MAX_SAFE_INTEGER;
      return enc.encode(serialize(deserialize(j))).length;
    });

  it("413s the save whose canonical form would not fit", async () => {
    const { DB, env } = ctx();
    const drawing = largestAccepted();
    // The premise, asserted rather than assumed: the input fits and the stored
    // form does not. If canonicalization ever stops growing this shape, this
    // line fails and the test below stops meaning anything.
    expect(enc.encode(drawing).length).toBeLessThanOrEqual(CAPS.vectorBytes);
    expect(enc.encode(serialize(deserialize(drawing))).length).toBeGreaterThan(CAPS.vectorBytes);

    const res = await save(env, saveForm({ drawing, title: "Just too big" }));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "vector_too_large" });
    // And nothing was written — a row with an unreadable blob is worse than no
    // row, because the hash makes it look fine.
    expect(DB._db.prepare("SELECT COUNT(*) AS n FROM artworks").get()).toEqual({ n: 0 });
  });

  it("CONTROL: the largest drawing that genuinely FITS still saves and still parses", async () => {
    const { env } = ctx();
    const drawing = largestStorable();
    expect(enc.encode(serialize(deserialize(drawing))).length).toBeLessThanOrEqual(CAPS.vectorBytes);

    const res = await save(env, saveForm({ drawing, title: "Fits" }));
    expect(res.status).toBe(201);
    // The point of the whole guard: what we stored can be read back.
    expect(() => deserialize(serialize(deserialize(drawing)))).not.toThrow();
  });
});
