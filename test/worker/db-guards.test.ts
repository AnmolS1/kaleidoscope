// REVIEW.md S4 and S5 — two guards in the data layer whose absence was latent
// today and destructive on the day it stopped being latent.

import { describe, it, expect } from "vitest";
import { publishArtwork, insertArtwork, DuplicateHashError } from "../../src/worker/lib/db";
import { makeD1, makeKV, makeR2, makeEnv, seedUser, seedArtwork } from "./helpers";

function ctx() {
  const DB = makeD1();
  seedUser(DB, "u1");
  seedUser(DB, "u2");
  return { DB, env: makeEnv({ DB, SESSIONS: makeKV(), ART: makeR2(), RATELIMIT: makeKV() }) };
}
const vis = (DB: ReturnType<typeof makeD1>, id: string) =>
  (DB._db.prepare("SELECT visibility FROM artworks WHERE id=?").get(id) as { visibility: string })
    .visibility;

describe("publishArtwork is scoped to the owner (S4)", () => {
  // This one statement IS the cap enforcement. Without a user_id guard it would
  // publish any row while counting whichever user's quota it was handed — two
  // different users in one statement.
  it("will not publish another user's row", async () => {
    const { DB, env } = ctx();
    seedArtwork(DB, { id: "theirs", user_id: "u2", visibility: "private" });
    const ok = await publishArtwork(env, {
      id: "theirs", userId: "u1", cap: 10, epoch: 0, now: Date.now(),
    });
    expect(ok).toBe(false);
    expect(vis(DB, "theirs")).toBe("private");
  });

  it("CONTROL: it does publish the caller's own row", async () => {
    const { DB, env } = ctx();
    seedArtwork(DB, { id: "mine", user_id: "u1", visibility: "private" });
    const ok = await publishArtwork(env, {
      id: "mine", userId: "u1", cap: 10, epoch: 0, now: Date.now(),
    });
    expect(ok).toBe(true);
    expect(vis(DB, "mine")).toBe("public");
  });

  it("re-publishing an already-public piece consumes no second slot", async () => {
    const { DB, env } = ctx();
    seedArtwork(DB, { id: "pub", user_id: "u1", visibility: "public" });
    const ok = await publishArtwork(env, {
      id: "pub", userId: "u1", cap: 10, epoch: 0, now: Date.now(),
    });
    expect(ok).toBe(false); // nothing to do, so nothing changed
    expect(vis(DB, "pub")).toBe("public");
  });
});

describe("only the dedupe index means 'duplicate' (S5)", () => {
  const row = (id: string, hash: string | null, userId = "u1") => ({
    id, user_id: userId, title: "t", visibility: "unlisted" as const,
    image_key: `img/${id}.webp`, thumb_key: `thumb/${id}.webp`, vector_key: `vec/${id}.json.gz`,
    width: 1024, height: 1024, segments: 6, mirror: 1, palette: null, remix_of: null,
    created_at: Date.now(), alt_text: "alt", content_hash: hash as string, layers: 1,
  });

  it("a same-hash insert is a DuplicateHashError", async () => {
    const { env } = ctx();
    await insertArtwork(env, row("a1", "HASH"));
    await expect(insertArtwork(env, row("a2", "HASH"))).rejects.toBeInstanceOf(DuplicateHashError);
  });

  // The one that mattered: the caller responds to DuplicateHashError by
  // deleting the new piece's R2 objects. A primary-key collision is a DIFFERENT
  // artwork, and treating it as a duplicate destroyed that artwork's blobs.
  it("a primary-key collision is NOT a duplicate — it must not reach the blob delete", async () => {
    const { env } = ctx();
    await insertArtwork(env, row("same-id", "HASH-A"));
    const err = await insertArtwork(env, row("same-id", "HASH-B")).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err, "a PK collision must not be reported as a duplicate drawing")
      .not.toBeInstanceOf(DuplicateHashError);
  });

  it("a foreign-key failure is NOT a duplicate either", async () => {
    const DB = makeD1({ foreignKeys: true });
    const env = makeEnv({ DB, SESSIONS: makeKV(), ART: makeR2(), RATELIMIT: makeKV() });
    const err = await insertArtwork(env, row("orphan", "HASH", "nobody")).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(DuplicateHashError);
  });
});
