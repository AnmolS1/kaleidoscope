import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { gallery } from "../../src/worker/routes/gallery";

const BASE = "https://kaleidoscope.ponderance.dev";

interface Row {
  id: string;
  title: string;
  author_name: string | null;
}

// A minimal in-memory stand-in for the D1 binding (env.DB). randomPublic() calls
// prepare(sql).bind(limit).all<...>(); we capture the bound limit and slice the seed.
function makeDB(rows: Row[]) {
  const calls: { limit: number }[] = [];
  return {
    calls,
    prepare() {
      let limit = 0;
      const stmt = {
        bind(l: number) {
          limit = l;
          calls.push({ limit: l });
          return stmt;
        },
        async all() {
          return { results: rows.slice(0, limit) };
        },
      };
      return stmt;
    },
  };
}

function app() {
  const a = new Hono();
  a.route("/api", gallery);
  return a;
}

function bindings(db: ReturnType<typeof makeDB>) {
  return { DB: db, PUBLIC_BASE_URL: BASE } as never;
}

function seed(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({ id: `id${i}`, title: `T${i}`, author_name: `A${i}` }));
}

describe("GET /api/gallery/random", () => {
  it("returns up to count items with absolute imageUrl/permalink and no-store", async () => {
    const db = makeDB(seed(10));
    const res = await app().request("/api/gallery/random?count=3", {}, bindings(db));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    const body = (await res.json()) as { items: { id: string; title: string; author: string; imageUrl: string; permalink: string }[] };
    expect(body.items).toHaveLength(3);
    expect(db.calls.at(-1)?.limit).toBe(3);
    expect(body.items[0]).toEqual({
      id: "id0",
      title: "T0",
      author: "A0",
      imageUrl: `${BASE}/api/artworks/id0/image`,
      permalink: `${BASE}/p/id0`,
    });
  });

  it("returns 200 {items:[]} for an empty gallery", async () => {
    const res = await app().request("/api/gallery/random", {}, bindings(makeDB([])));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [] });
  });

  it("defaults to 12 when count is missing or non-numeric", async () => {
    const db = makeDB(seed(50));
    await app().request("/api/gallery/random", {}, bindings(db));
    expect(db.calls.at(-1)?.limit).toBe(12);

    const db2 = makeDB(seed(50));
    await app().request("/api/gallery/random?count=abc", {}, bindings(db2));
    expect(db2.calls.at(-1)?.limit).toBe(12);
  });

  it("clamps count to 1..50", async () => {
    const lo = makeDB(seed(50));
    await app().request("/api/gallery/random?count=0", {}, bindings(lo));
    expect(lo.calls.at(-1)?.limit).toBe(1);

    const hi = makeDB(seed(80));
    const res = await app().request("/api/gallery/random?count=999", {}, bindings(hi));
    expect(hi.calls.at(-1)?.limit).toBe(50);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toHaveLength(50);
  });
});

describe("GET /api/gallery/random/image", () => {
  it("302-redirects to a random image with no-store", async () => {
    const res = await app().request("/api/gallery/random/image", {}, bindings(makeDB(seed(5))));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`${BASE}/api/artworks/id0/image`);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("404s when the gallery is empty", async () => {
    const res = await app().request("/api/gallery/random/image", {}, bindings(makeDB([])));
    expect(res.status).toBe(404);
  });
});
