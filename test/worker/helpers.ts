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
      async run() {
        db.prepare(sql).run(...(args as never[]));
        return { success: true };
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
      return store.has(key) ? { body: store.get(key), httpEtag: '"x"', writeHttpMetadata() {} } : null;
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
