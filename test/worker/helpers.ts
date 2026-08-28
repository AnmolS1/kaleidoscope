// Test doubles for the Worker's bindings. The D1 fake is backed by REAL
// in-memory SQLite (node:sqlite) with the actual migrations applied, so queries,
// constraints, and FK cascades behave exactly as in production.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// vitest runs with the repo root as cwd, so migrations resolve relative to it.
const MIG_DIR = join(process.cwd(), "migrations");
const migration = (f: string) => readFileSync(join(MIG_DIR, f), "utf8");

/** A D1Database-compatible shim over node:sqlite. */
export function makeD1(opts: { foreignKeys?: boolean } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(migration("0001_init.sql"));
  db.exec(migration("0002_apple_auth.sql"));
  db.exec(migration("0003_alt_text.sql"));
  db.exec(migration("0004_v12.sql"));
  if (opts.foreignKeys) db.exec("PRAGMA foreign_keys = ON;");

  function prepare(sql: string) {
    let args: unknown[] = [];
    const stmt = {
      bind(...a: unknown[]) {
        args = a;
        return stmt;
      },
      async first<T = unknown>(col?: string): Promise<T | null> {
        const row = db.prepare(sql).get(...(args as never[])) as Record<string, unknown> | undefined;
        if (!row) return null;
        return (col ? (row[col] as T) : (row as T)) ?? null;
      },
      async all<T = unknown>(): Promise<{ results: T[] }> {
        const rows = db.prepare(sql).all(...(args as never[])) as T[];
        return { results: rows };
      },
      // `meta.changes` is load-bearing, not decoration: the conditional publish
      // that enforces the public-post cap is a single UPDATE whose WHERE clause
      // carries the cap predicate, and "did the cap block this?" IS "did that
      // statement change 0 rows?". A shim that returned only `{ success: true }`
      // would let every cap test pass while asserting nothing.
      //
      // node:sqlite reports `changes` as a BigInt. `0n === 0` is false, so
      // without this coercion `changes === 0` never fires and `capReached` is
      // dead code. Number() here, and the shim's own test pins the type.
      async run() {
        const r = db.prepare(sql).run(...(args as never[]));
        return {
          success: true,
          meta: {
            changes: Number(r.changes),
            last_row_id: Number(r.lastInsertRowid),
          },
        };
      },
    };
    return stmt;
  }

  return { _db: db, prepare } as unknown as D1Database & { _db: DatabaseSync };
}

/** A KVNamespace-compatible shim. */
export function makeKV(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    store,
    async get(key: string, type?: string) {
      const v = store.get(key);
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
  };
}

/** An R2Bucket-compatible shim that records deletes and holds put objects. */
export function makeR2(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial));
  const deleted: string[] = [];
  return {
    store,
    deleted,
    async put(key: string, value: unknown) {
      store.set(key, value);
    },
    async get(key: string) {
      if (!store.has(key)) return null;
      const value = store.get(key);
      // A real R2 object's `body` is a ReadableStream, and the code under test
      // treats it as one (`serveVectorJson` pipes it through DecompressionStream;
      // the hash backfill reads it back). Streams are single-consumption, so this
      // builds a FRESH one per get() — a memoized body would break the second
      // read. `_raw` keeps the stored value reachable for assertions.
      return {
        _raw: value,
        get body() {
          return new Response(value as BodyInit).body;
        },
        async arrayBuffer() {
          return new Response(value as BodyInit).arrayBuffer();
        },
        httpEtag: '"x"',
        writeHttpMetadata() {},
      };
    },
    async delete(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) {
        deleted.push(k);
        store.delete(k);
      }
    },
  };
}

export const BASE = "https://kaleidoscope.ponderance.dev";

// ---- fixtures shared by the 1.2 worker tests -----------------------------

/**
 * A valid v1 drawing whose content hash is a function of `seed` — every seed is
 * a visually different picture, so two seeds never collide in the dedupe index
 * and the same seed always does.
 */
export function drawingV1(seed = 0, over: { bg?: string; segments?: number } = {}): string {
  return JSON.stringify({
    v: 1,
    bg: over.bg ?? "light",
    sym: { segments: over.segments ?? 6, mirror: true },
    strokes: [
      {
        tool: "solid",
        color: "#ff0000",
        size: 10,
        opacity: 1,
        pts: [
          [0, 0, 0.5],
          [seed / 100, 0.1, 0.5],
        ],
      },
    ],
  });
}

/** A v2 drawing with two layers under DIFFERENT symmetries — the case that
 *  stores `segments = 0` and has to read as "layered" everywhere. */
export function drawingV2MixedSym(seed = 0): string {
  const layer = (id: string, segments: number, x: number) => ({
    id,
    name: `Layer ${id.slice(1)}`,
    visible: true,
    opacity: 1,
    sym: { segments, mirror: false },
    strokes: [
      { tool: "solid", color: "#3fa34d", size: 8, opacity: 1, pts: [[x, 0, 0.5], [x + 0.1, 0.2, 0.5]] },
    ],
  });
  return JSON.stringify({ v: 2, bg: "dark", layers: [layer("l1", 6, seed / 100), layer("l2", 9, 0.3)] });
}

/** Insert a user directly. Returns the id. */
export function seedUser(
  db: ReturnType<typeof makeD1>,
  id: string,
  over: { role?: string; name?: string } = {},
): string {
  const now = Date.now();
  db._db
    .prepare(
      `INSERT INTO users (id, google_sub, apple_sub, email, name, avatar_url, role, flagged, created_at, last_seen_at)
       VALUES (?, ?, NULL, ?, ?, NULL, ?, 0, ?, ?)`,
    )
    .run(id, `g-${id}`, `${id}@example.test`, over.name ?? id, over.role ?? "user", now, now);
  return id;
}

/** Give a user an active Plus entitlement. */
export function seedPlus(db: ReturnType<typeof makeD1>, userId: string, source = "apple"): void {
  db._db
    .prepare(
      "INSERT INTO entitlements (source, external_id, user_id, product, environment, granted_at) VALUES (?, ?, ?, 'plus', 'Production', ?)",
    )
    .run(source, `ext-${userId}-${source}`, userId, Date.now());
}

/** Insert an artwork row directly, bypassing the save path. */
export function seedArtwork(
  db: ReturnType<typeof makeD1>,
  a: {
    id: string;
    user_id: string;
    visibility?: string;
    published_at?: number | null;
    created_at?: number;
    content_hash?: string | null;
    title?: string;
    segments?: number;
  },
): void {
  const created = a.created_at ?? Date.now();
  db._db
    .prepare(
      `INSERT INTO artworks
         (id, user_id, title, visibility, image_key, thumb_key, vector_key, width, height,
          segments, mirror, palette, remix_of, likes, created_at, alt_text, content_hash, layers, updated_at, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1024, 1024, ?, 1, NULL, NULL, 0, ?, 'alt', ?, 1, NULL, ?)`,
    )
    .run(
      a.id,
      a.user_id,
      a.title ?? "Piece",
      a.visibility ?? "public",
      `img/${a.id}.webp`,
      `thumb/${a.id}.webp`,
      `vec/${a.id}.json.gz`,
      a.segments ?? 6,
      created,
      a.content_hash ?? null,
      a.published_at === undefined
        ? (a.visibility ?? "public") === "public"
          ? created
          : null
        : a.published_at,
    );
}

/** Register a session id for a user in the KV shim. */
export function seedSession(sessions: ReturnType<typeof makeKV>, sid: string, userId: string): void {
  sessions.store.set(sid, JSON.stringify({ userId, csrf: `csrf-${sid}`, createdAt: Date.now() }));
}

/** A save multipart body. `title: null` omits the field entirely. */
export function saveForm(opts: {
  drawing: string;
  title?: string | null;
  visibility?: string;
}): FormData {
  const fd = new FormData();
  fd.set("drawing", opts.drawing);
  fd.set("image", new File([new Uint8Array([1, 2, 3])], "i.png", { type: "image/png" }));
  fd.set("thumb", new File([new Uint8Array([4, 5, 6])], "t.png", { type: "image/png" }));
  if (opts.title !== null) fd.set("title", opts.title ?? "A title");
  fd.set("visibility", opts.visibility ?? "public");
  return fd;
}

/** Bearer headers for a session, optionally announcing v2 client caps. */
export function bearer(sid: string, v2 = false): Record<string, string> {
  return v2
    ? { Authorization: `Bearer ${sid}`, "X-Client-Caps": "v2" }
    : { Authorization: `Bearer ${sid}` };
}

/** Minimal env with sane defaults; override per test. */
export function makeEnv(over: Record<string, unknown> = {}): never {
  return {
    PUBLIC_BASE_URL: BASE,
    GOOGLE_REDIRECT_URI: `${BASE}/api/auth/callback`,
    TURNSTILE_SITE_KEY: "site",
    APPLE_BUNDLE_ID: "dev.ponderance.kaleidoscope",
    RATELIMIT: makeKV(),
    ...over,
  } as never;
}
