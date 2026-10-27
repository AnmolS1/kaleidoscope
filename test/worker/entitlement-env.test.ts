// Which entitlement environments count, and under which flags (STRIPE-PLAN T4).
//
// `liveEntitlement` in db.ts is the one predicate behind hasPlus/plusSources.
// Two providers write `environment`:
//   Apple  → 'Production' | 'Sandbox' | 'Xcode'
//   Stripe → 'Production' (live) | 'Test' (test mode)
//   comp   → NULL
// Each non-Production value must count exactly while its flag is on and stop
// counting the moment it goes off — no cleanup deploy. Anything else never
// counts: before this, PLUS_ALLOW_SANDBOX=true counted EVERY environment
// string, so a 'Test' row would have outlived PLUS_ALLOW_TEST for as long as
// the review window stayed open.

import { describe, it, expect } from "vitest";
import { hasPlus, plusSources } from "../../src/worker/lib/db";
import { makeD1, makeEnv, seedUser } from "./helpers";

type Flags = { PLUS_ALLOW_SANDBOX?: unknown; PLUS_ALLOW_TEST?: unknown };
type Row = { source?: string; externalId?: string; environment?: string | null; revoked?: boolean };

function ctx(flags: Flags, rows: Row[]) {
  const DB = makeD1();
  seedUser(DB, "u1");
  for (const [i, r] of rows.entries()) {
    DB._db
      .prepare(
        "INSERT INTO entitlements (source, external_id, user_id, product, environment, granted_at, revoked_at)"
          + " VALUES (?, ?, 'u1', 'plus', ?, 1, ?)",
      )
      .run(
        r.source ?? "apple",
        r.externalId ?? `ext-${i}`,
        r.environment === undefined ? "Production" : r.environment,
        r.revoked ? 2 : null,
      );
  }
  return makeEnv({ DB, ...flags });
}

async function counts(flags: Flags, row: Row): Promise<boolean> {
  const env = ctx(flags, [row]);
  const has = await hasPlus(env, "u1");
  // The two readers must never disagree.
  expect((await plusSources(env, "u1")).length > 0).toBe(has);
  return has;
}

const FLAG_COMBOS: { name: string; flags: Flags; sandbox: boolean; test: boolean }[] = [
  { name: "both off", flags: { PLUS_ALLOW_SANDBOX: "false", PLUS_ALLOW_TEST: "false" }, sandbox: false, test: false },
  { name: "sandbox on", flags: { PLUS_ALLOW_SANDBOX: "true", PLUS_ALLOW_TEST: "false" }, sandbox: true, test: false },
  { name: "test on", flags: { PLUS_ALLOW_SANDBOX: "false", PLUS_ALLOW_TEST: "true" }, sandbox: false, test: true },
  { name: "both on", flags: { PLUS_ALLOW_SANDBOX: "true", PLUS_ALLOW_TEST: "true" }, sandbox: true, test: true },
  { name: "both unset", flags: {}, sandbox: false, test: false },
];

describe("environment × flag matrix", () => {
  for (const c of FLAG_COMBOS) {
    describe(c.name, () => {
      it("Production always counts", async () => {
        expect(await counts(c.flags, { environment: "Production" })).toBe(true);
      });
      it("NULL (comp / legacy) always counts", async () => {
        expect(await counts(c.flags, { source: "comp", environment: null })).toBe(true);
      });
      it(`Sandbox counts iff PLUS_ALLOW_SANDBOX (${c.sandbox})`, async () => {
        expect(await counts(c.flags, { environment: "Sandbox" })).toBe(c.sandbox);
      });
      it(`Xcode counts iff PLUS_ALLOW_SANDBOX (${c.sandbox})`, async () => {
        expect(await counts(c.flags, { environment: "Xcode" })).toBe(c.sandbox);
      });
      it(`Test counts iff PLUS_ALLOW_TEST (${c.test})`, async () => {
        expect(await counts(c.flags, { source: "stripe", environment: "Test" })).toBe(c.test);
      });
      it("an unknown environment never counts", async () => {
        for (const environment of ["Staging", "production", "test", "", "Production "]) {
          expect(await counts(c.flags, { environment })).toBe(false);
        }
      });
      it("a revoked row never counts, whatever its environment", async () => {
        for (const environment of ["Production", "Sandbox", "Xcode", "Test", null]) {
          expect(await counts(c.flags, { environment, revoked: true })).toBe(false);
        }
      });
    });
  }
});

describe("flag parsing follows envFlag", () => {
  it("a JSON boolean true is honored for both flags", async () => {
    const flags = { PLUS_ALLOW_SANDBOX: true, PLUS_ALLOW_TEST: true };
    expect(await counts(flags, { environment: "Sandbox" })).toBe(true);
    expect(await counts(flags, { environment: "Test" })).toBe(true);
  });
  it("anything that is not 'true' reads as off", async () => {
    for (const v of ["1", "yes", "on", "TRUE-ish"]) {
      const flags = { PLUS_ALLOW_SANDBOX: v, PLUS_ALLOW_TEST: v };
      expect(await counts(flags, { environment: "Sandbox" })).toBe(false);
      expect(await counts(flags, { environment: "Test" })).toBe(false);
    }
  });
  it("CONTROL: 'true' with whitespace and case variation reads as on", async () => {
    const flags = { PLUS_ALLOW_SANDBOX: " TRUE ", PLUS_ALLOW_TEST: "True" };
    expect(await counts(flags, { environment: "Sandbox" })).toBe(true);
    expect(await counts(flags, { environment: "Test" })).toBe(true);
  });
});

describe("the flags are independent", () => {
  it("PLUS_ALLOW_TEST does not let Sandbox in", async () => {
    expect(await counts({ PLUS_ALLOW_TEST: "true" }, { environment: "Sandbox" })).toBe(false);
  });
  it("PLUS_ALLOW_SANDBOX does not let Test in", async () => {
    expect(await counts({ PLUS_ALLOW_SANDBOX: "true" }, { environment: "Test" })).toBe(false);
  });
});

describe("prod today: one unrevoked apple/Sandbox row, PLUS_ALLOW_SANDBOX=true", () => {
  it("keeps counting", async () => {
    const env = ctx({ PLUS_ALLOW_SANDBOX: "true" }, [{ source: "apple", environment: "Sandbox" }]);
    expect(await hasPlus(env, "u1")).toBe(true);
    expect(await plusSources(env, "u1")).toEqual(["apple"]);
  });
});

describe("apple and stripe rows coexist", () => {
  const rows: Row[] = [
    { source: "apple", environment: "Sandbox" },
    { source: "stripe", environment: "Test" },
    { source: "comp", environment: null },
  ];

  it("each source appears exactly while its environment is allowed", async () => {
    expect(await plusSources(ctx({}, rows), "u1")).toEqual(["comp"]);
    expect(await plusSources(ctx({ PLUS_ALLOW_SANDBOX: "true" }, rows), "u1")).toEqual(["apple", "comp"]);
    expect(await plusSources(ctx({ PLUS_ALLOW_TEST: "true" }, rows), "u1")).toEqual(["comp", "stripe"]);
    expect(
      await plusSources(ctx({ PLUS_ALLOW_SANDBOX: "true", PLUS_ALLOW_TEST: "true" }, rows), "u1"),
    ).toEqual(["apple", "comp", "stripe"]);
  });

  it("CONTROL: Production rows from both providers count with every flag off", async () => {
    const env = ctx({}, [
      { source: "apple", environment: "Production" },
      { source: "stripe", environment: "Production" },
    ]);
    expect(await plusSources(env, "u1")).toEqual(["apple", "stripe"]);
  });

  it("a disallowed row does not hide an allowed one from the same source", async () => {
    const env = ctx({}, [
      { source: "stripe", environment: "Test" },
      { source: "stripe", environment: "Production" },
    ]);
    expect(await plusSources(env, "u1")).toEqual(["stripe"]);
  });

  it("another user's rows never count for u1", async () => {
    const DB = makeD1();
    seedUser(DB, "u1");
    seedUser(DB, "u2");
    DB._db
      .prepare(
        "INSERT INTO entitlements (source, external_id, user_id, product, environment, granted_at)"
          + " VALUES ('apple', 'x', 'u2', 'plus', 'Production', 1)",
      )
      .run();
    const env = makeEnv({ DB, PLUS_ALLOW_SANDBOX: "true", PLUS_ALLOW_TEST: "true" });
    expect(await hasPlus(env, "u1")).toBe(false);
    expect(await hasPlus(env, "u2")).toBe(true);
  });
});
