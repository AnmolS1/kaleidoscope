import { test, expect, type Page } from "@playwright/test";
import { drawOnCanvas, openSave, submitSavePiece, testLogin, uniqueSub } from "./helpers";

// "New drawing" is the only way out of a remix. Before it, Clear emptied the
// canvas and left `remixOf` set, so a wholly new picture still saved as "Remix
// of your ___" until the studio remounted.
//
// Seeds 41–46 are this file's alone, two per test: each test saves its own
// piece under its own account, and a shared seed would make the second test's
// piece another user's duplicate.

const dialog = (page: Page) => page.getByRole("dialog", { name: "Save to gallery" });

async function openMore(page: Page): Promise<void> {
  await page.locator('summary[aria-label="More options"]').click();
}

/** Save a piece, then remix it back into the studio with a second layer added. */
async function remixWithTwoLayers(page: Page, prefix: string, seed: number): Promise<void> {
  await page.goto("/");
  await testLogin(page, uniqueSub(prefix));
  await drawOnCanvas(page, seed);
  await openSave(page);
  await page.getByLabel("Title").fill("Salt Rose");
  await submitSavePiece(page);

  await page.getByRole("button", { name: "Remix" }).click();
  await page.waitForURL((u) => u.pathname === "/");
  await page.getByRole("button", { name: /^Layers, / }).first().click();
  await page.getByRole("button", { name: /^Add layer/ }).click();
  await expect(page.getByRole("button", { name: /^Layers, 2 of / }).first()).toBeVisible();
  await page.getByRole("button", { name: /^Layers, / }).first().click();
}

test("New drawing empties every layer and leaves the remix", async ({ page }) => {
  await remixWithTwoLayers(page, "new-drawing", 41);
  // Zoomed in, so the reset view has to reach the badge — before this,
  // `loadDrawing` only ever ran on mount, already at the identity view.
  await page.evaluate(async () => {
    const load = (p: string): Promise<any> => import(/* @vite-ignore */ p);
    const S = await load("/src/client/state.ts");
    S.scene.value.zoomBy(4);
  });
  await expect(page.getByRole("button", { name: "Reset view · 400%" })).toBeVisible();

  let prompt = "";
  page.once("dialog", (d) => {
    prompt = d.message();
    void d.accept();
  });
  await openMore(page);
  await page.getByRole("menuitem", { name: "New drawing" }).click();
  expect(prompt).toContain("stops this being a remix");

  await expect(page.getByLabel("Clear canvas")).toBeDisabled();
  await expect(page.getByRole("button", { name: /^Layers, 1 of / }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Reset view · 100%" })).toBeVisible();
  // History goes with the drawing — which is why it asked first.
  await expect(page.getByRole("button", { name: "Undo" })).toBeDisabled();

  // A different picture, so the pre-flight finds no duplicate and the verdict
  // is decided by the remix link alone.
  await drawOnCanvas(page, 42);
  await openSave(page);
  await expect(dialog(page)).toHaveAttribute("data-save-state", "first");
  await expect(page.locator(".save-remix-hint")).toHaveCount(0);
});

test("Cancelling New drawing keeps the strokes and the remix", async ({ page }) => {
  await remixWithTwoLayers(page, "new-drawing-cancel", 43);

  page.once("dialog", (d) => void d.dismiss());
  await openMore(page);
  await page.getByRole("menuitem", { name: "New drawing" }).click();

  await expect(page.getByLabel("Clear canvas")).toBeEnabled();
  await expect(page.getByRole("button", { name: /^Layers, 2 of / }).first()).toBeVisible();
  await drawOnCanvas(page, 44);
  await openSave(page);
  await expect(page.locator(".save-remix-hint")).toHaveText("Remix of your Salt Rose");
});

// Clear stays what it was on iOS: it empties layers, and does not disown the
// piece you started from. Undo brings the strokes back — so if Clear dropped
// the link, Undo would restore a remix that saves as an original.
test("Clear canvas does not leave the remix", async ({ page }) => {
  await remixWithTwoLayers(page, "new-drawing-clear", 45);

  await openMore(page);
  await page.getByLabel("Clear canvas").click();
  await expect(page.getByLabel("Clear canvas")).toBeDisabled();
  // Clear leaves the menu open, and its scrim would swallow the next stroke.
  await page.locator(".pop-scrim").click();
  await drawOnCanvas(page, 46);
  await openSave(page);
  await expect(page.locator(".save-remix-hint")).toHaveText("Remix of your Salt Rose");
});
