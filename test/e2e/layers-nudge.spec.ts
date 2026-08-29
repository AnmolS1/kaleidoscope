// The hidden-layer refusal must be VISIBLE.
//
// The engine dropping the stroke is only half the behaviour. Shipped without a
// consumer for onHiddenLayerRefusal, the user draws and absolutely nothing
// happens — silent, which is the exact failure mode refusing was meant to
// replace. The callback existed with no consumer in src/client/ui for one
// commit; nothing caught it, because every test asserted the engine side.
//
// So this asserts the USER-VISIBLE end: the toast, its text, and that its CTA
// actually shows the layer again.
import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1000, height: 760 }, deviceScaleFactor: 1 });

const hideActiveLayer = (page: import("@playwright/test").Page) =>
  page.evaluate(async () => {
    const load = (p: string): Promise<any> => import(/* @vite-ignore */ p);
    const S = await load("/src/client/state.ts");
    const scene = S.scene.value;
    scene.setLayerName(S.activeLayerId.value, "Highlights");
    scene.setLayerVisible(S.activeLayerId.value, false);
  });

const drawOne = (page: import("@playwright/test").Page) =>
  page.evaluate(async () => {
    const host = document.querySelector(".canvas-host")!;
    const live = host.querySelectorAll("canvas")[2] as HTMLCanvasElement;
    const r = live.getBoundingClientRect();
    const ev = (type: string, x: number, y: number) =>
      new PointerEvent(type, {
        pointerId: 7, pointerType: "pen", pressure: 0.6, isPrimary: true,
        bubbles: true, cancelable: true, clientX: r.left + x, clientY: r.top + y,
      });
    live.dispatchEvent(ev("pointerdown", 200, 200));
    for (let i = 1; i <= 6; i++) live.dispatchEvent(ev("pointermove", 200 + i * 12, 200 + i * 9));
    live.dispatchEvent(ev("pointerup", 272, 254));
  });

const strokeCounts = (page: import("@playwright/test").Page) =>
  page.evaluate(async () => {
    const load = (p: string): Promise<any> => import(/* @vite-ignore */ p);
    const S = await load("/src/client/state.ts");
    return { total: S.scene.value.strokeCount, visible: S.scene.value.visibleStrokeCount };
  });

test("drawing on a hidden layer is refused, and SAYS SO", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector(".canvas-host canvas");
  await hideActiveLayer(page);
  await drawOne(page);

  // Refused: nothing stored at all, not merely nothing visible.
  expect(await strokeCounts(page)).toEqual({ total: 0, visible: 0 });

  // ...and the user is told, by name.
  await expect(page.getByText("“Highlights” is hidden, so nothing was drawn.")).toBeVisible();
});

test("the toast's CTA shows the layer, and drawing then works", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector(".canvas-host canvas");
  await hideActiveLayer(page);
  await drawOne(page);

  await page.getByRole("button", { name: "Show layer" }).click();
  await drawOne(page);

  // The CTA has to actually unhide it — a toast whose button does nothing is
  // worse than no button.
  expect(await strokeCounts(page)).toEqual({ total: 1, visible: 1 });
});

// Control: with the layer visible there is no refusal and no toast, so the
// assertions above are about the hidden case and not about drawing at all.
test("a visible layer draws normally and shows no toast", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector(".canvas-host canvas");
  await drawOne(page);
  expect(await strokeCounts(page)).toEqual({ total: 1, visible: 1 });
  await expect(page.getByText("is hidden, so nothing was drawn.")).toHaveCount(0);
});

// The CTA must act on the layer's ID, not look it up by NAME.
//
// Rename lets a user give two layers the same name, and a name lookup then
// unhides whichever matched first — possibly a layer they never drew on, while
// the one that refused stays hidden and the next stroke is refused again. Both
// clients had this: the web fixed it by widening the callback to carry the ID,
// iOS by carrying it on the published refusal.
//
// The assertion is deliberately about the OUTCOME rather than about which row
// changed: after "Show layer", the next stroke must actually land. A test that
// checked "some layer became visible" passes on the bug.
test("Show layer unhides the layer that refused, even when names collide", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector(".canvas-host canvas");

  await page.evaluate(async () => {
    const load = (p: string): Promise<any> => import(/* @vite-ignore */ p);
    const S = await load("/src/client/state.ts");
    const scene = S.scene.value;
    // A second layer, deliberately given the SAME name as the one we hide.
    scene.addLayer();
    const [first, second] = scene.getDrawing().layers.map((l: { id: string }) => l.id);
    scene.setLayerName(first, "Highlights");
    scene.setLayerName(second, "Highlights");
    // Draw on the SECOND one, then hide it. A name lookup finds the first.
    scene.setActiveLayer(second);
    scene.setLayerVisible(second, false);
  });

  await drawOne(page);
  expect(await strokeCounts(page)).toEqual({ total: 0, visible: 0 });

  await page.getByRole("button", { name: "Show layer" }).click();
  await drawOne(page);

  // With a name lookup this is still {0, 0}: the wrong "Highlights" was shown
  // and the active layer is still hidden.
  expect(await strokeCounts(page)).toEqual({ total: 1, visible: 1 });
});

