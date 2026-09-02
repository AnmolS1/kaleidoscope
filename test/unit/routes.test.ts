// REVIEW.md minor mW4 — the studio's keyboard shortcuts ran on every route.
//
// Most of them were merely invisible: `b` set the tool signal for a canvas that
// was not mounted. `s` was not invisible. Pressed while reading someone else's
// piece it opened the save dialog for YOUR drawing, offering to publish work
// the page was not showing.
//
// The predicate lives in state.ts so the router and the key handler read the
// same definition. This pins it, including the boundary cases where "starts
// with /p/" is doing the work.

import { describe, expect, it } from "vitest";
import { isStudioRoute } from "../../src/client/state";

describe("isStudioRoute", () => {
  for (const path of ["/", "/anything-else", "/pieces", "/p", "/gallery/", "/mex"]) {
    it(`${path} is the studio`, () => {
      // "/p" and "/gallery/" matter: the router falls through to <Studio /> for
      // both, so the shortcuts must be live there or the two disagree about
      // which page the user is on.
      expect(isStudioRoute(path)).toBe(true);
    });
  }

  for (const path of ["/p/abc123", "/p/", "/gallery", "/me"]) {
    it(`${path} is not`, () => {
      expect(isStudioRoute(path)).toBe(false);
    });
  }
});
