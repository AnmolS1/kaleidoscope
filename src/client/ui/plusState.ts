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
}

export function resolvePlusState(i: PlusStateInput): PlusStateKind {
  // An outcome outranks everything: it is the answer to the question the user
  // just asked, and it is cleared the moment they ask another one.
  if (i.outcome) return i.outcome.kind;
  if (i.busy) return "purchasing";
  if (!i.signedIn) return "sign-in";
  if (i.owned) return "purchased";
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
 * Lemon Squeezy ids are still empty. The generic message tells the user to "try
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
export function plusOutcomeForError(err: unknown): PlusOutcome {
  if (err instanceof ApiError) {
    if (err.status === 401) return { kind: "sign-in" };
    if (err.status === 409 && err.code === "bound_elsewhere") return { kind: "bound-elsewhere" };
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
