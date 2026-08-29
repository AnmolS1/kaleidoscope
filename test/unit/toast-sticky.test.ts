// A sticky toast survives the rules that are right for a nudge.
//
// DESIGN.md §3 expires a toast at 6s and dismisses it on the next stroke. That
// is correct for a hint you can ignore. It is wrong for the service-worker
// prompt, which is the ONLY route to the new bundle: the worker parks once,
// nothing re-offers it, and a user who happens to be drawing loses it ~900ms
// in — the exact failure the prompt exists to prevent.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const toastSrc = readFileSync("src/client/ui/Toast.tsx", "utf8");
const mainSrc = readFileSync("src/client/main.tsx", "utf8");

describe("the service-worker update prompt is sticky", () => {
  it("the update prompt asks for it", () => {
    // Scoped to the showToast call in the update path, not the whole file.
    const call = mainSrc.slice(mainSrc.indexOf("watchForUpdate"));
    expect(call).toContain("sticky: true");
  });

  it("both dismissal rules honour the flag", () => {
    // The 6s expiry and the stroke dismissal are separate mechanisms; a flag
    // wired into only one of them still loses the prompt.
    expect(toastSrc).toContain("if (t.sticky) return;");
    expect(toastSrc).toContain("armed && !t.sticky");
  });

  // Control: the flag is opt-in, so an ordinary nudge keeps the spec's rules.
  it("is not applied to the ordinary nudges", () => {
    const hidden = readFileSync("src/client/ui/Canvas.tsx", "utf8");
    const call = hidden.slice(hidden.indexOf("onHiddenLayerRefusal"));
    expect(call.slice(0, 400)).not.toContain("sticky");
  });
});
