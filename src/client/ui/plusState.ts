// Which of the Plus sheet's states is on screen, and the one place the web
// price string lives.
//
// Pure, and deliberately outside the component — the same reason `saveState.ts`
// exists. DESIGN.md §5 is "one sheet, six states"; a state whose condition can
// never hold renders nothing, breaks nothing, and looks exactly like a state
// nobody happened to open. Here the whole outcome map is a switch over plain
// data, so `test/unit/plus-state.test.ts` can table-test reachability with no
// DOM, and an unreachable state is a red test rather than a silence.

import { ApiError } from "../api";

/**
 * THE web price. One constant, and `test/unit/plus-state.test.ts` scans `src/`
 * and `ios/` to prove it is the only price-shaped literal in either tree.
 *
 * Client-only on purpose. It must never move to `src/shared/` or into a Worker
 * response: iOS reads `product.displayPrice` from StoreKit and an iOS build
 * that mentions the web price is App Review 3.1.1. A string in `shared/` is
 * exactly how that leak happens, so the leak is tested for, not just avoided.
 */
export const PLUS_PRICE = "$4.99";

export type PlusStateKind =
  /** `PlusBefore` — the pitch, the meter, and the buy button. */
  | "before"
  /** `PlusPurchasing` — checkout or restore in flight; button disabled. */
  | "purchasing"
  /** `PlusPurchased` — the entitlement is live for this account. */
  | "purchased"
  /** `PlusRestoreNone` — restore ran and this account owns nothing. */
  | "restore-none"
  /** `PlusBoundElsewhere` — the purchase belongs to a different account. */
  | "bound-elsewhere"
  /** `PlusSignIn` — no session, so a purchase would have nothing to attach to. */
  | "sign-in"
  /**
   * Not one of DESIGN.md's six. Back from Stripe Checkout, waiting for the
   * webhook's grant to show up in /api/me. Unlock is disabled: the person in
   * front of it has very probably just paid, and an enabled buy button is how
   * they pay twice.
   */
  | "confirming"
  /**
   * The confirmation window ran out without a grant. Not an error — the
   * payment may simply be slower than the polls — so it points at Restore and
   * still offers no buy button.
   */
  | "confirm-slow"
  /**
   * Not one of DESIGN.md's six. 429 / 503 / a dead network have to land
   * somewhere, and landing on the buy button ("nothing happened") is worse than
   * saying so. Deliberately LAST in the error map, after the codes that have
   * their own state.
   */
  | "error";

/** What an attempted checkout or restore turned into. */
export type PlusOutcome =
  | { kind: "purchased" }
  | { kind: "restore-none" }
  | { kind: "bound-elsewhere" }
  | { kind: "sign-in" }
  | { kind: "error"; message: string };

export interface PlusStateInput {
  /** A session exists. Without one there is no account to bind a purchase to. */
  signedIn: boolean;
  /** `plus.active` from /api/me — an entitlement the server already knows about. */
  owned: boolean;
  /** A checkout or restore is in flight. */
  busy: boolean;
  /** The last attempt's result, or null before anything has been attempted. */
  outcome: PlusOutcome | null;
  /** Where the post-checkout confirmation stands. Optional: "idle" when absent. */
  confirm?: ConfirmPhase;
}

/**
 * The post-checkout confirmation, as published by `state.ts`.
 * `idle` — nothing to confirm; `pending` — polling /api/me; `slow` — polled
 * out without seeing the grant.
 */
export type ConfirmPhase = "idle" | "pending" | "slow";

export function resolvePlusState(i: PlusStateInput): PlusStateKind {
  // An outcome outranks everything: it is the answer to the question the user
  // just asked, and it is cleared the moment they ask another one.
  if (i.outcome) return i.outcome.kind;
  if (i.busy) return "purchasing";
  if (!i.signedIn) return "sign-in";
  // Owned outranks confirming, so the sheet flips to "You're in." the moment
  // the grant lands, without anyone having to clear the confirm phase first.
  if (i.owned) return "purchased";
  if (i.confirm === "pending") return "confirming";
  if (i.confirm === "slow") return "confirm-slow";
  return "before";
}

export const RATE_LIMITED_MESSAGE =
  "Too many attempts just now. Give it a few minutes and try again.";
export const GENERIC_ERROR_MESSAGE =
  "Couldn't reach the checkout. Nothing was charged — try again in a moment.";
/**
 * A 503 from the checkout route is PERMANENT, not transient (minor).
 *
 * It means Plus is not on sale here yet — either the surface flag is off or the
 * Stripe key and price are not configured. The generic message tells the user to "try
 * again in a moment", which is advice about a condition no amount of retrying
 * changes; they then retry, and eventually collect a rate limit for it.
 */
export const UNAVAILABLE_MESSAGE =
  "Kaleidoscope Plus isn't on sale here yet. Nothing was charged.";

/**
 * Map a failed billing call onto a sheet state.
 *
 * The order matters and is the point of the function: `401` and
 * `409 bound_elsewhere` each have a state with an action on it ("Sign in",
 * "Switch account"). Letting either fall through to the generic error would
 * tell someone whose purchase is on another account to "try again in a moment"
 * forever.
 *
 * `409 bound_elsewhere` is only ever emitted by `POST /api/billing/apple`,
 * which is the iOS app's route — on web this branch is defensive. It is mapped
 * (and tested) here anyway because this file is the shared contract T14 mirrors
 * in Swift, and because an unmapped code is indistinguishable from a network
 * failure at the moment it first happens.
 */
// A 502 (Stripe refused the session or was unreachable) deliberately has no
// branch: it is transient and nothing was charged, which is exactly what the
// generic message says.
export function plusOutcomeForError(err: unknown): PlusOutcome {
  if (err instanceof ApiError) {
    if (err.status === 401) return { kind: "sign-in" };
    if (err.status === 409 && err.code === "bound_elsewhere") return { kind: "bound-elsewhere" };
    // The checkout route refused a second sale: this account already owns
    // Plus and the client's block was stale (another tab, a webhook that landed
    // after load). That is the purchased state, not an error — the sheet
    // refreshes the block when it sees it, so the rest of the UI agrees.
    if (err.status === 409 && err.code === "already_owned") return { kind: "purchased" };
    if (err.status === 429) return { kind: "error", message: RATE_LIMITED_MESSAGE };
    // Before the generic branch: 503 is "not on sale", which is a different
    // thing from "the network hiccuped" and deserves different advice.
    if (err.status === 503) return { kind: "error", message: UNAVAILABLE_MESSAGE };
  }
  return { kind: "error", message: GENERIC_ERROR_MESSAGE };
}

// Copy that carries the price takes it as an argument rather than reading the
// constant, so a unit test can prove the label is interpolated and not typed
// out a second time.
export function unlockLabel(price: string): string {
  return `Unlock for ${price}`;
}

export function priceFootnote(price: string): string {
  return `One-time purchase of ${price}.`;
}

/** The account menu's mono counter, e.g. "7 of 10 public posts". */
export function publicPostsLine(count: number, cap: number): string {
  return `${count} of ${cap} public posts`;
}

// ---- back from checkout ------------------------------------------------------

/** Shown while the post-checkout polls run. */
export const CONFIRMING_MESSAGE = "Confirming your purchase…";
/**
 * Shown when the polls run out. Calm on purpose: a slow webhook is normal, and
 * the person has most likely paid, so this must not read as a failure — nor
 * invite them to buy again.
 */
export const CONFIRM_SLOW_MESSAGE =
  "Your payment can take a minute to reach your account. Use Restore purchase in a moment to check again.";

/**
 * When to re-read /api/me after returning from checkout, in ms from the START.
 *
 * Offsets, not gaps: a slow /api/me must not push every later read back, or
 * the last one lands well after the window the copy above describes.
 */
export const CONFIRM_SCHEDULE_MS = [0, 1500, 3000, 6000] as const;

/**
 * How long one of those reads may take before it counts as "not yet".
 *
 * A failed read was already skipped, but a HUNG one — a stalled connection
 * that never resolves or rejects — was awaited forever, leaving the phase on
 * `pending` and both billing buttons disabled for the rest of the session.
 */
export const CONFIRM_READ_TIMEOUT_MS = 8000;

export type ConfirmResult = "granted" | "signed-out" | "slow";

export interface ConfirmDeps<T> {
  /** One read of the entitlement. Null means the session is gone. The signal
   *  aborts at the read's deadline; pass it on so the request is cancelled. */
  read: (signal: AbortSignal) => Promise<T | null>;
  /** Whether a block shows the grant. */
  isActive: (block: T) => boolean;
  /** Called with every fresh block, so the caller can publish it. */
  publish: (block: T) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  schedule?: readonly number[];
  /** A fresh deadline per read. Defaults to CONFIRM_READ_TIMEOUT_MS. */
  deadline?: () => AbortSignal;
}

/** Settles with the promise, or rejects when the signal aborts — whichever is
 *  first. Raced here rather than trusted to the reader: a reader that ignores
 *  its signal must still not hold the poll. */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * Poll for the webhook's grant on the schedule above, stopping early once it
 * is there. Injected clock and reader so the timing is unit-testable without
 * a DOM or a server.
 *
 * Every path returns a result — the caller turns it into a terminal confirm
 * phase, and a phase stuck on `pending` would leave Unlock disabled for good.
 * A failed read is skipped rather than fatal: one dropped request is not a
 * reason to stop checking. A read past its deadline counts as failed.
 */
export async function confirmPurchase<T>(d: ConfirmDeps<T>): Promise<ConfirmResult> {
  const start = d.now();
  for (const at of d.schedule ?? CONFIRM_SCHEDULE_MS) {
    const wait = start + at - d.now();
    if (wait > 0) await d.sleep(wait);
    let fresh: T | null;
    try {
      const signal = d.deadline?.() ?? AbortSignal.timeout(CONFIRM_READ_TIMEOUT_MS);
      fresh = await untilAborted(d.read(signal), signal);
    } catch {
      continue;
    }
    if (fresh === null) return "signed-out";
    d.publish(fresh);
    if (d.isActive(fresh)) return "granted";
  }
  return "slow";
}

/**
 * The URL to replace the current one with after reading `?plus=thanks`, or
 * null when the param is not there. Every other param and the hash survive.
 * Stripped so a reload, a bookmark, or a shared link does not replay it.
 */
export function stripCheckoutReturn(search: string, pathname: string, hash: string): string | null {
  const params = new URLSearchParams(search);
  if (params.get("plus") !== "thanks") return null;
  params.delete("plus");
  const q = params.toString();
  return `${pathname}${q ? `?${q}` : ""}${hash}`;
}
