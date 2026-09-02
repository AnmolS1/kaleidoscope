// The two Plus flags, and the deploy-config invariant that binds CAP_EPOCH to
// PLUS_ENABLED.
//
// REVIEW.md L1: one flag governed both "is the Plus UI visible" and "are the
// caps enforced". Since the caps must stay off until the IAP is approved, the
// surface was off too — App Review opens the app, finds no Plus row, no
// paywall, no Restore and no product, and rejects the BINARY under Guideline
// 2.1. Splitting the flag is the fix; these tests are what stop it silently
// re-merging.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import app from "../../src/worker/index";
import { makeD1, makeKV, makeR2, makeEnv, seedUser, seedSession, bearer } from "./helpers";

function ctx(over: Record<string, unknown> = {}) {
  const DB = makeD1();
  const SESSIONS = makeKV();
  seedUser(DB, "u1");
  seedSession(SESSIONS, "s1", "u1");
  return makeEnv({ DB, SESSIONS, ART: makeR2(), RATELIMIT: makeKV(), ...over });
}

async function me(env: unknown) {
  const res = await app.request("/api/me", { headers: bearer("s1") }, env as never);
  expect(res.status).toBe(200);
  return (await res.json()) as {
    plus: { enabled: boolean; surface: boolean; publicCap: number | null; layerCap: number };
  };
}

describe("PLUS_SURFACE_ENABLED is independent of PLUS_ENABLED", () => {
  // The combination that matters: the review window. The purchase must be
  // findable while nothing is capped.
  it("surface on, caps off — the reviewable state", async () => {
    const b = await me(ctx({ PLUS_ENABLED: "false", PLUS_SURFACE_ENABLED: "true" }));
    expect(b.plus.surface).toBe(true);
    expect(b.plus.enabled).toBe(false);
    // and nobody is capped by it
    expect(b.plus.publicCap).toBe(null);
    expect(b.plus.layerCap).toBe(8);
  });

  it("both off — the shipped state before submission", async () => {
    const b = await me(ctx({ PLUS_ENABLED: "false", PLUS_SURFACE_ENABLED: "false" }));
    expect(b.plus.surface).toBe(false);
    expect(b.plus.enabled).toBe(false);
  });

  it("caps on with the surface off is still expressible", async () => {
    const b = await me(ctx({ PLUS_ENABLED: "true", CAP_EPOCH: "1", PLUS_SURFACE_ENABLED: "false" }));
    expect(b.plus.enabled).toBe(true);
    expect(b.plus.surface).toBe(false);
  });

  it("an absent PLUS_SURFACE_ENABLED reads as hidden, not as enabled", async () => {
    const b = await me(ctx({ PLUS_ENABLED: "false" }));
    expect(b.plus.surface).toBe(false);
  });

  // The degrade path exists so a malformed CAP_EPOCH cannot take the app down.
  // It must not take the paywall down either: someone who has already paid
  // still needs Restore, and Restore lives on the surface.
  it("survives a malformed CAP_EPOCH — a broken cap must not hide Restore", async () => {
    const b = await me(ctx({ PLUS_ENABLED: "true", CAP_EPOCH: "xyz", PLUS_SURFACE_ENABLED: "true" }));
    expect(b.plus.enabled).toBe(false); // degraded
    expect(b.plus.surface).toBe(true); // but findable
  });
});

// REVIEW S18 gave the signed-out branch of /api/me a plus block, and gave it a
// bare `plusLayerCap` — so anyone who had not signed in was told the LAYER CAP
// was 8. Harmless while enforcement is off, and a silent giveaway the moment the
// flag is flipped: no sign-in required, no purchase required.
//
// Lives here and not in the e2e. The e2e runs against ONE deploy configuration,
// and under that configuration (`PLUS_ENABLED=false`) the wrong expression and
// the right one produce the same 8 — a test that cannot tell them apart, which
// is the shape of green that means nothing. Here the flag is an input.
describe("a signed-out visitor is a free user, in both directions", () => {
  async function anon(env: unknown) {
    const res = await app.request("/api/me", {}, env as never);
    expect(res.status).toBe(200);
    return (await res.json()) as { plus: { layerCap: number; enabled: boolean; active: boolean } };
  }

  it("gets the FREE cap once enforcement is on", async () => {
    const env = ctx({ PLUS_ENABLED: "true", CAP_EPOCH: "1000" });
    const { plus } = await anon(env);
    // The half that was wrong. `plusLayerCap` here would say 8.
    expect(plus.layerCap).toBe(3);
    expect(plus.active).toBe(false);
  });

  it("gets the FULL cap while enforcement is off, like everyone else", async () => {
    // Not a lesser answer either: while nobody is capped, being signed out must
    // not be a restriction of its own.
    const env = ctx({ PLUS_ENABLED: "false" });
    expect((await anon(env)).plus.layerCap).toBe(8);
  });

  it("answers exactly what a signed-in FREE account is told, under either flag", async () => {
    for (const enabled of ["true", "false"]) {
      const env = ctx({ PLUS_ENABLED: enabled, CAP_EPOCH: "1000" });
      const out = await anon(env);
      const res = await app.request("/api/me", { headers: bearer("s1") }, env as never);
      const inn = (await res.json()) as { plus: { layerCap: number } };
      expect(out.plus.layerCap, `PLUS_ENABLED=${enabled}`).toBe(inn.plus.layerCap);
    }
  });
});

describe("the deploy config itself", () => {
  const wrangler = readFileSync(join(process.cwd(), "wrangler.jsonc"), "utf8");
  const varOf = (k: string) => new RegExp(`"${k}"\\s*:\\s*"([^"]*)"`).exec(wrangler)?.[1];

  // REVIEW.md L2. `0` is the one value that defeats the fail-closed reasoning
  // in capPolicy: it parses, so the cap is enforced retroactively to the
  // beginning of time, and migration 0004 backfilled published_at for every
  // existing public row. The placeholder must fail the other way.
  it("CAP_EPOCH ships far in the future so a forgotten epoch counts nothing", () => {
    const epoch = Number(varOf("CAP_EPOCH"));
    expect(Number.isFinite(epoch)).toBe(true);
    expect(epoch).toBeGreaterThan(1.7e12);
  });

  // The pairing, which is the actual invariant: the placeholder is only safe
  // while enforcement is off. Flipping PLUS_ENABLED without setting a real
  // epoch in the SAME deploy is the mistake this refuses to let ship.
  it("PLUS_ENABLED=true requires a real CAP_EPOCH in the same deploy", () => {
    const enabled = varOf("PLUS_ENABLED") === "true";
    const epoch = Number(varOf("CAP_EPOCH"));
    const PLACEHOLDER = 4102444800000; // 2100-01-01
    expect(
      !enabled || (Number.isFinite(epoch) && epoch > 1.7e12 && epoch < PLACEHOLDER),
      "PLUS_ENABLED is true but CAP_EPOCH is still the far-future placeholder — "
        + "the caps would enforce against a timestamp nothing predates",
    ).toBe(true);
  });
});
