import { test, expect } from "@playwright/test";
import { testLogin, uniqueSub } from "./helpers";

// The byte cap, driven through the REAL save endpoint.
//
// `dedupe.test.ts` asserts the guard at the route function; this asserts it
// through HTTP, multipart, Turnstile and the client's own session — the path a
// caller actually takes. It also documents WHY the cap cannot be reached by
// drawing, which is the question it was written to answer:
//
//   ~11,900 points fill 256KB at ~22 bytes a point, and the guard only trips
//   when CANONICALISING grows the payload. That growth is the v1 -> v2 layer
//   wrapper, a flat +67 bytes, so only a V1 client near the limit can hit it.
//   This app sends v2, which canonicalises to roughly itself. "I attempted to
//   test the size cap on save and it saved pretty easily" is the correct
//   outcome for a v2 client, at any number of strokes.
test("the byte cap answers 413 over HTTP, and only a v1 payload can reach it", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector(".canvas-host canvas");
  await testLogin(page, uniqueSub("capprobe"));

  const out = await page.evaluate(async () => {
    const csrf = (await (await fetch("/api/me", { credentials: "same-origin" })).json()).csrf;

    // V1, deliberately. The overflow this guards is the v1 -> v2 layer wrapper
    // the worker adds when it canonicalises, a flat +67 bytes. A v2 input
    // canonicalises to roughly itself, so it can never trip the guard — which is
    // why a v2 client, i.e. this app, cannot reach a 413 by drawing.
    // PERTURBED PER RUN. Saves are content-addressed, so the identical drawing
    // from an earlier run comes back 409 `duplicate_of_other` — against a
    // different test user, which makes it a hard refusal rather than a dedupe.
    // The salt rides in one point's pressure, and the binary search measures the
    // real string, so varying its width costs nothing.
    const salt = 0.1 + Math.random() * 0.8;
    const drawing = (points: number) =>
      JSON.stringify({
        v: 1, bg: "light",
        sym: { segments: 6, mirror: true },
        strokes: [{
          tool: "solid", color: "#e84a27", size: 6, opacity: 1,
          pts: Array.from({ length: points }, (_, i) =>
            [((i % 800) - 400) / 1000, 0.123, i === 0 ? Number(salt.toFixed(2)) : 0.5]),
        }],
      });

    const png = await new Promise<Blob>((res) => {
      const c = document.createElement("canvas");
      c.width = c.height = 8;
      c.getContext("2d")!.fillRect(0, 0, 8, 8);
      c.toBlob((b) => res(b!), "image/png");
    });

    async function save(points: number, title: string) {
      const fd = new FormData();
      fd.set("drawing", drawing(points));
      fd.set("image", new File([png], "i.png", { type: "image/png" }));
      fd.set("thumb", new File([png], "t.png", { type: "image/png" }));
      fd.set("title", title);
      fd.set("visibility", "private");
      fd.set("width", "1024");
      fd.set("height", "1024");
      // The field is `turnstile`. In dev/CI the secret is Cloudflare's
      // published always-pass test key, which accepts any token.
      fd.set("turnstile", "probe");
      const res = await fetch("/api/artworks", {
        method: "POST", credentials: "same-origin",
        headers: { "X-CSRF-Token": csrf, "X-Client-Caps": "v2" },
        body: fd,
      });
      let body: unknown = null;
      try { body = await res.json(); } catch { /* */ }
      return { status: res.status, body, bytes: new TextEncoder().encode(drawing(points)).length };
    }

    // Binary-search the largest point count the INPUT cap accepts.
    const CAP = 262144;
    let lo = 100, hi = 30000;
    while (lo < hi) {
      const m = Math.ceil((lo + hi) / 2);
      if (new TextEncoder().encode(drawing(m)).length <= CAP) lo = m; else hi = m - 1;
    }
    return { atLimit: await save(lo, "At the limit"), under: await save(lo - 40, "Comfortably under") };
  });

  // The premise first: both payloads are UNDER the input cap, so a 413 can only
  // come from the canonical form — not from the request being too big.
  expect(out.atLimit.bytes).toBeLessThanOrEqual(262144);
  expect(out.under.bytes).toBeLessThanOrEqual(262144);

  expect(out.atLimit.status, `at ${out.atLimit.bytes} bytes`).toBe(413);
  expect(out.atLimit.body).toEqual({ error: "vector_too_large" });

  // The control. Without it, "413" and "413 for everything" look the same.
  expect(out.under.status, `at ${out.under.bytes} bytes`).toBe(201);
});
