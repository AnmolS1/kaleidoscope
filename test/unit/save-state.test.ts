import { describe, expect, it } from "vitest";
import {
  isRemixOfOwnChanged,
  primaryLabel,
  resolveSaveState,
  saveBlocked,
  titleIsInvalid,
  type SaveStateInput,
  type SaveStateKind,
} from "../../src/client/ui/saveState";

// DESIGN.md §4 is "one dialog, eleven states". The failure mode this file exists
// to catch is a state that can never be reached: it renders nothing, breaks
// nothing, and looks exactly like a state nobody happened to open. Every row
// below names the state it must produce, so an unreachable one is a red test
// rather than a silence.

const CLEAN: SaveStateInput = {
  signedIn: true,
  visibleStrokes: 3,
  preflight: { mine: null, other: null },
  post: null,
  titleInvalid: false,
  capReached: false,
  remixOfOwnChanged: false,
};

const OTHER = { id: "a1", title: "Dawn Bloom", author: "Priya" };

describe("resolveSaveState — every state is reachable", () => {
  const table: Array<[SaveStateKind, Partial<SaveStateInput>]> = [
    ["signed-out", { signedIn: false }],
    ["nothing-visible", { visibleStrokes: 0 }],
    ["checking", { preflight: "pending" }],
    ["self-unchanged", { preflight: { mine: "x1", other: null } }],
    ["other-unchanged", { preflight: { mine: null, other: OTHER } }],
    ["duplicate-other", { post: { kind: "duplicate-other", of: "a1" } }],
    ["duplicate-other-private", { post: { kind: "duplicate-other-private" } }],
    ["error", { post: { kind: "error" } }],
    ["at-cap", { capReached: true }],
    ["title-error", { titleInvalid: true }],
    ["self-changed", { remixOfOwnChanged: true }],
    ["first", {}],
  ];

  for (const [expected, patch] of table) {
    it(`renders ${expected}`, () => {
      expect(resolveSaveState({ ...CLEAN, ...patch })).toBe(expected);
    });
  }

  it("covers all twelve kinds — eleven states plus the pre-flight placeholder", () => {
    expect(new Set(table.map(([k]) => k)).size).toBe(12);
  });
});

describe("resolveSaveState — precedence between states that co-occur", () => {
  // Each of these pairs is REACHED by a real flow, so the outcome is a decision,
  // not a tie-break nobody will hit.

  it("signed-out beats everything — the pre-flight needs a session to run at all", () => {
    expect(
      resolveSaveState({ ...CLEAN, signedIn: false, visibleStrokes: 0, capReached: true }),
    ).toBe("signed-out");
  });

  it("nothing-visible beats self-unchanged (remixing a hidden-only piece hits both)", () => {
    expect(
      resolveSaveState({ ...CLEAN, visibleStrokes: 0, preflight: { mine: "x1", other: null } }),
    ).toBe("nothing-visible");
  });

  it("the POST's verdict beats the pre-flight — it is the newer information", () => {
    expect(
      resolveSaveState({
        ...CLEAN,
        preflight: { mine: null, other: null },
        post: { kind: "duplicate-other-private" },
      }),
    ).toBe("duplicate-other-private");
  });

  it("at-cap beats self-changed: the cap changes what the button DOES", () => {
    expect(resolveSaveState({ ...CLEAN, capReached: true, remixOfOwnChanged: true })).toBe("at-cap");
  });

  it("at-cap beats title-error as the body, and the title error still renders alongside", () => {
    expect(resolveSaveState({ ...CLEAN, capReached: true, titleInvalid: true })).toBe("at-cap");
    // Compositional, which is the whole reason precedence here is safe.
    expect(saveBlocked("at-cap", true)).toBe(true);
  });
});

describe("resolveSaveState — pending and failed are NOT the same null", () => {
  it("pending renders the placeholder, never the form", () => {
    expect(resolveSaveState({ ...CLEAN, preflight: "pending" })).toBe("checking");
  });

  it("pending outranks a cap and a remix hint — the body has not been decided yet", () => {
    expect(
      resolveSaveState({ ...CLEAN, preflight: "pending", capReached: true, remixOfOwnChanged: true }),
    ).toBe("checking");
  });

  it("failed falls through to the ordinary form — a 429 must not wedge the dialog", () => {
    expect(resolveSaveState({ ...CLEAN, preflight: "failed" })).toBe("first");
  });

  it("failed still yields to the cap and to a bad title", () => {
    expect(resolveSaveState({ ...CLEAN, preflight: "failed", capReached: true })).toBe("at-cap");
    expect(resolveSaveState({ ...CLEAN, preflight: "failed", titleInvalid: true })).toBe(
      "title-error",
    );
  });

  it("a POST verdict is honoured even while the pre-flight is still pending", () => {
    // Not hypothetical: a slow/failed lookup does not stop the user saving, and
    // a 409 can land first.
    expect(
      resolveSaveState({ ...CLEAN, preflight: "pending", post: { kind: "duplicate-other", of: "z" } }),
    ).toBe("duplicate-other");
  });
});

describe("saveBlocked", () => {
  it("blocks the states that have no saveable piece", () => {
    expect(saveBlocked("duplicate-other", false)).toBe(true);
    expect(saveBlocked("duplicate-other-private", false)).toBe(true);
    expect(saveBlocked("other-unchanged", false)).toBe(true);
  });

  it("blocks any state with an invalid title", () => {
    expect(saveBlocked("first", true)).toBe(true);
    expect(saveBlocked("self-changed", true)).toBe(true);
  });

  it("does not block the states that can save", () => {
    for (const k of ["first", "at-cap", "self-changed", "error"] as SaveStateKind[]) {
      expect(saveBlocked(k, false)).toBe(false);
    }
  });
});

describe("primaryLabel", () => {
  it("names what the button will actually do", () => {
    expect(primaryLabel("first", false, false)).toBe("Save piece");
    expect(primaryLabel("self-changed", false, true)).toBe("Save as new");
    expect(primaryLabel("at-cap", true, false)).toBe("Save unlisted");
    expect(primaryLabel("error", false, false)).toBe("Try again");
  });

  it("prefers the cap over the remix hint — an at-cap save posts unlisted", () => {
    expect(primaryLabel("at-cap", true, true)).toBe("Save unlisted");
  });

  it("a retry is a retry, cap or not", () => {
    expect(primaryLabel("error", true, true)).toBe("Try again");
  });
});

describe("titleIsInvalid — mirrors the Worker's validateTitle", () => {
  it("rejects empty and whitespace", () => {
    expect(titleIsInvalid("")).toBe(true);
    expect(titleIsInvalid("   ")).toBe(true);
  });

  it("rejects 'untitled' in every casing", () => {
    expect(titleIsInvalid("Untitled")).toBe(true);
    expect(titleIsInvalid("UNTITLED")).toBe(true);
    expect(titleIsInvalid("  untitled  ")).toBe(true);
  });

  it("rejects the compatibility spellings NFKC folds, exactly as the Worker does", () => {
    // Fullwidth. A naive lowercase comparison lets this straight through, and
    // the client would then hand the user an unexplained 400 instead of the
    // designed SaveTitleError state.
    expect(titleIsInvalid("ｕｎｔｉｔｌｅｄ")).toBe(true);
  });

  it("accepts a real name", () => {
    expect(titleIsInvalid("Dawn Bloom")).toBe(false);
    expect(titleIsInvalid("Untitled Symphony")).toBe(false);
  });
});

// REVIEW.md minor mW6 — the pre-flight has three answers, not two, and the
// third used to be read as one of the other two.
describe("isRemixOfOwnChanged: which way an unknown pre-flight falls", () => {
  const CASES: Array<[string, boolean, boolean, SaveStateInput["preflight"], boolean]> = [
    // label                          ownRemix  haveHash  preflight                    expected
    ["not a remix at all",            false,    true,     { mine: null, other: null },  false],
    ["someone else's piece",          false,    true,     { mine: "a", other: null },   false],
    ["own remix, no source hash",     true,     false,    { mine: null, other: null },  false],
    ["own remix, drawn on since",     true,     true,     { mine: null, other: null },  true],
    ["own remix, untouched",          true,     true,     { mine: "a", other: null },   false],
    ["pre-flight still running",      true,     true,     "pending",                    false],
    // THE ONE THIS EXISTS FOR. A request that never came back has learned
    // nothing. It used to return true, which relabelled the button "Save as
    // new" and printed "Remix of <title>" — a claim about a comparison the app
    // never made. False means the ordinary form; the POST still refuses a real
    // duplicate, so guessing buys nothing and can only lie.
    ["pre-flight FAILED",             true,     true,     "failed",                     false],
  ];

  for (const [label, own, hash, preflight, expected] of CASES) {
    it(`${label} → ${expected}`, () => {
      expect(isRemixOfOwnChanged(own, hash, preflight)).toBe(expected);
    });
  }

  it("and a failed pre-flight leaves the button saying 'Save piece'", () => {
    const changed = isRemixOfOwnChanged(true, true, "failed");
    expect(primaryLabel(resolveSaveState({ ...CLEAN, preflight: "failed", remixOfOwnChanged: changed }), false, changed))
      .toBe("Save piece");
  });

  it("CONTROL: a genuinely changed own-remix still says 'Save as new'", () => {
    const changed = isRemixOfOwnChanged(true, true, { mine: null, other: null });
    expect(changed).toBe(true);
    expect(primaryLabel(resolveSaveState({ ...CLEAN, remixOfOwnChanged: changed }), false, changed))
      .toBe("Save as new");
  });
});

// REVIEW.md minor mA2 — the client and the Worker now compile ONE definition of
// the reserved title, so a title the dialog accepts cannot come back a 400.
describe("titleIsInvalid agrees with the Worker on lookalikes", () => {
  for (const [why, title] of [
    ["plain", "Untitled"],
    ["padded and cased", "  UnTiTlEd  "],
    ["fullwidth (NFKC)", "ｕｎｔｉｔｌｅｄ"],
    ["Turkish dotless i", "Untıtled"],
    ["Cyrillic e", "Untitlеd"],
    ["Greek tau", "Unτitled"],
  ] as Array<[string, string]>) {
    it(`rejects ${why}`, () => {
      expect(titleIsInvalid(title)).toBe(true);
    });
  }

  for (const [why, title] of [
    ["a title that contains it", "Untitled Study No. 4"],
    ["a Turkish word", "ışık"],
    ["a Cyrillic name", "Сергей"],
  ] as Array<[string, string]>) {
    it(`CONTROL: accepts ${why}`, () => {
      expect(titleIsInvalid(title)).toBe(false);
    });
  }
});
