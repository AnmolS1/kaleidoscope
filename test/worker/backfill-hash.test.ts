// POST /api/admin/backfill-hash — gives pre-1.2 rows a `content_hash` and a
// real `layers` count so the remix block and dedupe work for legacy pieces.
//
// The single hazard this suite exists to pin down: stored vectors are GZIPPED
// (`vec/{id}.json.gz`, written as opaque bytes by `putVectorGz`). Hashing the
// compressed bytes would populate the column with a wrong-but-plausible value,
// and a wrong hash is strictly worse than a NULL one — NULL is a known "not
// backfilled yet" state, whereas a wrong hash makes two different drawings look
// identical and blocks a legitimate save as `duplicate_of_other`.

import { describe, it, expect } from "vitest";
import app from "../../src/worker/index";
import { contentHash } from "../../src/shared/vector";
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
  bearer,
} from "./helpers";

/** Exactly what `putVectorGz` writes: gzip bytes, no contentEncoding metadata. */
async function gz(json: string): Promise<ArrayBuffer> {
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

function ctx() {
  const DB = makeD1();
  const SESSIONS = makeKV();
  const ART = makeR2();
  seedUser(DB, "admin1", { role: "admin" });
  seedUser(DB, "u1");
  seedUser(DB, "u2");
  seedSession(SESSIONS, "sa", "admin1");
  seedSession(SESSIONS, "su", "u1");
  return { DB, ART, env: makeEnv({ DB, SESSIONS, ART, RATELIMIT: makeKV() }) };
}

/** Seed a row AND its gzipped vector blob, the way a real save leaves them. */
async function seedPiece(
  ctxs: Awaited<ReturnType<typeof ctx>>,
  id: string,
  userId: string,
  json: string,
  over: { created_at?: number } = {},
) {
  seedArtwork(ctxs.DB, { id, user_id: userId, content_hash: null, ...over });
  await ctxs.ART.put(`vec/${id}.json.gz`, await gz(json));
}

interface BackfillResult {
  scanned: number;
  processed: number;
  skipped: { id: string; reason: string }[];
}

function run(env: unknown, body: Record<string, unknown> = {}, sid = "sa") {
  return app.request(
    "/api/admin/backfill-hash",
    { method: "POST", headers: { ...bearer(sid), "Content-Type": "application/json" }, body: JSON.stringify(body) },
    env as never,
  );
}

/** The route's JSON body, typed — every assertion below reads named fields. */
async function runJson(
  env: unknown,
  body: Record<string, unknown> = {},
): Promise<BackfillResult> {
  return (await run(env, body)).json() as Promise<BackfillResult>;
}

const readRow = (DB: ReturnType<typeof makeD1>, id: string) =>
  DB._db.prepare("SELECT content_hash, layers FROM artworks WHERE id = ?").get(id) as {
    content_hash: string | null;
    layers: number;
  };

describe("POST /api/admin/backfill-hash", () => {
  it("refuses a non-admin and an anonymous caller", async () => {
    const { env } = ctx();
    expect((await run(env, {}, "su")).status).toBe(403);
    const anon = await app.request(
      "/api/admin/backfill-hash",
      { method: "POST" },
      env as never,
    );
    expect(anon.status).toBe(401);
  });

  it("hashes the DECOMPRESSED bytes, not the stored gzip", async () => {
    const c = ctx();
    const json = drawingV1(7);
    await seedPiece(c, "a1", "u1", json);

    // Control 1: the fixture really is compressed. Without this the whole test
    // would pass against an implementation that never decompresses, because the
    // stored bytes would already BE the JSON.
    const stored = new Uint8Array((await c.ART.get("vec/a1.json.gz"))!._raw as ArrayBuffer);
    expect([stored[0], stored[1]]).toEqual([0x1f, 0x8b]);
    expect(new TextDecoder().decode(stored)).not.toBe(json);

    // Control 2: the compressed bytes hash to something different (they are not
    // even parseable as a drawing), so "hash of the blob" and "hash of the
    // drawing" are genuinely distinguishable values.
    await expect(contentHash(new TextDecoder().decode(stored))).rejects.toThrow();

    const res = await run(c.env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ scanned: 1, processed: 1, skipped: [], next: null });
    expect(readRow(c.DB, "a1").content_hash).toBe(await contentHash(json));
  });

  it("handles a v2 payload and writes the real layer count alongside the hash", async () => {
    const c = ctx();
    const v1 = drawingV1(3);
    const v2 = drawingV2MixedSym(4);
    await seedPiece(c, "one", "u1", v1);
    await seedPiece(c, "two", "u1", v2);

    // Seeded as layers = 1, so 2 is a value only the backfill can have written.
    expect(readRow(c.DB, "two").layers).toBe(1);

    expect((await runJson(c.env)).processed).toBe(2);
    expect(readRow(c.DB, "one")).toEqual({ content_hash: await contentHash(v1), layers: 1 });
    expect(readRow(c.DB, "two")).toEqual({ content_hash: await contentHash(v2), layers: 2 });
  });

  it("converges: a second run processes 0 and changes nothing", async () => {
    const c = ctx();
    await seedPiece(c, "a1", "u1", drawingV1(1));
    await seedPiece(c, "a2", "u2", drawingV2MixedSym(2));

    expect((await runJson(c.env)).processed).toBe(2);
    const after1 = [readRow(c.DB, "a1"), readRow(c.DB, "a2")];

    const second = await runJson(c.env);
    // `processed: 0` alone is also what a run that skipped everything would
    // report, so assert on the DATA: the rows are byte-identical to run 1.
    expect(second).toEqual({ scanned: 0, processed: 0, skipped: [], next: null });
    expect([readRow(c.DB, "a1"), readRow(c.DB, "a2")]).toEqual(after1);
  });

  it("caps the batch at 50 and ignores a larger request", async () => {
    const c = ctx();
    for (let i = 0; i < 55; i++) {
      await seedPiece(c, `p${i}`, "u1", drawingV1(i + 1), { created_at: 1_700_000_000_000 + i });
    }
    const first = await runJson(c.env, { batch: 500 });
    expect(first.scanned).toBe(50);
    expect(first.processed).toBe(50);

    const second = await runJson(c.env);
    expect(second.processed).toBe(5);
    expect((await runJson(c.env)).processed).toBe(0);
  });

  it("honours a smaller explicit batch", async () => {
    const c = ctx();
    for (let i = 0; i < 4; i++) await seedPiece(c, `p${i}`, "u1", drawingV1(i + 1));
    expect((await runJson(c.env, { batch: 2 })).processed).toBe(2);
  });

  it("a missing blob is skipped without aborting the rest of the batch", async () => {
    const c = ctx();
    const good = drawingV1(11);
    // Ordered created_at DESC, so the broken row is scanned FIRST — a batch that
    // aborts on it would leave both good rows untouched.
    seedArtwork(c.DB, { id: "gone", user_id: "u1", content_hash: null, created_at: 3000 });
    await seedPiece(c, "ok1", "u1", good, { created_at: 2000 });
    await seedPiece(c, "ok2", "u2", drawingV2MixedSym(12), { created_at: 1000 });

    const body = await runJson(c.env);
    expect(body.processed).toBe(2);
    expect(body.skipped).toEqual([{ id: "gone", reason: "missing_blob" }]);
    expect(readRow(c.DB, "gone").content_hash).toBeNull();
    expect(readRow(c.DB, "ok1").content_hash).toBe(await contentHash(good));

    // And it does not loop forever: the stuck row is scanned again but nothing
    // is processed, which is the documented stop signal.
    const again = await runJson(c.env);
    expect(again.scanned).toBe(1);
    expect(again.processed).toBe(0);
  });

  it("an unparseable or non-gzip blob is skipped, not fatal", async () => {
    const c = ctx();
    seedArtwork(c.DB, { id: "raw", user_id: "u1", content_hash: null, created_at: 3000 });
    await c.ART.put("vec/raw.json.gz", new TextEncoder().encode("not gzip at all").buffer);
    seedArtwork(c.DB, { id: "junk", user_id: "u1", content_hash: null, created_at: 2000 });
    await c.ART.put("vec/junk.json.gz", await gz("{ this is not a drawing }"));
    const good = drawingV1(21);
    await seedPiece(c, "ok1", "u1", good, { created_at: 1000 });

    const body = await runJson(c.env);
    expect(body.processed).toBe(1);
    expect(body.skipped).toEqual([
      { id: "raw", reason: "unreadable_blob" },
      { id: "junk", reason: "bad_json" },
    ]);
    expect(readRow(c.DB, "ok1").content_hash).toBe(await contentHash(good));
  });

  it("a same-user legacy duplicate is reported, not a 500", async () => {
    const c = ctx();
    const same = drawingV1(31);
    // Two rows for ONE user holding the identical drawing — legal before 1.2,
    // and now refused by `idx_art_user_hash`. Only one can acquire the hash.
    await seedPiece(c, "dup1", "u1", same, { created_at: 3000 });
    await seedPiece(c, "dup2", "u1", same, { created_at: 2000 });
    const other = drawingV1(32);
    await seedPiece(c, "ok1", "u1", other, { created_at: 1000 });

    const body = await runJson(c.env);
    expect(body.processed).toBe(2);
    expect(body.skipped).toEqual([{ id: "dup2", reason: "duplicate_or_already_set" }]);
    expect(readRow(c.DB, "dup1").content_hash).toBe(await contentHash(same));
    expect(readRow(c.DB, "dup2").content_hash).toBeNull();
    expect(readRow(c.DB, "ok1").content_hash).toBe(await contentHash(other));

    // Converged: the stuck duplicate never processes, so the loop terminates.
    expect((await runJson(c.env)).processed).toBe(0);
  });

  it("tolerates a CROSS-user duplicate — the index is per user", async () => {
    const c = ctx();
    const same = drawingV1(41);
    await seedPiece(c, "mine", "u1", same);
    await seedPiece(c, "theirs", "u2", same);

    const body = await runJson(c.env);
    expect(body).toEqual({ scanned: 2, processed: 2, skipped: [], next: null });
    const h = await contentHash(same);
    expect(readRow(c.DB, "mine").content_hash).toBe(h);
    expect(readRow(c.DB, "theirs").content_hash).toBe(h);
  });

  it("does nothing on an already-hashed table", async () => {
    const c = ctx();
    seedArtwork(c.DB, { id: "done", user_id: "u1", content_hash: "f".repeat(64) });
    const res = await run(c.env);
    expect(await res.json()).toEqual({ scanned: 0, processed: 0, skipped: [], next: null });
    expect(readRow(c.DB, "done").content_hash).toBe("f".repeat(64));
  });
});

// The sweep must not wedge behind rows that can never be hashed.
//
// Without paging the scan took the newest N rows every time, and a row that
// cannot be hashed never leaves the `content_hash IS NULL` set — so the stuck
// ones pile up at the head of a fixed ordering and hide everything behind them.
// `processed: 0` then reports the sweep finished while most of the table is
// untouched. Migration 0006 nulled every hash, so this is the state production
// starts the backfill in, not a hypothetical.
describe("the backfill pages past rows it can never hash", () => {
  /** 60 NEWEST rows with no blob in R2 — permanently skipped, more than a batch. */
  function withBlockage() {
    const c = ctx();
    for (let i = 0; i < 60; i++) {
      seedArtwork(c.DB, {
        id: `stuck${i}`,
        user_id: "u1",
        created_at: 2_000_000 + i,
        content_hash: null,
      });
    }
    return c;
  }

  it("reaches a good row sitting behind 60 unhashable ones", async () => {
    const c = withBlockage();
    const json = drawingV1(7);
    await seedPiece(c, "reachable", "u1", json, { created_at: 1_000_000 });

    let after: string | undefined;
    let hashed = 0;
    for (let i = 0; i < 10; i++) {
      const b = (await (await run(c.env, after ? { after } : {})).json()) as {
        processed: number;
        next: string | null;
      };
      hashed += b.processed;
      if (b.next === null) break;
      after = b.next;
    }

    // Before paging this was 0: the first batch was 50 stuck rows, `processed`
    // was 0, and `processed: 0` is the documented signal to stop.
    expect(hashed).toBe(1);
    expect(readRow(c.DB, "reachable").content_hash).toBe(await contentHash(json));
  });

  it("CONTROL: the first batch really is all blockage, so paging is what saved it", async () => {
    const c = withBlockage();
    await seedPiece(c, "reachable", "u1", drawingV1(7), { created_at: 1_000_000 });

    const first = (await (await run(c.env)).json()) as {
      scanned: number;
      processed: number;
      next: string | null;
    };
    expect(first.scanned).toBe(50);
    expect(first.processed).toBe(0);
    // And it hands back somewhere to continue FROM, which is the whole fix.
    expect(first.next).not.toBeNull();
  });

  it("a sweep that reaches the end says so with a null cursor", async () => {
    const c = ctx();
    await seedPiece(c, "only", "u1", drawingV1(7));
    const b = (await (await run(c.env)).json()) as { processed: number; next: string | null };
    expect(b.processed).toBe(1);
    expect(b.next).toBeNull();
  });
});
