// Which of the save dialog's states is on screen — resolved as one pure
// function, deliberately away from the component.
//
// DESIGN.md §4 is "one dialog, eleven states". Eleven overlapping conditions
// decided inline in JSX is how two of them end up unreachable and nobody
// notices: a state that never renders looks exactly like a state that renders
// correctly and was never opened. Here the whole outcome map is one switch over
// plain data, so it is table-testable without a DOM (see
// test/unit/save-state.test.ts) — and a state that cannot be reached fails a
// test rather than shipping.
//
// Two things are NOT decided here, because they compose rather than exclude:
// the title error message and the cap note. Both hang off individual fields, so
// the dialog renders them whenever their condition holds regardless of `kind` —
// an at-cap dialog with an empty title has to show both.

import { isReservedTitle } from "../../shared/title";
import type { HashLookup } from "../api";

export type SaveStateKind =
  /** Pre-flight still in flight. Not one of the eleven — a placeholder. */
  | "checking"
  | "signed-out"
  | "nothing-visible"
  | "self-unchanged"
  | "other-unchanged"
  | "duplicate-other"
  | "duplicate-other-private"
  | "error"
  | "at-cap"
  | "title-error"
  | "self-changed"
  | "first";

/** What came back from POST /api/artworks, once it has been attempted. */
export type PostOutcome =
  /** 409 WITH `of`: a viewable twin, which can be named and linked. */
  | { kind: "duplicate-other"; of: string }
  /** 409 WITHOUT `of`: someone else's PRIVATE twin. Nothing to link to. */
  | { kind: "duplicate-other-private" }
  /** 201 capReached: the piece IS saved, unlisted, because the wall was full. */
  | { kind: "cap-reached"; id: string; cap: number; count: number }
  /** Network, Turnstile, or any other refusal. */
  | { kind: "error" };

export interface SaveStateInput {
  signedIn: boolean;
  /** Strokes on VISIBLE layers. Never the total — hidden ink saves blank. */
  visibleStrokes: number;
  /**
   * Pre-flight result. THREE values, not two: "pending" must not render the
   * form (it would flash and swap under the user's hands), and "failed" must —
   * the lookup is rate-limited, and a 429 there cannot be allowed to wedge the
   * dialog shut on a save that would have worked.
   */
  preflight: "pending" | "failed" | HashLookup;
  post: PostOutcome | null;
  /** Empty, whitespace, or "untitled" in any compatibility spelling. */
  titleInvalid: boolean;
  /** plus.enabled && publicCap != null && publicCount >= publicCap. */
  capReached: boolean;
  /** Remixing the user's OWN piece, and the drawing has since changed. */
  remixOfOwnChanged: boolean;
}

/**
 * Precedence, highest first, and each rung is a fact that makes the ones below
 * it moot:
 *
 *  1. no session          — nothing else can be asked; the pre-flight needs auth
 *  2. nothing visible     — there is no picture to talk about at all
 *  3. the POST's verdict  — newer information than the pre-flight, which ran
 *                           before the user typed anything
 *  4. the pre-flight      — a known twin, mine or someone else's
 *  5. the cap             — changes what the save DOES, so it outranks garnish
 *  6. a bad title         — blocks the save but only decorates one field
 *  7. an unchanged remix  — a hint, not a gate
 */
export function resolveSaveState(i: SaveStateInput): SaveStateKind {
  if (!i.signedIn) return "signed-out";
  if (i.visibleStrokes === 0) return "nothing-visible";

  if (i.post) {
    switch (i.post.kind) {
      case "duplicate-other":
        return "duplicate-other";
      case "duplicate-other-private":
        return "duplicate-other-private";
      case "error":
        return "error";
      case "cap-reached":
        return "at-cap";
    }
  }

  if (i.preflight === "pending") return "checking";
  // "failed" falls through to the ordinary form: a pre-flight that could not run
  // has learned nothing, and the POST still refuses a real duplicate.
  if (i.preflight !== "failed") {
    if (i.preflight.mine) return "self-unchanged";
    if (i.preflight.other) return "other-unchanged";
  }

  if (i.capReached) return "at-cap";
  if (i.titleInvalid) return "title-error";
  if (i.remixOfOwnChanged) return "self-changed";
  return "first";
}

/**
 * Is this a remix of the user's OWN piece that has since been drawn on?
 *
 * A pure function so the "unknown" case can be table-tested, because that is
 * the case that was wrong: a pre-flight that FAILED used to count as changed,
 * so a dropped request relabelled the button "Save as new" and printed "Remix
 * of <title>" — asserting a comparison that never happened.
 *
 * Unknown falls to FALSE, deliberately. False means the ordinary form, and the
 * POST still refuses a real duplicate, so the worst case is a save the server
 * dedupes. True would have the dialog state a fact about the drawing that we do
 * not have.
 */
export function isRemixOfOwnChanged(
  isOwnRemix: boolean,
  haveSourceHash: boolean,
  preflight: SaveStateInput["preflight"],
): boolean {
  if (!isOwnRemix || !haveSourceHash) return false;
  if (preflight === "pending" || preflight === "failed") return false;
  return preflight.mine === null;
}

/** States where the piece cannot be saved as it stands. */
export function saveBlocked(kind: SaveStateKind, titleInvalid: boolean): boolean {
  return (
    titleInvalid ||
    kind === "duplicate-other" ||
    kind === "duplicate-other-private" ||
    kind === "other-unchanged"
  );
}

/**
 * The primary button's label.
 *
 * Order matters and is not cosmetic: at the cap the button genuinely does
 * something else (it posts unlisted), so that claim outranks the remix hint.
 */
export function primaryLabel(kind: SaveStateKind, capReached: boolean, remixOfOwnChanged: boolean): string {
  if (kind === "error") return "Try again";
  if (capReached || kind === "at-cap") return "Save unlisted";
  if (remixOfOwnChanged) return "Save as new";
  return "Save piece";
}

/**
 * Is this title one the worker will refuse?
 *
 * Mirrors `validateTitle` in the Worker, NFKC included: compatibility
 * lookalikes such as fullwidth "ｕｎｔｉｔｌｅｄ" walk straight past a naive
 * comparison, and a client that let them through would turn a designed dialog
 * state into an unexplained 400.
 *
 * NOT the ﬁ ligature, which an earlier comment claimed: "untitled" has no "fi"
 * in it, and ﬁ folds to "fi", so "unti<ﬁ>tled" normalizes to "untifitled" and
 * is a valid title.
 */
export function titleIsInvalid(raw: string): boolean {
  const t = raw.trim();
  if (!t) return true;
  // The SAME function the Worker validates with. These used to be two copies of
  // one rule, agreeing by inspection; when the Worker learned about script
  // lookalikes the copy here did not, and a title the dialog accepted came back
  // a 400 with nothing to explain it (REVIEW.md minor mA2).
  return isReservedTitle(t);
}
