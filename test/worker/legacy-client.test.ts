// Backwards compatibility with clients that predate 1.2 — shipped iOS 1.1 and
// any web build a user has cached. They send no `X-Client-Caps` header, so the
// strict title rule must not apply to them.
//
// This is not a nicety. iOS 1.1 is in the App Store with no title field; if the
// worker started rejecting its saves, the shipped app would break in the store
// with no way to fix it from our side.

import { describe, it, expect } from "vitest";
import app from "../../src/worker/index";
import {
  BASE,
  makeD1,
  makeKV,
  makeR2,
  makeEnv,
  drawingV1,
  seedUser,
  seedSession,
  saveForm,
  bearer,
} from "./helpers";

function ctx(over: Record<string, unknown> = {}) {
  const DB = makeD1();
  const SESSIONS = makeKV();
  const ART = makeR2();
  seedUser(DB, "u1");
  seedSession(SESSIONS, "s1", "u1");
  return { DB, ART, env: makeEnv({ DB, SESSIONS, ART, RATELIMIT: makeKV(), ...over }) };
}

let seed = 500;
const uniqueDrawing = () => drawingV1(seed++);

function post(env: unknown, body: FormData, headers: Record<string, string>) {
  return app.request("/api/artworks", { method: "POST", headers, body }, env as never);
}

function titleOf(DB: ReturnType<typeof makeD1>, id: string): string {
  return (DB._db.prepare("SELECT title FROM artworks WHERE id=?").get(id) as { title: string }).title;
}

describe("the title matrix: caps header × empty title", () => {
  it("NO caps header + empty title → 201, saved as Untitled", async () => {
    const { DB, env } = ctx();
    const res = await post(env, saveForm({ drawing: uniqueDrawing(), title: "" }), bearer("s1"));
    expect(res.status).toBe(201);
    expect(titleOf(DB, ((await res.json()) as { id: string }).id)).toBe("Untitled");
  });

  it("NO caps header + ABSENT title field → 201, saved as Untitled", async () => {
    const { DB, env } = ctx();
    const res = await post(env, saveForm({ drawing: uniqueDrawing(), title: null }), bearer("s1"));
    expect(res.status).toBe(201);
    expect(titleOf(DB, ((await res.json()) as { id: string }).id)).toBe("Untitled");
  });

  it('NO caps header + a literal "Untitled" → 201 (it is the fallback, not an error)', async () => {
    const { env } = ctx();
    const res = await post(env, saveForm({ drawing: uniqueDrawing(), title: "Untitled" }), bearer("s1"));
    expect(res.status).toBe(201);
  });

  it("caps header + empty title → 400 title_required", async () => {
    const { env } = ctx();
    const res = await post(env, saveForm({ drawing: uniqueDrawing(), title: "" }), bearer("s1", true));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "title_required" });
  });

  it("caps header + a real title → 201", async () => {
    const { DB, env } = ctx();
    const res = await post(env, saveForm({ drawing: uniqueDrawing(), title: "Ember" }), bearer("s1", true));
    expect(res.status).toBe(201);
    expect(titleOf(DB, ((await res.json()) as { id: string }).id)).toBe("Ember");
  });
});

describe("X-Client-Caps parsing", () => {
  it("recognises v2 among several caps, in any casing, with spaces", async () => {
    const { env } = ctx();
    for (const header of ["v2", "V2", " v2 ", "layers, v2", "v2,smoothing"]) {
      const res = await post(
        env,
        saveForm({ drawing: uniqueDrawing(), title: "" }),
        { Authorization: "Bearer s1", "X-Client-Caps": header },
      );
      expect(res.status, header).toBe(400);
    }
  });

  it("does not treat an unrelated or v2-adjacent value as v2", async () => {
    // "v2x" and "xv2" must not match, or a future capability string would
    // silently switch on the strict rule for clients that never asked for it.
    const { env } = ctx();
    for (const header of ["v1", "v2x", "xv2", "layers", ""]) {
      const res = await post(
        env,
        saveForm({ drawing: uniqueDrawing(), title: "" }),
        { Authorization: "Bearer s1", "X-Client-Caps": header },
      );
      expect(res.status, header).toBe(201);
    }
  });
});

describe("legacy clients keep working end to end", () => {
  it("a v1 drawing still saves, with v1 metadata and a single layer", async () => {
    const { DB, env } = ctx();
    const res = await post(env, saveForm({ drawing: drawingV1(1) }), bearer("s1"));
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const row = DB._db
      .prepare("SELECT segments, mirror, layers, content_hash, published_at FROM artworks WHERE id=?")
      .get(id) as {
      segments: number;
      mirror: number;
      layers: number;
      content_hash: string;
      published_at: number;
    };
    // A v1 drawing upgrades to exactly one layer, so it keeps a real fold count.
    expect(row).toMatchObject({ segments: 6, mirror: 1, layers: 1 });
    // 1.2 columns are populated even for a client that knows nothing about them.
    expect(row.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.published_at).toBeGreaterThan(0);
  });

  it("the response still carries id and url, and now visibility too", async () => {
    const { env } = ctx();
    const res = await post(env, saveForm({ drawing: uniqueDrawing() }), bearer("s1"));
    const body = (await res.json()) as { id: string; url: string; visibility: string };
    expect(body.id).toBeTruthy();
    expect(body.url).toBe(`${BASE}/p/${body.id}`);
    // Additive: an old client ignores the extra key.
    expect(body.visibility).toBe("public");
  });

  it("a public save really lands public — the conditional publish leg runs", async () => {
    // The row is inserted UNLISTED and published by a second statement. If that
    // leg were skipped, every public save would silently become unlisted.
    const { DB, env } = ctx();
    const res = await post(env, saveForm({ drawing: uniqueDrawing(), visibility: "public" }), bearer("s1"));
    const { id } = (await res.json()) as { id: string };
    expect(
      (DB._db.prepare("SELECT visibility FROM artworks WHERE id=?").get(id) as { visibility: string })
        .visibility,
    ).toBe("public");
  });

  it("/api/me is still readable by a client that knows nothing about plus", async () => {
    const { env } = ctx();
    const res = await app.request("/api/me", { headers: bearer("s1") }, env as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { id: string }; csrf: unknown; turnstileSiteKey: string };
    expect(body.user.id).toBe("u1");
    expect(body.turnstileSiteKey).toBe("site");
  });
});

describe("save-path status codes", () => {
  it("400 for a missing drawing", async () => {
    const { env } = ctx();
    const fd = saveForm({ drawing: "x" });
    fd.delete("drawing");
    const res = await post(env, fd, bearer("s1"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "missing_drawing" });
  });

  it("400 for malformed and for unsupported-version drawings", async () => {
    const { env } = ctx();
    const cases: [string, string][] = [
      ["{not json", "bad_json"],
      [JSON.stringify({ v: 3, bg: "light", layers: [] }), "bad_version"],
      [JSON.stringify({ v: 1, bg: "chartreuse", sym: { segments: 6, mirror: true }, strokes: [] }), "bad_bg"],
      [
        JSON.stringify({ v: 1, bg: "light", sym: { segments: 99, mirror: true }, strokes: [] }),
        "bad_segments",
      ],
    ];
    for (const [drawing, error] of cases) {
      const res = await post(env, saveForm({ drawing }), bearer("s1"));
      expect(res.status, error).toBe(400);
      expect(await res.json()).toEqual({ error });
    }
  });

  it("400 vector_too_large past the 256KB byte cap", async () => {
    const { env } = ctx();
    const pts = Array.from({ length: 20000 }, (_, i) => [i / 10000, 0.5, 1]);
    const big = JSON.stringify({
      v: 1,
      bg: "light",
      sym: { segments: 6, mirror: true },
      strokes: [{ tool: "solid", color: "#ff0000", size: 10, opacity: 1, pts }],
    });
    expect(big.length).toBeGreaterThan(256 * 1024);
    const res = await post(env, saveForm({ drawing: big }), bearer("s1"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "vector_too_large" });
  });

  it("400 missing_render when the image or thumb is absent", async () => {
    const { env } = ctx();
    const fd = saveForm({ drawing: uniqueDrawing() });
    fd.delete("thumb");
    const res = await post(env, fd, bearer("s1"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "missing_render" });
  });

  it("400 bad_render_type for a non-image upload", async () => {
    const { env } = ctx();
    const fd = saveForm({ drawing: uniqueDrawing() });
    fd.set("thumb", new File([new Uint8Array([1])], "t.txt", { type: "text/plain" }));
    const res = await post(env, fd, bearer("s1"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_render_type" });
  });

  it("401 when unauthenticated", async () => {
    const { env } = ctx();
    const res = await post(env, saveForm({ drawing: uniqueDrawing() }), {});
    expect(res.status).toBe(401);
  });

  it("429 once the hourly save limit is spent", async () => {
    const DB = makeD1();
    const SESSIONS = makeKV();
    const RATELIMIT = makeKV();
    seedUser(DB, "u1");
    seedSession(SESSIONS, "s1", "u1");
    RATELIMIT.store.set("rl:save:u1:h", "60");
    const env = makeEnv({ DB, SESSIONS, ART: makeR2(), RATELIMIT });
    const res = await post(env, saveForm({ drawing: uniqueDrawing() }), bearer("s1"));
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toBe("rate_limited");
  });
});
