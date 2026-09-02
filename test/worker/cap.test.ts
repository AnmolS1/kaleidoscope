// The free public-post cap, the conditional publish that enforces it, and the
// two things it is built on: a D1 shim that reports `meta.changes` honestly, and
// a migration that backfills `published_at`.
//
// The shim test comes first on purpose. The cap is enforced by ONE statement
// whose WHERE clause carries the cap predicate, and "was this blocked?" is
// exactly "did that statement change 0 rows?". If the shim reported changes
// wrongly — or not at all, as it did before 1.2 — every test below would pass
// while asserting nothing at all.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import app from "../../src/worker/index";
import {
  makeD1,
  makeKV,
  makeR2,
  makeEnv,
  drawingV1,
  seedUser,
  seedPlus,
  seedArtwork,
  seedSession,
  saveForm,
  bearer,
} from "./helpers";

const migration = (f: string) => readFileSync(join(process.cwd(), "migrations", f), "utf8");

// Vars as wrangler.jsonc writes them: strings, never JSON booleans/numbers.
const CAP_ON = { PLUS_ENABLED: "true", CAP_EPOCH: "0", FREE_PUBLIC_CAP: "10" };

function ctx(over: Record<string, unknown> = {}) {
  const DB = makeD1();
  const SESSIONS = makeKV();
  const ART = makeR2();
  seedUser(DB, "u1");
  seedSession(SESSIONS, "s1", "u1");
  return { DB, SESSIONS, ART, env: makeEnv({ DB, SESSIONS, ART, RATELIMIT: makeKV(), ...over }) };
}

function save(env: unknown, body: FormData, sid = "s1") {
  return app.request("/api/artworks", { method: "POST", headers: bearer(sid), body }, env as never);
}

function visibilityOf(DB: ReturnType<typeof makeD1>, id: string): string {
  return (DB._db.prepare("SELECT visibility FROM artworks WHERE id=?").get(id) as { visibility: string })
    .visibility;
}

// ---------------------------------------------------------------------------

describe("the D1 test shim itself — meta.changes", () => {
  it("reports 0 when a conditional UPDATE matches nothing and N when it matches", async () => {
    const DB = makeD1();
    seedUser(DB, "u1");
    seedArtwork(DB, { id: "a1", user_id: "u1", visibility: "unlisted" });
    seedArtwork(DB, { id: "a2", user_id: "u1", visibility: "unlisted" });

    const miss = await DB.prepare("UPDATE artworks SET title='x' WHERE id='nope'").run();
    expect(miss.meta.changes).toBe(0);

    const one = await DB.prepare("UPDATE artworks SET title='x' WHERE id=?").bind("a1").run();
    expect(one.meta.changes).toBe(1);

    const two = await DB.prepare("UPDATE artworks SET title='y' WHERE user_id=?").bind("u1").run();
    expect(two.meta.changes).toBe(2);
  });

  it("reports changes as a NUMBER, not node:sqlite's BigInt", async () => {
    // `0n === 0` is false. If this leaks through as a BigInt, `changes === 0`
    // never fires, capReached is dead code, and every cap test below goes green
    // for the wrong reason.
    const DB = makeD1();
    seedUser(DB, "u1");
    const res = await DB.prepare("UPDATE users SET name='n' WHERE id='u1'").run();
    expect(typeof res.meta.changes).toBe("number");
  });

  it("reports 0 for a conditional UPDATE blocked by a subquery predicate", async () => {
    // The exact shape the cap uses, in isolation from the route.
    const DB = makeD1();
    seedUser(DB, "u1");
    for (let i = 0; i < 3; i++) seedArtwork(DB, { id: `p${i}`, user_id: "u1", visibility: "public" });
    seedArtwork(DB, { id: "target", user_id: "u1", visibility: "unlisted" });

    const sql = `UPDATE artworks SET visibility='public' WHERE id='target'
                 AND (SELECT COUNT(*) FROM artworks WHERE user_id='u1' AND visibility='public' AND published_at >= 0) < ?`;
    const blocked = await DB.prepare(sql).bind(3).run(); // 3 < 3 is false
    expect(blocked.meta.changes).toBe(0);
    expect(visibilityOf(DB, "target")).toBe("unlisted");

    const allowed = await DB.prepare(sql).bind(4).run(); // 3 < 4 is true
    expect(allowed.meta.changes).toBe(1);
    expect(visibilityOf(DB, "target")).toBe("public");
  });
});

describe("migration 0004 against a database that already has rows", () => {
  // makeD1 applies every migration before anything is inserted, so it can never
  // exercise this. Build the pre-1.2 schema by hand, put rows in it, and only
  // then apply 0004 — which is the order a real deploy runs in.
  function pre12WithRows() {
    const db = new DatabaseSync(":memory:");
    db.exec(migration("0001_init.sql"));
    db.exec(migration("0002_apple_auth.sql"));
    db.exec(migration("0003_alt_text.sql"));
    db.prepare(
      `INSERT INTO users (id, google_sub, apple_sub, email, name, avatar_url, role, flagged, created_at, last_seen_at)
       VALUES ('u1','g1',NULL,'a@b.test','A',NULL,'user',0,1000,1000)`,
    ).run();
    for (const [id, vis, created] of [
      ["pub1", "public", 1111],
      ["pub2", "public", 2222],
      ["unl1", "unlisted", 3333],
      ["priv1", "private", 4444],
    ] as const) {
      db.prepare(
        `INSERT INTO artworks (id, user_id, title, visibility, image_key, thumb_key, vector_key,
           width, height, segments, mirror, palette, remix_of, likes, created_at)
         VALUES (?, 'u1', 'T', ?, 'i', 't', 'v', 1024, 1024, 6, 1, NULL, NULL, 0, ?)`,
      ).run(id, vis, created);
    }
    return db;
  }

  it("applies cleanly and backfills published_at from created_at for public rows only", () => {
    const db = pre12WithRows();
    db.exec(migration("0004_v12.sql"));

    const rows = db.prepare("SELECT id, published_at, layers, content_hash FROM artworks ORDER BY id").all() as {
      id: string;
      published_at: number | null;
      layers: number;
      content_hash: string | null;
    }[];
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));

    // Public rows get their creation time — a NULL here would make an existing
    // public piece uncountable rather than pre-epoch, i.e. a free extra slot.
    expect(by.pub1.published_at).toBe(1111);
    expect(by.pub2.published_at).toBe(2222);
    expect(by.unl1.published_at).toBeNull();
    expect(by.priv1.published_at).toBeNull();

    // The other added columns take their defaults on existing rows.
    expect(by.pub1.layers).toBe(1);
    expect(by.pub1.content_hash).toBeNull();
  });

  it("keeps every pre-existing row (additive: no table rebuild, no FK cascade)", () => {
    const db = pre12WithRows();
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(migration("0004_v12.sql"));
    expect((db.prepare("SELECT COUNT(*) AS n FROM artworks").get() as { n: number }).n).toBe(4);
    expect((db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n).toBe(1);
  });

  it("creates the entitlements table and the per-user hash uniqueness index", () => {
    const db = pre12WithRows();
    db.exec(migration("0004_v12.sql"));
    db.prepare(
      "INSERT INTO entitlements (source, external_id, user_id, product, environment, granted_at) VALUES ('apple','tx1','u1','plus','Production',5)",
    ).run();
    expect((db.prepare("SELECT COUNT(*) AS n FROM entitlements").get() as { n: number }).n).toBe(1);

    // Same hash, same user → rejected. Same hash, different user → allowed.
    db.prepare("UPDATE artworks SET content_hash='h' WHERE id='pub1'").run();
    expect(() => db.prepare("UPDATE artworks SET content_hash='h' WHERE id='pub2'").run()).toThrow();
  });
});

describe("free public cap — enforcement", () => {
  it("at 9 public, two successive public saves yield one public and one capReached unlisted", async () => {
    const { DB, env } = ctx(CAP_ON);
    for (let i = 0; i < 9; i++) seedArtwork(DB, { id: `p${i}`, user_id: "u1", visibility: "public" });

    const [a, b] = await Promise.all([
      save(env, saveForm({ drawing: drawingV1(1) })),
      save(env, saveForm({ drawing: drawingV1(2) })),
    ]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);

    const bodies = [
      (await a.json()) as { visibility: string; capReached?: boolean; cap?: number; count?: number },
      (await b.json()) as { visibility: string; capReached?: boolean; cap?: number; count?: number },
    ];
    const publics = bodies.filter((x) => x.visibility === "public");
    const capped = bodies.filter((x) => x.capReached);

    expect(publics).toHaveLength(1);
    expect(capped).toHaveLength(1);
    expect(capped[0].visibility).toBe("unlisted");
    expect(capped[0].cap).toBe(10);
    expect(capped[0].count).toBe(10);

    // And the database agrees: exactly 10 public.
    const n = (DB._db.prepare("SELECT COUNT(*) AS n FROM artworks WHERE visibility='public'").get() as {
      n: number;
    }).n;
    expect(n).toBe(10);
  });

  it("CONTROL: at 8 public the same two saves both go public", async () => {
    // Without this the test above could pass for a reason unrelated to the cap
    // (a second save failing for any other reason looks identical).
    const { DB, env } = ctx(CAP_ON);
    for (let i = 0; i < 8; i++) seedArtwork(DB, { id: `p${i}`, user_id: "u1", visibility: "public" });

    const [a, b] = await Promise.all([
      save(env, saveForm({ drawing: drawingV1(1) })),
      save(env, saveForm({ drawing: drawingV1(2) })),
    ]);
    const bodies = [(await a.json()) as { visibility: string }, (await b.json()) as { visibility: string }];
    expect(bodies.every((x) => x.visibility === "public")).toBe(true);
    expect(
      (DB._db.prepare("SELECT COUNT(*) AS n FROM artworks WHERE visibility='public'").get() as { n: number }).n,
    ).toBe(10);
  });

  it("a public piece published BEFORE the epoch does not occupy a slot", async () => {
    const { env } = ctx({ ...CAP_ON, CAP_EPOCH: "5000" });
    const { DB } = { DB: (env as unknown as { DB: ReturnType<typeof makeD1> }).DB };
    for (let i = 0; i < 10; i++) {
      seedArtwork(DB, { id: `old${i}`, user_id: "u1", visibility: "public", published_at: 4999 });
    }
    const res = await save(env, saveForm({ drawing: drawingV1(1) }));
    expect(res.status).toBe(201);
    expect(((await res.json()) as { visibility: string }).visibility).toBe("public");
  });

  it("saves requested as unlisted or private never touch the cap", async () => {
    const { DB, env } = ctx(CAP_ON);
    for (let i = 0; i < 10; i++) seedArtwork(DB, { id: `p${i}`, user_id: "u1", visibility: "public" });

    for (const visibility of ["unlisted", "private"]) {
      const res = await save(env, saveForm({ drawing: drawingV1(visibility.length), visibility }));
      expect(res.status).toBe(201);
      const body = (await res.json()) as { visibility: string; capReached?: boolean };
      expect(body.visibility).toBe(visibility);
      expect(body.capReached).toBeUndefined();
    }
  });

  it("a Plus user is not capped", async () => {
    const { DB, env } = ctx(CAP_ON);
    seedPlus(DB, "u1");
    for (let i = 0; i < 20; i++) seedArtwork(DB, { id: `p${i}`, user_id: "u1", visibility: "public" });
    const res = await save(env, saveForm({ drawing: drawingV1(1) }));
    expect(((await res.json()) as { visibility: string }).visibility).toBe("public");
  });

  it("PLUS_ENABLED=false enforces no cap at all", async () => {
    // No cap without a way to lift it. Note CAP_EPOCH is absent here too — the
    // policy must not even read it while the flag is off.
    const { DB, env } = ctx({ PLUS_ENABLED: "false" });
    for (let i = 0; i < 50; i++) seedArtwork(DB, { id: `p${i}`, user_id: "u1", visibility: "public" });
    const res = await save(env, saveForm({ drawing: drawingV1(1) }));
    expect(res.status).toBe(201);
    expect(((await res.json()) as { visibility: string }).visibility).toBe("public");
  });

  it("another user's public pieces do not consume this user's slots", async () => {
    const { DB, env } = ctx(CAP_ON);
    seedUser(DB, "u2");
    for (let i = 0; i < 20; i++) seedArtwork(DB, { id: `o${i}`, user_id: "u2", visibility: "public" });
    const res = await save(env, saveForm({ drawing: drawingV1(1) }));
    expect(((await res.json()) as { visibility: string }).visibility).toBe("public");
  });
});

describe("free public cap — CAP_EPOCH misconfiguration fails closed", () => {
  it("a non-integer CAP_EPOCH is a 500, not an unlimited cap", async () => {
    // PLUS_ENABLED MUST be true here: with the flag off the epoch is never read
    // and this test would pass without exercising the parse at all.
    const { env } = ctx({ PLUS_ENABLED: "true", CAP_EPOCH: "not-a-number", FREE_PUBLIC_CAP: "10" });
    const res = await save(env, saveForm({ drawing: drawingV1(1) }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "server_misconfigured" });
  });

  it("an empty CAP_EPOCH is a 500 as well", async () => {
    const { env } = ctx({ PLUS_ENABLED: "true", CAP_EPOCH: "", FREE_PUBLIC_CAP: "10" });
    // envInt falls back for an empty string, so this pins which fallback: NaN.
    const res = await save(env, saveForm({ drawing: drawingV1(1) }));
    expect(res.status).toBe(500);
  });

  it("a non-integer FREE_PUBLIC_CAP is a 500, not a silent total blackout", async () => {
    // The opposite failure direction to a bad epoch, and just as silent: a NaN
    // cap binds as SQL NULL, `COUNT(*) < NULL` is NULL (falsy), so every public
    // save would land unlisted with capReached — indistinguishable from a
    // genuinely full account. Verified: node:sqlite binds NaN without throwing.
    const { env } = ctx({ PLUS_ENABLED: "true", CAP_EPOCH: "0", FREE_PUBLIC_CAP: "ten" });
    const res = await save(env, saveForm({ drawing: drawingV1(1) }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "server_misconfigured" });
  });

  it("an UNSET FREE_PUBLIC_CAP falls back to 10 rather than failing", async () => {
    // A missing var is a different case from a garbage one: the default is the
    // shipped policy, so it must not take saves down.
    const { DB, env } = ctx({ PLUS_ENABLED: "true", CAP_EPOCH: "0" });
    for (let i = 0; i < 10; i++) seedArtwork(DB, { id: `p${i}`, user_id: "u1", visibility: "public" });
    const res = await save(env, saveForm({ drawing: drawingV1(1) }));
    expect(res.status).toBe(201);
    expect(((await res.json()) as { cap: number }).cap).toBe(10);
  });

  it("PATCH → public also fails closed on a bad CAP_EPOCH", async () => {
    const { DB, env } = ctx({ PLUS_ENABLED: "true", CAP_EPOCH: "xyz" });
    seedArtwork(DB, { id: "a1", user_id: "u1", visibility: "private", published_at: null });
    const res = await app.request(
      "/api/artworks/a1",
      { method: "PATCH", headers: bearer("s1"), body: JSON.stringify({ visibility: "public" }) },
      env as never,
    );
    expect(res.status).toBe(500);
  });

  // /api/me deliberately does NOT fail closed, unlike the two publish paths
  // above. It carries the session and the CSRF token, so a 500 here costs the
  // client its whole bootstrap — sign-in, gallery and drawing all break — over a
  // var that governs only the public-post cap. Settled with Anmol 2026-08-28.
  it("GET /api/me DEGRADES on a bad CAP_EPOCH instead of taking the app down", async () => {
    const { env } = ctx({ PLUS_ENABLED: "true", CAP_EPOCH: "xyz" });
    const res = await app.request("/api/me", { headers: bearer("s1") }, env as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      user: { id: string } | null;
      csrf: string | null;
      plus: { enabled: boolean; publicCap: number | null; layerCap: number };
    };
    // The things a 500 would have destroyed.
    expect(body.user?.id).toBe("u1");
    expect(body.csrf).toBeTruthy();
    // Degraded to the PLUS_ENABLED=false shape: no cap reported, full layers.
    expect(body.plus.enabled).toBe(false);
    expect(body.plus.publicCap).toBeNull();
    expect(body.plus.layerCap).toBe(8);
  });

  it("a degraded /api/me still reports a finite layerCap when PLUS_LAYER_CAP is the bad var", async () => {
    // envInt returns NaN for a set-but-unparseable value, and NaN serializes as
    // null — which would break the client's layer gate rather than degrade it.
    const { env } = ctx({ PLUS_ENABLED: "true", CAP_EPOCH: "xyz", PLUS_LAYER_CAP: "eight" });
    const res = await app.request("/api/me", { headers: bearer("s1") }, env as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { plus: { layerCap: number } };
    expect(Number.isFinite(body.plus.layerCap)).toBe(true);
    expect(body.plus.layerCap).toBe(8);
  });

  // The other half of the decision: degrading /api/me must NOT have loosened
  // the paths where the cap actually bites. Without this, "degrade" could
  // silently become "no cap".
  it("degrading /api/me did not stop the publish paths failing closed", async () => {
    const { env } = ctx({ PLUS_ENABLED: "true", CAP_EPOCH: "xyz" });
    const save = await app.request(
      "/api/artworks",
      { method: "POST", headers: bearer("s1"), body: saveForm({ drawing: drawingV1(1) }) },
      env as never,
    );
    expect(save.status).toBe(500);
  });
});

describe("free public cap — PATCH publish path", () => {
  it("private → public counts once and re-publishing does not count again", async () => {
    const { DB, env } = ctx(CAP_ON);
    for (let i = 0; i < 9; i++) seedArtwork(DB, { id: `p${i}`, user_id: "u1", visibility: "public" });
    seedArtwork(DB, { id: "a1", user_id: "u1", visibility: "private", published_at: null });

    const patch = (visibility: string) =>
      app.request(
        "/api/artworks/a1",
        { method: "PATCH", headers: bearer("s1"), body: JSON.stringify({ visibility }) },
        env as never,
      );

    // 9 → 10: allowed, and published_at is stamped.
    expect((await patch("public")).status).toBe(200);
    const first = (DB._db.prepare("SELECT published_at FROM artworks WHERE id='a1'").get() as {
      published_at: number;
    }).published_at;
    expect(first).toBeGreaterThan(0);

    // Unpublish: published_at is KEPT (it records that this piece went public).
    expect((await patch("unlisted")).status).toBe(200);
    expect(
      (DB._db.prepare("SELECT published_at FROM artworks WHERE id='a1'").get() as { published_at: number })
        .published_at,
    ).toBe(first);

    // Re-publish: back to 10, and the original timestamp survives — the piece
    // has not consumed a second slot.
    expect((await patch("public")).status).toBe(200);
    expect(
      (DB._db.prepare("SELECT published_at FROM artworks WHERE id='a1'").get() as { published_at: number })
        .published_at,
    ).toBe(first);
    expect(
      (DB._db.prepare("SELECT COUNT(*) AS n FROM artworks WHERE visibility='public'").get() as { n: number }).n,
    ).toBe(10);
  });

  it("PATCH → public at the cap is 402 with the cap and count", async () => {
    const { DB, env } = ctx(CAP_ON);
    for (let i = 0; i < 10; i++) seedArtwork(DB, { id: `p${i}`, user_id: "u1", visibility: "public" });
    seedArtwork(DB, { id: "a1", user_id: "u1", visibility: "private", published_at: null });

    const res = await app.request(
      "/api/artworks/a1",
      { method: "PATCH", headers: bearer("s1"), body: JSON.stringify({ visibility: "public" }) },
      env as never,
    );
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: "cap_reached", cap: 10, count: 10 });
    expect(visibilityOf(DB, "a1")).toBe("private");
  });

  it("an ALREADY-public piece re-PATCHed to public at exactly the cap stays 200", async () => {
    // The count subquery includes the row being updated, so at 10/10 a naive
    // conditional publish sees `10 < 10` and reports an idempotent no-op as
    // cap-reached. The handler must short-circuit instead.
    const { DB, env } = ctx(CAP_ON);
    for (let i = 0; i < 10; i++) seedArtwork(DB, { id: `p${i}`, user_id: "u1", visibility: "public" });

    const res = await app.request(
      "/api/artworks/p0",
      { method: "PATCH", headers: bearer("s1"), body: JSON.stringify({ visibility: "public", title: "Renamed" }) },
      env as never,
    );
    expect(res.status).toBe(200);
    const row = DB._db.prepare("SELECT visibility, title FROM artworks WHERE id='p0'").get() as {
      visibility: string;
      title: string;
    };
    expect(row.visibility).toBe("public");
    expect(row.title).toBe("Renamed");
  });

  it("unpublishing frees a slot — the cap is 10 CONCURRENTLY public, not 10 ever", async () => {
    // Settled with Anmol 2026-08-28: §2.4's SQL is the spec. The cap counts
    // currently-public pieces, so taking one down deliberately gives the slot
    // back. `published_at` still records FIRST publication (see the COALESCE
    // test below) — that timestamp is what `>= CAP_EPOCH` tests, and it is a
    // different question from whether the piece is public right now.
    const { DB, env } = ctx(CAP_ON);
    for (let i = 0; i < 10; i++) seedArtwork(DB, { id: `p${i}`, user_id: "u1", visibility: "public" });

    // At 10/10 a new public save is capped.
    const blocked = await save(env, saveForm({ drawing: drawingV1(1) }));
    expect(((await blocked.json()) as { capReached?: boolean }).capReached).toBe(true);

    // Unpublish one, and the next save gets the freed slot.
    await app.request(
      "/api/artworks/p0",
      { method: "PATCH", headers: bearer("s1"), body: JSON.stringify({ visibility: "private" }) },
      env as never,
    );
    const ok = await save(env, saveForm({ drawing: drawingV1(2) }));
    expect(((await ok.json()) as { visibility: string }).visibility).toBe("public");
  });

  it("a pre-epoch piece stays grandfathered across unpublish → re-publish (COALESCE)", async () => {
    // The consequence of `published_at = COALESCE(published_at, ?now)` that is
    // easiest to break later: re-publishing must NOT restamp the timestamp,
    // because that would drag a grandfathered piece over CAP_EPOCH and quietly
    // charge the user a slot for something they already had. Taking a piece
    // down and putting it back returns it to a state it already occupied.
    const { DB, env } = ctx({ ...CAP_ON, CAP_EPOCH: "5000" });
    // 9 pieces that DO count, plus one published long before the epoch.
    for (let i = 0; i < 9; i++) {
      seedArtwork(DB, { id: `p${i}`, user_id: "u1", visibility: "public", published_at: 9000 });
    }
    seedArtwork(DB, { id: "old", user_id: "u1", visibility: "public", published_at: 4999 });

    const patch = (id: string, visibility: string) =>
      app.request(
        `/api/artworks/${id}`,
        { method: "PATCH", headers: bearer("s1"), body: JSON.stringify({ visibility }) },
        env as never,
      );
    const publishedAt = (id: string) =>
      (DB._db.prepare("SELECT published_at FROM artworks WHERE id=?").get(id) as { published_at: number })
        .published_at;

    expect((await patch("old", "private")).status).toBe(200);
    expect(publishedAt("old")).toBe(4999); // unpublishing never clears it

    expect((await patch("old", "public")).status).toBe(200);
    // The load-bearing assertion: still 4999, NOT Date.now().
    expect(publishedAt("old")).toBe(4999);

    // And it demonstrably still costs nothing: 10 rows are public, but only 9
    // count, so a new public save fits — and the one after it does not.
    expect(
      (DB._db.prepare("SELECT COUNT(*) AS n FROM artworks WHERE visibility='public'").get() as { n: number }).n,
    ).toBe(10);
    const fits = await save(env, saveForm({ drawing: drawingV1(1) }));
    expect(((await fits.json()) as { visibility: string }).visibility).toBe("public");
    const capped = await save(env, saveForm({ drawing: drawingV1(2) }));
    expect(((await capped.json()) as { capReached?: boolean }).capReached).toBe(true);
  });

  it("PATCH stamps updated_at", async () => {
    const { DB, env } = ctx();
    seedArtwork(DB, { id: "a1", user_id: "u1", visibility: "unlisted" });
    await app.request(
      "/api/artworks/a1",
      { method: "PATCH", headers: bearer("s1"), body: JSON.stringify({ title: "New" }) },
      env as never,
    );
    const row = DB._db.prepare("SELECT updated_at FROM artworks WHERE id='a1'").get() as {
      updated_at: number | null;
    };
    expect(row.updated_at).toBeGreaterThan(0);
  });
});

// `surface` is asserted explicitly in each whole-block comparison below.
// These use `toEqual`, so adding a field to the contract SHOULD break them —
// that is what makes them contract tests rather than spot checks. It reads
// false here because these fixtures do not set PLUS_SURFACE_ENABLED; the flag's
// own behaviour lives in plus-flags.test.ts.
describe("/api/me plus block", () => {
  it("reports the live count and cap while enforced", async () => {
    const { DB, env } = ctx(CAP_ON);
    for (let i = 0; i < 4; i++) seedArtwork(DB, { id: `p${i}`, user_id: "u1", visibility: "public" });
    const res = await app.request("/api/me", { headers: bearer("s1") }, env as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { plus: Record<string, unknown> };
    expect(body.plus).toEqual({
      active: false,
      sources: [],
      publicCount: 4,
      publicCap: 10,
      layerCap: 3,
      surface: false,
      enabled: true,
    });
  });

  it("with PLUS_ENABLED=false: no cap, full layer count, enabled false", async () => {
    const { DB, env } = ctx({ PLUS_ENABLED: "false" });
    for (let i = 0; i < 4; i++) seedArtwork(DB, { id: `p${i}`, user_id: "u1", visibility: "public" });
    const res = await app.request("/api/me", { headers: bearer("s1") }, env as never);
    const body = (await res.json()) as { plus: Record<string, unknown> };
    expect(body.plus).toEqual({
      active: false,
      sources: [],
      publicCount: 0,
      publicCap: null,
      layerCap: 8,
      surface: false,
      enabled: false,
    });
  });

  it("a Plus user gets 8 layers, no cap, and its sources listed", async () => {
    const { DB, env } = ctx(CAP_ON);
    seedPlus(DB, "u1", "apple");
    seedPlus(DB, "u1", "comp");
    const res = await app.request("/api/me", { headers: bearer("s1") }, env as never);
    const body = (await res.json()) as { plus: Record<string, unknown> };
    expect(body.plus).toEqual({
      active: true,
      sources: ["apple", "comp"],
      publicCount: 0,
      publicCap: null,
      layerCap: 8,
      surface: false,
      enabled: true,
    });
  });

  // CHANGED for REVIEW S18. A signed-out visitor used to get `plus: null`,
  // which made the whole Plus surface invisible to them — so `PlusSignIn` was
  // an unreachable state and Restore had no signed-out entry point, which
  // Apple expects to exist. The surface flag describes the DEPLOY, not a user,
  // so it is sent either way; every user-specific field is the empty answer.
  it("carries the surface flag but nothing user-specific for a signed-out visitor", async () => {
    const { env } = ctx({ ...CAP_ON, PLUS_SURFACE_ENABLED: "true" });
    const res = await app.request("/api/me", {}, env as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      user: unknown;
      plus: { surface: boolean; active: boolean; enabled: boolean; publicCap: number | null };
    };
    expect(body.user).toBeNull();
    // Findable…
    expect(body.plus.surface).toBe(true);
    // …but it grants and claims nothing.
    expect(body.plus.active, "an anonymous visitor must never read as owning Plus").toBe(false);
    expect(body.plus.enabled, "and no cap is claimed against nobody").toBe(false);
    expect(body.plus.publicCap).toBe(null);
  });

  it("and the surface stays hidden for a signed-out visitor when the flag is off", async () => {
    const { env } = ctx({ ...CAP_ON, PLUS_SURFACE_ENABLED: "false" });
    const res = await app.request("/api/me", {}, env as never);
    const body = (await res.json()) as { plus: { surface: boolean } };
    expect(body.plus.surface).toBe(false);
  });
});

// Minor list — a deploy-side typo must not also cost the user their save budget.
describe("a misconfigured cap does not burn the save rate limit", () => {
  it("still 500s after many attempts, rather than turning into a 429", async () => {
    const { env } = ctx({ PLUS_ENABLED: "true", CAP_EPOCH: "not-a-number" });
    // The hourly budget is 60. Charging it first would mean these 70 attempts
    // exhausted it, so the user is locked out of saving over someone else's
    // configuration mistake — and stays locked out after it is fixed.
    for (let i = 0; i < 70; i++) {
      const res = await save(env, saveForm({ drawing: drawingV1() }));
      expect(res.status, `attempt ${i + 1}`).toBe(500);
      expect(await res.json()).toEqual({ error: "server_misconfigured" });
    }
  });

  it("CONTROL: with a valid config the same requests do save and then rate-limit", async () => {
    const { env } = ctx({ PLUS_ENABLED: "false" });
    let sawSuccess = false;
    let sawLimit = false;
    for (let i = 0; i < 70; i++) {  // past the hourly limit of 60
      const res = await save(env, saveForm({ drawing: drawingV1(i) }));
      if (res.status === 201) sawSuccess = true;
      if (res.status === 429) { sawLimit = true; break; }
    }
    expect(sawSuccess, "saves must work at all").toBe(true);
    expect(sawLimit, "and the limiter must still bite — or the test above proves nothing").toBe(true);
  });
});
