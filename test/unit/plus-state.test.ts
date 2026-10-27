import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/client/api";
import {
  CONFIRMING_MESSAGE,
  CONFIRM_READ_TIMEOUT_MS,
  CONFIRM_SCHEDULE_MS,
  CONFIRM_SLOW_MESSAGE,
  GENERIC_ERROR_MESSAGE,
  UNAVAILABLE_MESSAGE,
  PLUS_PRICE,
  RATE_LIMITED_MESSAGE,
  plusOutcomeForError,
  confirmPurchase,
  priceFootnote,
  publicPostsLine,
  stripCheckoutReturn,
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
    ["confirming", { confirm: "pending" }],
    ["confirm-slow", { confirm: "slow" }],
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
      "confirming",
      "confirm-slow",
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

  it("409 already_owned → purchased, not an error", () => {
    // The server refused a second sale because this account already owns
    // Plus — the client's block was stale (another tab, a webhook that landed
    // after load). The true answer is "You're in.", and the sheet refreshes the
    // block so everything else agrees. An error here would invite a retry that
    // gets the same 409 forever.
    expect(plusOutcomeForError(new ApiError(409, "already_owned", { error: "already_owned" })))
      .toEqual({ kind: "purchased" });
  });

  it("CONTROL: already_owned on any status but 409 is not trusted as ownership", () => {
    expect(plusOutcomeForError(new ApiError(500, "already_owned")).kind).toBe("error");
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

  it("502 checkout_failed (Stripe refused) falls through to the generic message", () => {
    // Transient, and nothing was charged — which is what the generic copy
    // says. Neither "not on sale" nor "too many attempts" is true of it.
    expect(plusOutcomeForError(new ApiError(502, "checkout_failed", { error: "checkout_failed" })))
      .toEqual({ kind: "error", message: GENERIC_ERROR_MESSAGE });
  });
});

describe("resolvePlusState — back from checkout", () => {
  it("the grant outranks confirming, so the sheet flips the moment it lands", () => {
    expect(resolvePlusState({ ...FREE, owned: true, confirm: "pending" })).toBe("purchased");
    expect(resolvePlusState({ ...FREE, owned: true, confirm: "slow" })).toBe("purchased");
  });

  it("an answer the user just asked for (Restore) outranks the slow note", () => {
    expect(resolvePlusState({ ...FREE, confirm: "slow", outcome: { kind: "restore-none" } })).toBe(
      "restore-none",
    );
  });

  it("idle and absent both mean the ordinary sheet", () => {
    expect(resolvePlusState({ ...FREE, confirm: "idle" })).toBe("before");
    expect(resolvePlusState(FREE)).toBe("before");
  });

  it("a signed-out user is asked to sign in, not told a purchase is confirming", () => {
    expect(resolvePlusState({ ...FREE, signedIn: false, confirm: "pending" })).toBe("sign-in");
  });

  it("the copy is calm, points at Restore, and names no price", () => {
    expect(CONFIRMING_MESSAGE).not.toBe(CONFIRM_SLOW_MESSAGE);
    expect(CONFIRM_SLOW_MESSAGE).toContain("Restore purchase");
    for (const m of [CONFIRMING_MESSAGE, CONFIRM_SLOW_MESSAGE]) {
      expect(m).not.toContain("!");
      expect(m).not.toMatch(/\$\d/);
    }
  });
});

/** A fake clock: `sleep` advances it, and `read` can take time of its own. */
function fakeClock() {
  let t = 1_000_000;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    sleep: (ms: number) => {
      t += ms;
      return Promise.resolve();
    },
  };
}

describe("confirmPurchase — polls for the webhook's grant", () => {
  it("the schedule is 0 / 1.5 / 3 / 6 s", () => {
    expect([...CONFIRM_SCHEDULE_MS]).toEqual([0, 1500, 3000, 6000]);
  });

  it("reads are measured from the START, not as gaps after a slow read", async () => {
    // Each read takes a full second. Gap-based waits would land at
    // 0 / 2.5 / 6.5 / 13.5 s; offsets from the start keep the schedule.
    const clock = fakeClock();
    const start = clock.now();
    const at: number[] = [];
    const r = await confirmPurchase<{ active: boolean }>({
      read: () => {
        at.push(clock.now() - start);
        clock.advance(1000);
        return Promise.resolve({ active: false });
      },
      isActive: (b) => b.active,
      publish: () => {},
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(at).toEqual([0, 1500, 3000, 6000]);
    expect(r).toBe("slow");
  });

  it("a read slower than the gap to the next one does not wait at all", async () => {
    const clock = fakeClock();
    const start = clock.now();
    const at: number[] = [];
    const sleeps: number[] = [];
    await confirmPurchase<{ active: boolean }>({
      read: () => {
        at.push(clock.now() - start);
        clock.advance(2000);
        return Promise.resolve({ active: false });
      },
      isActive: (b) => b.active,
      publish: () => {},
      now: clock.now,
      sleep: (ms) => {
        sleeps.push(ms);
        return clock.sleep(ms);
      },
    });
    // 0 → (2s read, already past 1.5) → 2000 → (past 3s) → 4000 → wait 2s → 6000
    expect(at).toEqual([0, 2000, 4000, 6000]);
    expect(sleeps.every((ms) => ms > 0)).toBe(true);
  });

  it("stops at the first read that shows the grant, and publishes every block", async () => {
    const clock = fakeClock();
    const blocks = [{ active: false }, { active: false }, { active: true }];
    let reads = 0;
    const published: boolean[] = [];
    const r = await confirmPurchase<{ active: boolean }>({
      read: () => Promise.resolve(blocks[reads++]),
      isActive: (b) => b.active,
      publish: (b) => published.push(b.active),
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(r).toBe("granted");
    expect(reads).toBe(3);
    expect(published).toEqual([false, false, true]);
  });

  it("a failed read is skipped, not fatal", async () => {
    const clock = fakeClock();
    let reads = 0;
    const r = await confirmPurchase<{ active: boolean }>({
      read: () => {
        reads++;
        return reads === 1 ? Promise.reject(new TypeError("Failed to fetch")) : Promise.resolve({ active: true });
      },
      isActive: (b) => b.active,
      publish: () => {},
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(r).toBe("granted");
    expect(reads).toBe(2);
  });

  it("every read failing still ends, as slow — never stuck pending", async () => {
    const clock = fakeClock();
    let reads = 0;
    const r = await confirmPurchase<{ active: boolean }>({
      read: () => {
        reads++;
        return Promise.reject(new Error("down"));
      },
      isActive: (b) => b.active,
      publish: () => {},
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(r).toBe("slow");
    expect(reads).toBe(CONFIRM_SCHEDULE_MS.length);
  });

  it("each read gets 8 s before it counts as \"not yet\"", () => {
    expect(CONFIRM_READ_TIMEOUT_MS).toBe(8000);
  });

  it("a read that NEVER answers still ends, as slow — never stuck confirming", async () => {
    // A hung /api/me (a stalled connection, a captive portal) never resolves
    // and never rejects. Without a deadline the poll awaits it forever, the
    // phase stays `pending`, and Unlock and Restore stay disabled for good.
    const clock = fakeClock();
    let reads = 0;
    const signals: AbortSignal[] = [];
    const r = await confirmPurchase<{ active: boolean }>({
      read: (signal) => {
        reads++;
        signals.push(signal);
        return new Promise(() => {});
      },
      isActive: (b) => b.active,
      publish: () => {},
      now: clock.now,
      sleep: clock.sleep,
      // Already expired, so the test does not wait 8 s per read.
      deadline: () => AbortSignal.abort(new DOMException("timed out", "TimeoutError")),
    });
    expect(r).toBe("slow");
    expect(reads).toBe(CONFIRM_SCHEDULE_MS.length);
    // The signal reaches the reader, so the real one can cancel its fetch.
    expect(signals.every((s) => s.aborted)).toBe(true);
  });

  it("a hung read is skipped, and the next one can still see the grant", async () => {
    const clock = fakeClock();
    let reads = 0;
    const r = await confirmPurchase<{ active: boolean }>({
      read: () => (++reads === 1 ? new Promise(() => {}) : Promise.resolve({ active: true })),
      isActive: (b) => b.active,
      publish: () => {},
      now: clock.now,
      sleep: clock.sleep,
      // Only the first read's deadline has passed.
      deadline: () => (reads === 0 ? AbortSignal.abort() : new AbortController().signal),
    });
    expect(r).toBe("granted");
    expect(reads).toBe(2);
  });

  it("CONTROL: a read that answers in time is not cut off by its deadline", async () => {
    const clock = fakeClock();
    const r = await confirmPurchase<{ active: boolean }>({
      read: () => Promise.resolve({ active: true }),
      isActive: (b) => b.active,
      publish: () => {},
      now: clock.now,
      sleep: clock.sleep,
      deadline: () => new AbortController().signal,
    });
    expect(r).toBe("granted");
  });

  it("a lapsed session (null) stops at once and publishes nothing", async () => {
    const clock = fakeClock();
    let reads = 0;
    const published: unknown[] = [];
    const r = await confirmPurchase<{ active: boolean }>({
      read: () => {
        reads++;
        return Promise.resolve(null);
      },
      isActive: (b) => b.active,
      publish: (b) => published.push(b),
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(r).toBe("signed-out");
    expect(reads).toBe(1);
    expect(published).toEqual([]);
  });
});

describe("stripCheckoutReturn", () => {
  it("is null without the param, so nothing else is ever rewritten", () => {
    expect(stripCheckoutReturn("", "/", "")).toBeNull();
    expect(stripCheckoutReturn("?plus=other", "/", "")).toBeNull();
    expect(stripCheckoutReturn("?keep=1", "/gallery", "#x")).toBeNull();
  });

  it("drops only `plus`, keeping other params and the hash", () => {
    expect(stripCheckoutReturn("?plus=thanks", "/", "")).toBe("/");
    expect(stripCheckoutReturn("?plus=thanks&keep=1", "/", "#h")).toBe("/?keep=1#h");
    expect(stripCheckoutReturn("?a=1&plus=thanks&b=2", "/p/x", "")).toBe("/p/x?a=1&b=2");
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
