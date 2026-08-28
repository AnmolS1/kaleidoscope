// The strict title rule, which applies ONLY to clients that announce
// `X-Client-Caps: v2` — i.e. ones whose save UI actually has a title field.
// See legacy-client.test.ts for the other half of the matrix.

import { describe, it, expect } from "vitest";
import app from "../../src/worker/index";
import {
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

function ctx() {
  const DB = makeD1();
  const SESSIONS = makeKV();
  seedUser(DB, "u1");
  seedSession(SESSIONS, "s1", "u1");
  return { DB, env: makeEnv({ DB, SESSIONS, ART: makeR2(), RATELIMIT: makeKV() }) };
}

function saveV2(env: unknown, body: FormData) {
  return app.request(
    "/api/artworks",
    { method: "POST", headers: bearer("s1", true), body },
    env as never,
  );
}

let seed = 100;
const uniqueDrawing = () => drawingV1(seed++);

describe("POST — title rule for v2-capable clients", () => {
  it("accepts a real title and stores it verbatim after trimming", async () => {
    const { DB, env } = ctx();
    const res = await saveV2(env, saveForm({ drawing: uniqueDrawing(), title: "  Ember Lattice  " }));
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect((DB._db.prepare("SELECT title FROM artworks WHERE id=?").get(id) as { title: string }).title).toBe(
      "Ember Lattice",
    );
  });

  it("rejects an empty or whitespace-only title with 400", async () => {
    const { env } = ctx();
    for (const title of ["", "   ", "\t\n "]) {
      const res = await saveV2(env, saveForm({ drawing: uniqueDrawing(), title }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "title_required" });
    }
  });

  it("rejects an ABSENT title field with 400", async () => {
    const { env } = ctx();
    const res = await saveV2(env, saveForm({ drawing: uniqueDrawing(), title: null }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "title_required" });
  });

  it('rejects "Untitled" in any casing or padding', async () => {
    const { env } = ctx();
    for (const title of ["Untitled", "untitled", "UNTITLED", "  UnTiTlEd  "]) {
      const res = await saveV2(env, saveForm({ drawing: uniqueDrawing(), title }));
      expect(res.status).toBe(400);
    }
  });

  it("rejects compatibility lookalikes of untitled (this is what NFKC is for)", async () => {
    // Fullwidth Latin renders as "ｕｎｔｉｔｌｅｄ"; NFKC folds it to ASCII. NFC
    // would not, and the check would sail past.
    const { env } = ctx();
    const fullwidth = "ｕｎｔｉｔｌｅｄ";
    const res = await saveV2(env, saveForm({ drawing: uniqueDrawing(), title: fullwidth }));
    expect(res.status).toBe(400);
  });

  it("accepts a title that merely CONTAINS untitled", async () => {
    // The rule is equality, not a substring ban — "Untitled Study No. 4" is a
    // real title someone might mean.
    const { env } = ctx();
    const res = await saveV2(env, saveForm({ drawing: uniqueDrawing(), title: "Untitled Study No. 4" }));
    expect(res.status).toBe(201);
  });

  it("stores the ORIGINAL characters, not the NFKC-folded ones", async () => {
    // Folding is used only to decide. A title with a ligature keeps its
    // ligature: the user typed it and the fold is lossy.
    const { DB, env } = ctx();
    const typed = "Sunset ﬁeld"; // "ﬁ" ligature
    const res = await saveV2(env, saveForm({ drawing: uniqueDrawing(), title: typed }));
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect((DB._db.prepare("SELECT title FROM artworks WHERE id=?").get(id) as { title: string }).title).toBe(
      typed,
    );
  });

  it("truncates an over-long title rather than rejecting it", async () => {
    const { DB, env } = ctx();
    const res = await saveV2(env, saveForm({ drawing: uniqueDrawing(), title: "x".repeat(400) }));
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const { title } = DB._db.prepare("SELECT title FROM artworks WHERE id=?").get(id) as { title: string };
    expect(title).toHaveLength(120);
  });

  it("rejects a bad title BEFORE charging the rate limit", async () => {
    const DB = makeD1();
    const SESSIONS = makeKV();
    const RATELIMIT = makeKV();
    seedUser(DB, "u1");
    seedSession(SESSIONS, "s1", "u1");
    const env = makeEnv({ DB, SESSIONS, ART: makeR2(), RATELIMIT });
    await saveV2(env, saveForm({ drawing: uniqueDrawing(), title: "" }));
    expect(RATELIMIT.store.get("rl:save:u1:h")).toBeUndefined();
  });
});

describe("PATCH — title rule applies only when the body carries a title", () => {
  function patch(env: unknown, body: unknown, v2: boolean) {
    return app.request(
      "/api/artworks/a1",
      { method: "PATCH", headers: bearer("s1", v2), body: JSON.stringify(body) },
      env as never,
    );
  }

  it("a visibility-only edit on a legacy Untitled row keeps working", async () => {
    // This is the compatibility case that matters: every pre-1.2 piece is
    // titled "Untitled", and 1.2 must not make them all unpublishable.
    const { DB, env } = ctx();
    seedArtwork(DB, { id: "a1", user_id: "u1", visibility: "private", title: "Untitled" });

    const res = await patch(env, { visibility: "unlisted" }, true);
    expect(res.status).toBe(200);
    const row = DB._db.prepare("SELECT title, visibility FROM artworks WHERE id='a1'").get() as {
      title: string;
      visibility: string;
    };
    expect(row.visibility).toBe("unlisted");
    expect(row.title).toBe("Untitled");
  });

  it("rejects an explicitly empty title from a v2 client", async () => {
    const { DB, env } = ctx();
    seedArtwork(DB, { id: "a1", user_id: "u1", visibility: "unlisted" });
    const res = await patch(env, { title: "" }, true);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "title_required" });
  });

  it('rejects retitling to "Untitled" from a v2 client', async () => {
    const { DB, env } = ctx();
    seedArtwork(DB, { id: "a1", user_id: "u1", visibility: "unlisted" });
    expect((await patch(env, { title: "untitled" }, true)).status).toBe(400);
  });

  it("a legacy client's empty title still falls back to Untitled", async () => {
    const { DB, env } = ctx();
    seedArtwork(DB, { id: "a1", user_id: "u1", visibility: "unlisted", title: "Old" });
    const res = await patch(env, { title: "" }, false);
    expect(res.status).toBe(200);
    expect((DB._db.prepare("SELECT title FROM artworks WHERE id='a1'").get() as { title: string }).title).toBe(
      "Untitled",
    );
  });

  it("404s an unknown id and 403s someone else's piece", async () => {
    const { DB, env } = ctx();
    seedUser(DB, "u2");
    seedArtwork(DB, { id: "theirs", user_id: "u2" });
    expect(
      (
        await app.request(
          "/api/artworks/nope",
          { method: "PATCH", headers: bearer("s1"), body: "{}" },
          env as never,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request(
          "/api/artworks/theirs",
          { method: "PATCH", headers: bearer("s1"), body: "{}" },
          env as never,
        )
      ).status,
    ).toBe(403);
  });

  it("401s an unauthenticated PATCH", async () => {
    const { DB, env } = ctx();
    seedArtwork(DB, { id: "a1", user_id: "u1" });
    const res = await app.request("/api/artworks/a1", { method: "PATCH", body: "{}" }, env as never);
    expect(res.status).toBe(401);
  });
});
