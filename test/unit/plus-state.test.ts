import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/client/api";
import {
  GENERIC_ERROR_MESSAGE,
  UNAVAILABLE_MESSAGE,
  PLUS_PRICE,
  RATE_LIMITED_MESSAGE,
  plusOutcomeForError,
  priceFootnote,
  publicPostsLine,
  resolvePlusState,
  unlockLabel,
  type PlusStateInput,
  type PlusStateKind,
} from "../../src/client/ui/plusState";

// DESIGN.md §5 is "one sheet, six states". The failure this file exists to
// catch is the same one save-state.test.ts catches: a state whose condition can
// never hold renders nothing and is indistinguishable from a state nobody
// opened. Every state is named below with the input that must produce it.

const FREE: PlusStateInput = {
  signedIn: true,
  owned: false,
  busy: false,
  outcome: null,
};

describe("resolvePlusState — every state is reachable", () => {
  const table: Array<[PlusStateKind, Partial<PlusStateInput>]> = [
    ["before", {}],
    ["purchasing", { busy: true }],
    ["purchased", { owned: true }],
    ["sign-in", { signedIn: false }],
    ["restore-none", { outcome: { kind: "restore-none" } }],
    ["bound-elsewhere", { outcome: { kind: "bound-elsewhere" } }],
    ["error", { outcome: { kind: "error", message: "boom" } }],
  ];

  for (const [kind, patch] of table) {
    it(`produces "${kind}"`, () => {
      expect(resolvePlusState({ ...FREE, ...patch })).toBe(kind);
    });
  }

  it("covers every kind the type allows", () => {
    // A seventh state added to the union without a row here is a state with no
    // reachability proof; this is what turns that into a red test.
    const covered = new Set(table.map(([k]) => k));
    const all: PlusStateKind[] = [
      "before",
      "purchasing",
      "purchased",
      "restore-none",
      "bound-elsewhere",
      "sign-in",
      "error",
    ];
    expect([...covered].sort()).toEqual([...all].sort());
  });
});

describe("resolvePlusState — precedence", () => {
  it("an outcome outranks busy", () => {
    // Otherwise the answer to what the user just asked is hidden behind a
    // spinner that will never resolve again.
    expect(resolvePlusState({ ...FREE, busy: true, outcome: { kind: "purchased" } })).toBe(
      "purchased",
    );
  });

  it("a signed-out user is asked to sign in even mid-flight", () => {
    expect(resolvePlusState({ ...FREE, signedIn: false, owned: true })).toBe("sign-in");
  });

  it("an owner who opens the sheet sees the purchased state, not the pitch", () => {
    expect(resolvePlusState({ ...FREE, owned: true })).toBe("purchased");
  });
});

describe("plusOutcomeForError — codes that have their own state never fall through", () => {
  it("401 → sign-in", () => {
    expect(plusOutcomeForError(new ApiError(401, "unauthorized"))).toEqual({ kind: "sign-in" });
  });

  it("409 bound_elsewhere → bound-elsewhere", () => {
    // The state with "Switch account" on it. Falling through to the generic
    // error would tell someone whose purchase sits on another account to keep
    // retrying this one forever.
    expect(plusOutcomeForError(new ApiError(409, "bound_elsewhere", { error: "bound_elsewhere" })))
      .toEqual({ kind: "bound-elsewhere" });
  });

  it("a 409 that is NOT bound_elsewhere stays generic", () => {
    // The status alone must not be the trigger, or every future 409 silently
    // claims the purchase belongs to someone else.
    expect(plusOutcomeForError(new ApiError(409, "duplicate"))).toEqual({
      kind: "error",
      message: GENERIC_ERROR_MESSAGE,
    });
  });

  it("429 → its own message, not the generic one", () => {
    expect(plusOutcomeForError(new ApiError(429, "rate_limited"))).toEqual({
      kind: "error",
      message: RATE_LIMITED_MESSAGE,
    });
    expect(RATE_LIMITED_MESSAGE).not.toBe(GENERIC_ERROR_MESSAGE);
  });

  // 503 is PERMANENT — Plus is not on sale here yet — so it no longer shares
  // the generic "try again in a moment" message, which was advice about a
  // condition retrying cannot change.
  it("503 says it is not on sale; a network failure keeps the generic error", () => {
    expect(plusOutcomeForError(new ApiError(503, "not_enabled"))).toEqual({
      kind: "error",
      message: UNAVAILABLE_MESSAGE,
    });
    expect(plusOutcomeForError(new ApiError(503, "not_configured"))).toEqual({
      kind: "error",
      message: UNAVAILABLE_MESSAGE,
    });
    expect(plusOutcomeForError(new TypeError("Failed to fetch"))).toEqual({
      kind: "error",
      message: GENERIC_ERROR_MESSAGE,
    });
    // The three messages are distinct, or the split achieves nothing.
    expect(new Set([UNAVAILABLE_MESSAGE, GENERIC_ERROR_MESSAGE, RATE_LIMITED_MESSAGE]).size).toBe(3);
    // And it does not promise a retry will help.
    expect(UNAVAILABLE_MESSAGE).not.toMatch(/try again/i);
  });

  it("the generic message says nothing was charged", () => {
    expect(GENERIC_ERROR_MESSAGE).toContain("Nothing was charged");
  });
});

describe("price copy is interpolated, never typed twice", () => {
  it("labels use the price they are handed", () => {
    // Passing a price that is NOT the constant is the whole point: asserting
    // "$4.99" against the real constant passes just as well when the label has
    // the number baked into it.
    expect(unlockLabel("$9.99")).toBe("Unlock for $9.99");
    expect(priceFootnote("$9.99")).toBe("One-time purchase of $9.99.");
  });

  it("the account-menu counter is interpolated too", () => {
    expect(publicPostsLine(7, 10)).toBe("7 of 10 public posts");
  });
});

// ---- the price lives in exactly one place, and not in the app --------------
//
// Two failures at once, both invisible until a release:
//   1. a second hardcoded "$4.99" that drifts from the constant;
//   2. the string reaching `src/shared/` (imported by the worker), a Worker
//      response, or `ios/` — an iOS build that names the web price is App
//      Review 3.1.1, and a shared string is exactly how it gets there.

// `?raw` via import.meta.glob rather than node:fs: tsconfig.app.json covers
// test/unit and has no node types, and contrast.test.ts already set the raw
// precedent for reading source files as strings here.
const SRC = import.meta.glob("/src/**/*.{ts,tsx,css}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;
const IOS = import.meta.glob("/ios/**/*.{swift,plist,json,yml,strings}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const PRICE_SHAPED = /\$\d+\.\d{2}/g;

describe("PLUS_PRICE is the only price in the shipped trees", () => {
  it("actually read some files, so a bad glob cannot pass vacuously", () => {
    expect(Object.keys(SRC).length).toBeGreaterThan(30);
    expect(Object.keys(IOS).length).toBeGreaterThan(10);
  });

  it("appears once in src/, in plusState.ts, and nowhere in ios/", () => {
    const hits: string[] = [];
    for (const [path, text] of [...Object.entries(SRC), ...Object.entries(IOS)]) {
      for (const m of text.matchAll(PRICE_SHAPED)) hits.push(`${path}: ${m[0]}`);
    }
    expect(hits).toEqual(["/src/client/ui/plusState.ts: " + PLUS_PRICE]);
  });

  it("is not named in src/shared or src/worker", () => {
    // The leak path that matters: anything under shared/ is compiled into the
    // Worker and read by the iOS client.
    for (const [path, text] of Object.entries(SRC)) {
      if (!path.startsWith("/src/shared") && !path.startsWith("/src/worker")) continue;
      expect(text, path).not.toContain("PLUS_PRICE");
    }
  });
});
