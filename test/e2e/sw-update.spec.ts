// The service-worker update prompt, driven by a REAL waiting worker.
//
// WHY THIS FILE RUNS ITS OWN SERVER. Service workers do not run under `vite
// dev` at all, and the app only registers one when `import.meta.env.PROD` — so
// the suite's dev server can say nothing whatever about this feature. What is
// needed instead is a production build, served over a secure context
// (http://localhost counts), whose /sw.js can be CHANGED between page loads so
// the browser genuinely finds an update. A ~40-line static server does that and
// nothing else; a second Playwright `webServer` could not change its own bytes
// mid-test, and would need a port, which several agents are sharing.
//
// It serves `dist/client`, so `npm run build` must have run. It has, in both
// places this matters: the stated gate builds before Playwright, and ci.yml runs
// `npm run build` before the e2e step. The spec asserts the directory is there
// rather than skipping — a skip is a green tick for an untested feature.
//
// WHAT WOULD PASS WITH THE FEATURE DELETED, and how each is closed:
//   - "the service worker registered"  → true with no prompt code at all.
//     Closed by asserting the toast, and by asserting it does NOT appear on the
//     first install.
//   - "the toast appeared"             → true of a toast fired unconditionally.
//     Closed by requiring `registration.waiting` to be a real parked worker at
//     that moment, and the old worker still active (cache still v1).
//   - "clicking Reload reloaded"       → true with skipWaiting removed; the page
//     would just come back on the OLD worker. Closed by asserting the new
//     worker's own cache name afterwards, which only exists once it activated.

/// <reference types="node" />
// tsconfig.app.json compiles test/ with `types: ["vite/client", "vitest/globals"]`,
// so @types/node is not in scope here and `node:*` imports do not resolve. This is
// the per-file escape hatch; the alternative is adding "node" to that shared
// tsconfig, which would put Node globals in front of every DOM module in the app.
import { expect, test, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { readFile, access } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import type { AddressInfo } from "node:net";

const DIST = join(process.cwd(), "dist", "client");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

interface Harness {
  origin: string;
  /** Start serving the SECOND version of sw.js — a real, byte-different worker. */
  serveV2(): void;
  close(): Promise<void>;
}

async function serveBuild(): Promise<Harness> {
  await access(DIST).catch(() => {
    throw new Error(`${DIST} is missing — run \`npm run build\` before the e2e suite.`);
  });

  const swV1 = await readFile(join(DIST, "sw.js"), "utf8");
  // The only difference is the cache name, and that is the point: it is both a
  // byte change (so the browser treats it as a new worker) and an OBSERVABLE
  // one (so "did the new worker actually take over?" has an answer the test can
  // read out of the page). The shipped sw.js deletes every cache that is not
  // its own on activate, so `caches.keys()` names whichever worker is live.
  const swV2 = swV1.replace(/"kld-v1"/, '"kld-v2"');
  if (swV2 === swV1) throw new Error("sw.js no longer declares CACHE = \"kld-v1\"");
  let sw = swV1;

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path === "/sw.js") {
      // A service-worker script must never be answered from cache, or the
      // update check re-reads the old bytes and no update is ever found.
      res.writeHead(200, {
        "Content-Type": TYPES[".js"],
        "Cache-Control": "no-cache, no-store, must-revalidate",
      });
      res.end(sw);
      return;
    }
    // The studio calls /api/me on boot. It handles a failure (signed out), so a
    // flat 404 is enough; proxying to the real Worker would drag D1 into a test
    // about caching.
    if (path.startsWith("/api/")) {
      res.writeHead(404, { "Content-Type": TYPES[".json"] });
      res.end('{"error":"not_found"}');
      return;
    }

    const rel = normalize(path).replace(/^(\.\.[/\\])+/, "");
    const file = join(DIST, rel === "/" ? "index.html" : rel);
    readFile(file)
      .then((buf) => {
        res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
        res.end(buf);
      })
      .catch(() => {
        // SPA fallback, same as the Worker's `not_found_handling`.
        readFile(join(DIST, "index.html")).then(
          (buf) => {
            res.writeHead(200, { "Content-Type": TYPES[".html"] });
            res.end(buf);
          },
          () => {
            res.writeHead(500);
            res.end();
          },
        );
      });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    // localhost, not 127.0.0.1: a service worker needs a secure context, and
    // only the name `localhost` is treated as one.
    origin: `http://localhost:${port}`,
    serveV2: () => {
      sw = swV2;
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}

/** Cache names currently in this origin's CacheStorage — i.e. which worker is live. */
async function cacheNames(page: Page): Promise<string[]> {
  return page.evaluate(() => caches.keys());
}

/** Same, but tolerant of the reload that destroys the execution context. */
async function cacheNamesDuringReload(page: Page): Promise<string[]> {
  try {
    return await page.evaluate(() => caches.keys());
  } catch {
    return [];
  }
}

test.describe("service worker update prompt", () => {
  test.describe.configure({ timeout: 90_000 });

  test("a waiting worker raises the toast, and Reload puts it in charge", async ({ page }) => {
    const h = await serveBuild();
    try {
      await page.goto(h.origin + "/");
      await page.waitForSelector(".canvas-host canvas");

      // ---- first install --------------------------------------------------
      // sw.js claims clients on activate, so the page becomes controlled with
      // no reload. That is also the moment a naive implementation prompts.
      await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, {
        timeout: 30_000,
      });
      expect(await cacheNames(page), "v1 installed and active").toEqual(["kld-v1"]);
      await expect(
        page.getByText("Update available", { exact: false }),
        "a first install is not an update",
      ).toHaveCount(0);

      // ---- a genuinely new worker appears ----------------------------------
      h.serveV2();
      await page.evaluate(async () => {
        const reg = await navigator.serviceWorker.getRegistration();
        await reg!.update();
      });

      await expect(
        page.getByText("Update available", { exact: false }),
        "the prompt for the parked worker",
      ).toBeVisible({ timeout: 30_000 });

      // The toast is describing something real: a second worker is installed
      // and waiting, while the FIRST one is still the one serving the page.
      expect(
        await page.evaluate(async () =>
          Boolean((await navigator.serviceWorker.getRegistration())!.waiting),
        ),
        "a worker really is waiting",
      ).toBe(true);
      // Both caches exist here, and that is the correct expectation rather than
      // a bug: a worker fills its cache in INSTALL and deletes its predecessor's
      // in ACTIVATE. So "v2 has installed" and "v2 has not taken over" are
      // exactly `kld-v1` still being present alongside it. (Written the other
      // way round first, and the failure is what taught this.)
      expect(
        (await cacheNames(page)).sort(),
        "v2 is installed; v1 is still the active worker",
      ).toEqual(["kld-v1", "kld-v2"]);

      // ---- taking the update ------------------------------------------------
      await page.getByRole("button", { name: "Reload" }).click();

      // v1's cache disappears only when v2 ACTIVATES, and a waiting worker
      // activates only because it was told to skipWaiting — an ordinary reload
      // does not dislodge it (that is the whole "close every tab" folklore).
      // So `["kld-v2"]` alone is the signature of the message having been sent,
      // received, and acted on.
      await expect
        .poll(() => cacheNamesDuringReload(page), { timeout: 30_000 })
        .toEqual(["kld-v2"]);
      // And the page came back on it, rather than being left uncontrolled.
      await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, {
        timeout: 30_000,
      });
      await expect(page.locator(".canvas-host canvas").first()).toBeVisible();
    } finally {
      await h.close();
    }
  });

  test("the studio still loads offline from the worker's cache", async ({ page, context }) => {
    // Not the prompt, but the reason the worker exists at all — and it shares
    // every failure mode with it, so it is worth one pass.
    const h = await serveBuild();
    try {
      await page.goto(h.origin + "/");
      await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, {
        timeout: 30_000,
      });
      // Warm the hashed bundle into the cache the way a real second visit does.
      await page.reload();
      await page.waitForSelector(".canvas-host canvas");

      await context.setOffline(true);
      await page.reload();
      await expect(page.locator(".canvas-host canvas").first()).toBeVisible({ timeout: 30_000 });
      await context.setOffline(false);
    } finally {
      await h.close();
    }
  });
});
