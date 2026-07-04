import { describe, it, expect, vi, afterEach } from "vitest";
import { Hono } from "hono";
import { gallery } from "../../src/worker/routes/gallery";
import { keys, cacheRemoteAvatar, serveAvatar, AVATAR_CACHE } from "../../src/worker/lib/r2";

interface Stored {
  bytes: Uint8Array;
  contentType: string;
}

// A minimal in-memory stand-in for the R2 bucket binding (env.ART).
function makeBucket(seed: Record<string, Stored> = {}) {
  const store = new Map<string, Stored>(Object.entries(seed));
  return {
    store,
    async get(key: string) {
      const e = store.get(key);
      if (!e) return null;
      return {
        body: e.bytes,
        httpEtag: '"test-etag"',
        writeHttpMetadata(h: Headers) {
          h.set("Content-Type", e.contentType);
        },
      };
    },
    async put(key: string, body: ArrayBuffer, opts?: { httpMetadata?: { contentType?: string } }) {
      store.set(key, {
        bytes: new Uint8Array(body),
        contentType: opts?.httpMetadata?.contentType ?? "application/octet-stream",
      });
    },
  };
}

function app() {
  const a = new Hono();
  a.route("/api", gallery);
  return a;
}

afterEach(() => vi.restoreAllMocks());

describe("GET /api/users/:id/avatar", () => {
  it("404s when no avatar is stored", async () => {
    const res = await app().request("/api/users/u1/avatar", {}, { ART: makeBucket() } as never);
    expect(res.status).toBe(404);
  });

  it("serves the cached bytes with short-lived cache headers", async () => {
    const bucket = makeBucket({ [keys.avatar("u1")]: { bytes: new Uint8Array([1, 2, 3, 4]), contentType: "image/png" } });
    const res = await app().request("/api/users/u1/avatar", {}, { ART: bucket } as never);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Cache-Control")).toBe(AVATAR_CACHE);
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual([1, 2, 3, 4]);
  });
});

describe("cacheRemoteAvatar", () => {
  it("fetches a size-normalized URL, stores image bytes, returns true", async () => {
    const bucket = makeBucket();
    let fetchedUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        fetchedUrl = url;
        return new Response(new Uint8Array([9, 9, 9]).buffer, { status: 200, headers: { "content-type": "image/png" } });
      }),
    );

    const ok = await cacheRemoteAvatar({ ART: bucket } as never, "u1", "https://lh3.googleusercontent.com/a/abc=s96-c");
    expect(ok).toBe(true);
    expect(fetchedUrl).toContain("=s192-c");
    expect(bucket.store.has(keys.avatar("u1"))).toBe(true);
  });

  it("rejects non-image content types without storing", async () => {
    const bucket = makeBucket();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } })),
    );
    const ok = await cacheRemoteAvatar({ ART: bucket } as never, "u1", "https://example.test/pic");
    expect(ok).toBe(false);
    expect(bucket.store.size).toBe(0);
  });

  it("returns false (never throws) when the fetch fails", async () => {
    const bucket = makeBucket();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network");
      }),
    );
    await expect(cacheRemoteAvatar({ ART: bucket } as never, "u1", "https://example.test/pic")).resolves.toBe(false);
  });
});

describe("serveAvatar", () => {
  it("returns null when nothing is stored", async () => {
    expect(await serveAvatar({ ART: makeBucket() } as never, "nobody")).toBeNull();
  });
});
