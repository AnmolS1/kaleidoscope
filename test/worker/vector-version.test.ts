// GET /api/artworks/:id/vector — version negotiation (PLAN §2.3).
//
// One drawing, two representations at two URLs: `?v=2` streams the stored bytes
// untouched, anything else gets the v1 projection or a 426 when projecting would
// change the picture. The interesting properties are not "does it flatten" but:
//
//  - the 426 is reachable ONLY after canView, so it can't be used to probe for
//    other people's private pieces (or to learn that one uses layers);
//  - the two representations carry DIFFERENT etags, so nothing keyed loosely
//    can serve one body as the other;
//  - a stored object the current parser rejects does not turn a 200 into an
//    uncaught 500, and `?v=2` remains the escape hatch for it.

import { describe, it, expect } from "vitest";
import app from "../../src/worker/index";
import { deserialize, flattenToV1, serializeV1 } from "../../src/shared/vector";
import { IMMUTABLE_CACHE } from "../../src/worker/lib/r2";
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

// ---- fixtures ------------------------------------------------------------

interface StrokeOver {
  po?: 1;
  sm?: 1;
}

function stroke(x = 0, over: StrokeOver = {}) {
  return {
    tool: "solid",
    color: "#ff0000",
    size: 10,
    opacity: 1,
    ...over,
    pts: [
      [x, 0, 0.5],
      [x + 0.1, 0.1, 0.5],
    ],
  };
}

function layer(over: Record<string, unknown> = {}) {
  return {
    id: "l1",
    name: "Layer 1",
    visible: true,
    opacity: 1,
    sym: { segments: 6, mirror: true },
    strokes: [stroke()],
    ...over,
  };
}

const v2 = (layers: unknown[], bg = "light") => JSON.stringify({ v: 2, bg, layers });

/** Single v2 layer, nothing v1 can't express. */
const V2_FLAT = v2([layer()]);
/** Two layers under ONE symmetry — flattens by concatenating strokes. */
const V2_TWO_SAME_SYM = v2([layer(), layer({ id: "l2", name: "Layer 2", strokes: [stroke(0.3)] })]);
/** A hidden layer that WOULD block the flatten if it counted; it must not. */
const V2_HIDDEN_BLOCKER = v2([
  layer(),
  layer({ id: "l2", name: "Layer 2", visible: false, sym: { segments: 9, mirror: false } }),
]);
/** Not expressible in v1: layer opacity is composited, not per-stroke alpha. */
const V2_OPACITY = v2([layer({ opacity: 0.5 })]);
/** Not expressible in v1: an old parser knows nothing of `sm`/`po`. */
const V2_SM = v2([layer({ strokes: [stroke(0, { sm: 1 })] })]);
const V2_PO = v2([layer({ strokes: [stroke(0, { po: 1 })] })]);
/** Bytes the current parser rejects — stands in for a corrupt stored object. */
const CORRUPT = '{"v":2,"bg":"light","layers":[';

async function gz(json: string): Promise<Uint8Array> {
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** What the flattened representation of `json` must be, byte for byte. */
function expectedV1(json: string): string {
  const flat = flattenToV1(deserialize(json));
  if (!flat) throw new Error("fixture is not flattenable");
  return serializeV1(flat);
}

// Every piece is owned by u2 and public unless the test says otherwise; u1 is
// the "some other signed-in user" probe.
async function setup(pieces: Record<string, { json: string; visibility?: string }>) {
  const DB = makeD1();
  const SESSIONS = makeKV();
  const ART = makeR2();
  seedUser(DB, "u1");
  seedUser(DB, "u2");
  seedSession(SESSIONS, "sid1", "u1");
  seedSession(SESSIONS, "sid2", "u2");
  for (const [id, p] of Object.entries(pieces)) {
    seedArtwork(DB, { id, user_id: "u2", visibility: p.visibility ?? "public" });
    ART.store.set(`vec/${id}.json.gz`, await gz(p.json));
  }
  return makeEnv({ DB, SESSIONS, ART, RATELIMIT: makeKV() });
}

const get = (id: string, opts: { v2?: boolean; sid?: string } = {}, env?: unknown) =>
  app.request(
    `/api/artworks/${id}/vector${opts.v2 ? "?v=2" : ""}`,
    opts.sid ? { headers: bearer(opts.sid) } : {},
    env as never,
  );

// ---- the matrix ----------------------------------------------------------

// {v1 stored, v2 flattenable, v2 mixed-sym, v2 opacity<1, v2 with sm} × {?v=2, none}
const STORED: Array<{ name: string; json: string; flattenable: boolean }> = [
  { name: "v1 stored", json: drawingV1(1), flattenable: true },
  { name: "v2 single layer", json: V2_FLAT, flattenable: true },
  { name: "v2 two layers, one symmetry", json: V2_TWO_SAME_SYM, flattenable: true },
  { name: "v2 with a hidden mixed-sym layer", json: V2_HIDDEN_BLOCKER, flattenable: true },
  { name: "v2 mixed symmetry", json: drawingV2MixedSym(2), flattenable: false },
  { name: "v2 layer opacity < 1", json: V2_OPACITY, flattenable: false },
  { name: "v2 with sm", json: V2_SM, flattenable: false },
  { name: "v2 with po", json: V2_PO, flattenable: false },
];

describe("GET /:id/vector — ?v=2 serves the stored bytes untouched", () => {
  for (const { name, json } of STORED) {
    it(name, async () => {
      const env = await setup({ a1: { json } });
      const res = await get("a1", { v2: true }, env);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(json);
      expect(res.headers.get("Content-Type")).toBe("application/json");
      expect(res.headers.get("Cache-Control")).toBe(IMMUTABLE_CACHE);
    });
  }

  it("serves bytes the current parser would reject", async () => {
    // The whole point of the pass-through: it must not depend on deserialize().
    const env = await setup({ a1: { json: CORRUPT } });
    const res = await get("a1", { v2: true }, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(CORRUPT);
  });
});

describe("GET /:id/vector — no ?v=2 flattens or refuses", () => {
  for (const { name, json, flattenable } of STORED) {
    it(`${name} → ${flattenable ? "200 flattened v1" : "426"}`, async () => {
      const env = await setup({ a1: { json } });
      const res = await get("a1", {}, env);
      if (!flattenable) {
        expect(res.status).toBe(426);
        expect(await res.json()).toEqual({ error: "upgrade_required" });
        return;
      }
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(expectedV1(json));
      expect(res.headers.get("Content-Type")).toBe("application/json");
      expect(res.headers.get("Cache-Control")).toBe(IMMUTABLE_CACHE);
    });
  }

  it("round-trips a stored v1 drawing byte-for-byte", async () => {
    // Stronger than `expectedV1` above, which is computed the same way the
    // handler computes it and so cannot catch a shared-module change: this
    // pins the output against the literal stored bytes. An old client must
    // receive exactly what it stored.
    const stored = drawingV1(7);
    const env = await setup({ a1: { json: stored } });
    const res = await get("a1", {}, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(stored);
  });

  it("concatenates the strokes of every visible layer", async () => {
    const env = await setup({ a1: { json: V2_TWO_SAME_SYM } });
    const body = (await (await get("a1", {}, env)).json()) as { v: number; strokes: unknown[] };
    expect(body.v).toBe(1);
    expect(body.strokes).toHaveLength(2);
  });

  it("drops hidden layers rather than letting them force a 426", async () => {
    const env = await setup({ a1: { json: V2_HIDDEN_BLOCKER } });
    const body = (await (await get("a1", {}, env)).json()) as { strokes: unknown[] };
    expect(body.strokes).toHaveLength(1);
  });

  it("treats any other ?v value as a legacy client", async () => {
    const env = await setup({ a1: { json: V2_OPACITY } });
    // Only the literal "2" opts in; `?v=1` and a future `?v=3` are not v2 clients.
    expect((await app.request("/api/artworks/a1/vector?v=1", {}, env)).status).toBe(426);
    expect((await app.request("/api/artworks/a1/vector?v=3", {}, env)).status).toBe(426);
  });
});

describe("etags distinguish the two representations", () => {
  it("the flattened body carries a different etag from the stored body", async () => {
    const env = await setup({ a1: { json: V2_FLAT } });
    const stored = await get("a1", { v2: true }, env);
    const flattened = await get("a1", {}, env);

    const storedTag = stored.headers.get("ETag")!;
    const flatTag = flattened.headers.get("ETag")!;

    // Compared against EACH OTHER, not against literals: asserting only
    // `flatTag === '"x-v1"'` would still pass if the handler emitted the
    // suffixed tag on both paths.
    expect(storedTag).toBeTruthy();
    expect(flatTag).toBeTruthy();
    expect(flatTag).not.toBe(storedTag);
    expect(flatTag).toBe('"x-v1"');
    // Still a well-formed quoted etag, not `"x"-v1`.
    expect(flatTag).toMatch(/^"[^"]*"$/);
  });

  it("derives the suffixed etag from the stored object's own etag", async () => {
    const env = await setup({ a1: { json: drawingV1(3) } });
    const stored = await get("a1", { v2: true }, env);
    const flattened = await get("a1", {}, env);
    const inner = stored.headers.get("ETag")!.replace(/^"|"$/g, "");
    expect(flattened.headers.get("ETag")).toBe(`"${inner}-v1"`);
  });
});

describe("426 is never an existence oracle", () => {
  // The discriminating fixture: a piece that WOULD 426 if the caller could see
  // it. A private v1 piece 404s under either ordering and proves nothing.
  const priv = { json: drawingV2MixedSym(5), visibility: "private" };

  it("404s for an anonymous caller", async () => {
    const env = await setup({ a1: priv });
    const res = await get("a1", {}, env);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("404s for a different signed-in user", async () => {
    const env = await setup({ a1: priv });
    const res = await get("a1", { sid: "sid1" }, env);
    expect(res.status).toBe(404);
  });

  it("426s for the owner — the same row, so the 404s above were the check firing", async () => {
    const env = await setup({ a1: priv });
    const res = await get("a1", { sid: "sid2" }, env);
    expect(res.status).toBe(426);
  });

  it("hides a private piece on the ?v=2 path too", async () => {
    const env = await setup({ a1: priv });
    expect((await get("a1", { v2: true }, env)).status).toBe(404);
    expect((await get("a1", { v2: true, sid: "sid2" }, env)).status).toBe(200);
  });

  it("serves an unlisted piece to anyone who has the id", async () => {
    const env = await setup({ a1: { json: V2_FLAT, visibility: "unlisted" } });
    expect((await get("a1", {}, env)).status).toBe(200);
  });
});

describe("failure modes", () => {
  it("500s rather than throwing when the stored object is unreadable", async () => {
    const env = await setup({ a1: { json: CORRUPT } });
    const res = await get("a1", {}, env);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body).toEqual({ error: "vector_unreadable" });
    // The parse message describes stored content; it must not be echoed.
    expect(JSON.stringify(body)).not.toMatch(/layer|JSON|parse/i);
  });

  it("404s when the artwork row exists but the R2 object does not", async () => {
    const DB = makeD1();
    const SESSIONS = makeKV();
    seedUser(DB, "u2");
    seedArtwork(DB, { id: "a1", user_id: "u2", visibility: "public" });
    const env = makeEnv({ DB, SESSIONS, ART: makeR2(), RATELIMIT: makeKV() });
    expect((await get("a1", {}, env)).status).toBe(404);
    expect((await get("a1", { v2: true }, env)).status).toBe(404);
  });

  it("404s for an unknown id", async () => {
    const env = await setup({ a1: { json: V2_FLAT } });
    expect((await get("nope", {}, env)).status).toBe(404);
    expect((await get("nope", { v2: true }, env)).status).toBe(404);
  });
});
