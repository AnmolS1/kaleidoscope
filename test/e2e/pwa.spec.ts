// The installable-app surface: manifest, iOS icons, safe-area insets (T07).
//
// The hard part here is that almost every honest assertion about safe areas is
// unfalsifiable on a desktop, where every `env(safe-area-inset-*)` is 0 — a
// stylesheet with no safe-area handling at all computes to exactly the same
// numbers. So each of the two halves is asserted separately:
//
//   1. the RULE exists and is expressed in terms of `env(safe-area-inset-*)`,
//      read out of the CSSOM; and
//   2. on a display with no inset it still computes to the value studio.css
//      declares.
//
// (2) alone passes with the feature deleted. (1) alone passes for the classic
// typo — `left: env(safe-area-inset-left)` with no `max()` — which collapses
// the whole rail onto the window edge for every desktop user and shows up
// nowhere else until someone opens it on hardware.

import { expect, test, type Page } from "@playwright/test";

test.use({ viewport: { width: 1200, height: 860 } });

/** The specified (unresolved) value of one property of one rule, via the CSSOM. */
async function declaredValue(page: Page, selector: string, prop: string): Promise<string | null> {
  return page.evaluate(
    ({ selector, prop }) => {
      let hit: string | null = null;
      for (const sheet of Array.from(document.styleSheets)) {
        let rules: CSSRuleList;
        try {
          rules = sheet.cssRules;
        } catch {
          continue; // cross-origin (fonts) — not ours
        }
        // Depth-first, because the rules under test live inside a media query.
        // The LAST match wins, not the first: studio.css declares the base
        // value and safe-area.css overrides it later at equal specificity, so
        // returning the first hit reads the value that is being overridden —
        // which is exactly what this test would then declare a failure.
        const walk = (list: CSSRuleList): string | null => {
          let last: string | null = null;
          for (const rule of Array.from(list)) {
            if (rule instanceof CSSMediaRule) {
              const hit = walk(rule.cssRules);
              if (hit) last = hit;
            } else if (rule instanceof CSSStyleRule && rule.selectorText === selector) {
              const v = rule.style.getPropertyValue(prop);
              if (v) last = v;
            }
          }
          return last;
        };
        const found = walk(rules);
        if (found) hit = found;
      }
      return hit;
    },
    { selector, prop },
  );
}

test.describe("web app manifest and icons", () => {
  test("the manifest is installable and every icon it names resolves", async ({ page, request }) => {
    await page.goto("/");
    const href = await page.getAttribute('link[rel="manifest"]', "href");
    expect(href).toBe("/manifest.webmanifest");

    const res = await request.get(href!);
    expect(res.status(), "manifest is served").toBe(200);
    const m = (await res.json()) as {
      display: string;
      start_url: string;
      icons: { src: string; sizes: string; purpose: string }[];
    };
    // `standalone` is what makes an Add to Home Screen launch chromeless; a
    // `browser` value silently installs a bookmark instead.
    expect(m.display).toBe("standalone");
    expect(m.start_url).toBe("/");
    expect(m.icons.some((i) => i.purpose === "maskable"), "a maskable icon").toBe(true);

    for (const icon of m.icons) {
      const r = await request.get(icon.src);
      expect(r.status(), `${icon.src} resolves`).toBe(200);
      expect((await r.body()).length, `${icon.src} is not empty`).toBeGreaterThan(1000);
    }
  });

  test("iOS gets sized touch icons, and they are opaque", async ({ page, request }) => {
    await page.goto("/");
    const links = await page.$$eval('link[rel="apple-touch-icon"]', (els) =>
      els.map((e) => ({ sizes: e.getAttribute("sizes"), href: e.getAttribute("href") })),
    );
    // 152 iPad, 167 iPad Pro, 180 iPhone. iOS reads these link tags and not the
    // manifest, so a manifest-only icon set leaves the home screen with a
    // screenshot of the page.
    for (const size of ["152x152", "167x167", "180x180"]) {
      expect(links.some((l) => l.sizes === size), `an apple-touch-icon at ${size}`).toBe(true);
    }
    // Plus the un-sized fallback for anything that matches nothing.
    expect(links.some((l) => l.sizes === null), "an unsized fallback").toBe(true);

    for (const l of links) {
      const r = await request.get(l.href!);
      expect(r.status(), `${l.href} resolves`).toBe(200);
      const body = await r.body();
      expect(body.length).toBeGreaterThan(1000);
      // PNG signature, then the IHDR colour type at byte 25: 2 = RGB, 6 = RGBA.
      // iOS composites ALPHA onto BLACK, so a touch icon with transparent
      // corners lands on the home screen as a mark on a black tile — which is
      // what /icons/icon-192.png (the previous apple-touch-icon) does. These
      // are cut from the opaque maskable source and re-encoded without an alpha
      // channel, so there is no transparency for iOS to fill in.
      expect(body.subarray(1, 4).toString(), "is a PNG").toBe("PNG");
      expect(body[25], `${l.href} carries no alpha channel`).toBe(2);
    }
  });

  test("the viewport opts into the display cutout", async ({ page }) => {
    await page.goto("/");
    const content = await page.getAttribute('meta[name="viewport"]', "content");
    // Without this the page is letterboxed inside the safe area and the canvas
    // never reaches the edges, which is the whole reason the insets below exist.
    expect(content).toContain("viewport-fit=cover");
    expect(await page.getAttribute('meta[name="apple-mobile-web-app-capable"]', "content")).toBe(
      "yes",
    );
  });
});

test.describe("safe-area insets", () => {
  const chrome: [string, string, string][] = [
    // selector, property, the value studio.css declares
    [".rail", "left", "16px"],
    [".rail", "top", "16px"],
    [".rail", "bottom", "16px"],
    [".top-bar", "left", "88px"],
    [".top-bar", "right", "16px"],
    [".top-bar", "top", "16px"],
    [".edge-sliders", "right", "24px"],
    [".zoom-badge", "right", "24px"],
    [".zoom-badge", "bottom", "20px"],
    [".toast-host", "left", "88px"],
    [".toast-host", "bottom", "60px"],
  ];

  test("every regular-width chrome inset is expressed with env()", async ({ page }) => {
    await page.goto("/");
    for (const [selector, prop] of chrome) {
      const declared = await declaredValue(page, selector, prop);
      expect(declared, `${selector} { ${prop} } is declared`).not.toBeNull();
      expect(declared!, `${selector} { ${prop} } honours the safe area`).toContain(
        "env(safe-area-inset-",
      );
      // …and does so through max(), which is what keeps a zero-inset display on
      // the designed value instead of flattening it to 0.
      expect(declared!, `${selector} { ${prop} } uses max()`).toContain("max(");
    }
  });

  test("…and still computes to the designed value where there is no inset", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".rail");
    for (const [selector, prop, want] of chrome) {
      const el = page.locator(selector).first();
      if ((await el.count()) === 0) continue;
      const got = await el.evaluate(
        (node, p) => getComputedStyle(node).getPropertyValue(p),
        prop,
      );
      expect(got, `${selector} { ${prop} } on a display with no inset`).toBe(want);
    }
  });
});

test.describe("motion", () => {
  test("the hover ring never animates", async ({ page }) => {
    // Reduced motion is already handled globally (app.css zeroes every
    // transition under the query), so the assertion worth making about the ring
    // is the one that is NOT implied by that: it has no transition even when
    // motion is allowed. A ring that eased between symmetry images would lag
    // the pen by exactly its duration.
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.addInitScript(() => localStorage.setItem("kal.penSeen", "true"));
    await page.goto("/");
    await page.waitForSelector(".canvas-host canvas");
    await page.evaluate(() => {
      const live = document.querySelectorAll(".canvas-host canvas")[2] as HTMLCanvasElement;
      const r = live.getBoundingClientRect();
      live.dispatchEvent(
        new PointerEvent("pointermove", {
          pointerId: 31,
          pointerType: "pen",
          pressure: 0,
          bubbles: true,
          clientX: r.left + r.width / 2 + 80,
          clientY: r.top + r.height / 2 + 40,
        }),
      );
    });
    const circle = page.locator(".hover-ring circle").first();
    await expect(circle).toHaveCount(1);
    const transition = await circle.evaluate((n) => getComputedStyle(n).transitionDuration);
    expect(transition).toBe("0s");
  });
});
