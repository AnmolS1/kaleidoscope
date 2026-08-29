import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { drawOnCanvas, mockAtCap, openSave, submitSavePiece, testLogin, uniqueSub } from "./helpers";

// WCAG 2.1 A + AA. axe runs in-page against the live dev server (vite + workerd),
// asserting zero violations on every primary surface and overlay.
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

/**
 * Wait for every running CSS animation to finish.
 *
 * Popovers fade in over 120ms. Scanning during that fade samples a
 * partly-transparent foreground and axe reports contrast failures that do not
 * exist a frame later (it saw 1.22:1 on a control that settles at 6.78:1). A
 * fixed sleep would be a guess; this waits for the actual animations.
 */
async function settle(page: Page) {
  await page.evaluate(() =>
    Promise.all(document.getAnimations().map((a) => a.finished.then(() => undefined, () => undefined))),
  );
}

async function scan(page: Page, opts: { exclude?: string } = {}) {
  await settle(page);
  let builder = new AxeBuilder({ page }).withTags(WCAG_TAGS);
  // The Turnstile embed is a third-party cross-origin iframe we don't control;
  // exclude it so the assertion stays about our own markup.
  if (opts.exclude) builder = builder.exclude(opts.exclude);
  const results = await builder.analyze();
  // Carry the offending selectors into the failure message: "color-contrast, 2
  // nodes" is not enough to act on, and a re-run under a slightly different
  // viewport may not reproduce it.
  const summary = results.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    nodes: v.nodes.map((n) => ({ target: n.target.join(" "), why: n.failureSummary })),
  }));
  expect(summary, JSON.stringify(summary, null, 2)).toEqual([]);
}

test("studio (/) has no axe violations", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("toolbar", { name: "Drawing tools" })).toBeVisible();
  await scan(page);
});

// The D01 chrome moved every setting into a popover, so a scan of the closed
// studio no longer covers the controls that carry the most colour and state.
//
// One test per popover, one axe run per test — deliberately, on two counts.
// A single test that opened all five and scanned once would only ever cover the
// last of them (they are one-at-a-time). And five `analyze()` calls inside one
// test reliably left the NEXT test's `analyze()` hanging until the 30s budget
// expired — an axe-core/playwright interaction, not a page defect: the same
// five scans plus a sixth run fine from a plain script. Splitting them is the
// fix that keeps every scan.
const RAIL_POPOVERS: [string, string, (page: Page) => Promise<void>][] = [
  [
    "color",
    '.rail summary[aria-label="Color"]',
    async (page) => {
      await expect(page.getByRole("button", { name: "Spectrum (rainbow by angle)" })).toBeVisible();
    },
  ],
  [
    "brush",
    '.rail summary[aria-label="Brush settings"]',
    async (page) => {
      await expect(page.getByRole("group", { name: "Pressure preset" })).toBeVisible();
      await expect(page.getByRole("switch", { name: /Smooth strokes/ })).toBeVisible();
    },
  ],
  [
    "symmetry",
    '.rail summary[aria-label^="Symmetry settings"]',
    async (page) => {
      await expect(page.getByRole("button", { name: "Apply to all layers" })).toBeVisible();
    },
  ],
  [
    "more",
    '.rail summary[aria-label="More options"]',
    async (page) => {
      await expect(page.getByRole("menuitem", { name: "Clear canvas" })).toBeVisible();
    },
  ],
  [
    "download",
    "#download-menu > summary",
    async (page) => {
      await expect(page.getByRole("menuitem", { name: "SVG · vector" })).toBeVisible();
    },
  ],
];

for (const [name, trigger, assertOpen] of RAIL_POPOVERS) {
  test(`the ${name} popover has no axe violations`, async ({ page }) => {
    await page.goto("/");
    // A pen has been seen, so the brush popover's pressure block — chips,
    // segmented control, preview — is in the scan rather than behind its gate.
    await page.evaluate(() => localStorage.setItem("kal.penSeen", "true"));
    await page.reload();
    await expect(page.getByRole("toolbar", { name: "Drawing tools" })).toBeVisible();
    await page.locator(trigger).click();
    // Proving the popover is open before scanning: one that silently failed to
    // open would scan nothing and report a clean sheet.
    await assertOpen(page);
    await scan(page);
  });
}

// 🔴 There is deliberately NO dark-mode axe scan here, and adding one will not
// work: a dark-mode `analyze()` HANGS the Playwright worker until the budget
// expires — verified as a genuine hang, not slowness (it was still stuck after
// three minutes with a 180s budget), reproducible with `--workers=1`, while the
// same dark page scans in 261ms from a plain script and any number of
// light-theme scans are fine. It is an axe-core/Playwright interaction, and it
// surfaces as a timeout in whichever test happens to hold the dark scan.
//
// Dark-mode contrast is therefore pinned by computation instead, in
// `test/unit/contrast.test.ts`, which derives every ratio from the real
// declarations in `tokens.css` for BOTH themes. That is stronger than an axe run
// for tokens — it cannot be dodged by a control that happens to be off-screen or
// in its default state — and it is what caught the two dark-only failures this
// task shipped fixes for (white on `--color-crease`, crane-strong on the active
// tint). It does not replace axe for markup: everything below still runs.

test("the phone dock, strip and sheet have no axe violations", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.locator(".dock")).toBeVisible();
  await expect(page.locator(".strip")).toBeVisible();

  await page.locator('.strip summary[aria-label^="Brush settings"]').click();
  await expect(page.locator('.strip details[open] input[aria-label="Brush size"]')).toBeVisible();
  await scan(page);
});

test("a toast has no axe violations", async ({ page }) => {
  await page.goto("/");
  // Turning "Draw with finger" off raises the finger-pan nudge. That is the only
  // toast this task can trigger without T06c's layer refusals, and it is the one
  // whose markup (icon + text + close) every other toast reuses.
  await page.locator('.rail summary[aria-label="Brush settings"]').click();
  await page.getByRole("switch", { name: /Draw with finger/ }).click();
  await expect(page.locator(".toast")).toBeVisible();
  await scan(page);
});

test("studio with the help overlay open has no axe violations", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Keyboard shortcuts & help").click();
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  await scan(page);
});

test("gallery has no axe violations", async ({ page }) => {
  await page.goto("/gallery");
  // Wait until the list settled (either cards or the empty state).
  await expect(page.locator(".masonry, .empty").first()).toBeVisible();
  await scan(page);
});

test("save dialog has no axe violations", async ({ page }) => {
  await page.goto("/");
  await testLogin(page, uniqueSub("a11y-dialog"));

  await drawOnCanvas(page, 2);
  // `openSave` waits out the pre-flight. Scanning the moment the dialog is
  // visible would scan the "Checking your gallery…" placeholder — a clean scan
  // of a paragraph, passing for a reason unrelated to the form.
  await openSave(page);
  await expect(page.getByLabel("Title")).toBeVisible();
  await scan(page, { exclude: ".ts-widget" });
});

test("the save dialog at the public cap has no axe violations", async ({ page }) => {
  // A different DOM, not a different skin: a disabled segment, a crane-coloured
  // note, and a button styled as an inline link. Each is its own way to fail
  // contrast or naming, and none of them appears in the ordinary form.
  await mockAtCap(page, 10, 10);
  await page.goto("/");
  await testLogin(page, uniqueSub("a11y-cap"));

  await drawOnCanvas(page, 6);
  await openSave(page);
  await expect(page.locator(".field-cap")).toBeVisible();
  await scan(page, { exclude: ".ts-widget" });
});

test("artwork permalink has no axe violations", async ({ page }) => {
  await page.goto("/");
  await testLogin(page, uniqueSub("a11y-permalink"));

  await drawOnCanvas(page, 3);
  await openSave(page);
  await page.getByLabel("Title").fill("A11y Mandala");
  await submitSavePiece(page);

  await expect(page.locator(".artwork-frame img")).toBeVisible();
  await scan(page);
});
