// The permalink shell must survive the security-headers middleware.
//
// `env.ASSETS.fetch` returns a response with IMMUTABLE headers. Returning it
// directly means `securityHeaders` throws when it sets CSP, and the route 500s.
// It only ever affected the paths that skip HTMLRewriter — a miss or a private
// piece — because `.transform()` yields a fresh mutable response, so every
// public permalink worked and the broken ones were the quiet cases nobody
// loaded in a test.
//
// The ASSETS shim below therefore reproduces the property that MATTERS: headers
// that refuse mutation. A plain `new Response()` has mutable headers, so a test
// built on one passes with the bug still present — which is exactly why this
// survived to production.
import { describe, expect, it } from "vitest";
import app from "../../src/worker/index";
import { makeD1, makeEnv, makeKV, seedArtwork, seedUser, BASE } from "./helpers";

/** A Response whose headers throw on write, like the real ASSETS.fetch. */
function immutableShell(): Response {
  const res = new Response("<!doctype html><html><head></head><body></body></html>", {
    headers: { "content-type": "text/html" },
  });
  const headers = res.headers;
  Object.defineProperty(res, "headers", {
    get: () =>
      new Proxy(headers, {
        get(t, k) {
          if (k === "set" || k === "append" || k === "delete") {
            return () => {
              throw new TypeError("Can't modify immutable headers.");
            };
          }
          const v = Reflect.get(t, k);
          return typeof v === "function" ? v.bind(t) : v;
        },
      }),
  });
  return res;
}

function ctx() {
  const DB = makeD1();
  const env = makeEnv({
    DB,
    SESSIONS: makeKV(),
    ASSETS: { fetch: async () => immutableShell() },
  });
  return { DB, env };
}

describe("GET /p/:id survives the security-headers middleware", () => {
  it("an unknown id serves the SPA shell, not a 500", async () => {
    const { env } = ctx();
    const res = await app.request(`${BASE}/p/doesnotexist99`, {}, env as never);
    expect(res.status).toBe(200);
  });

  it("a PRIVATE piece serves the shell, not a 500", async () => {
    const { DB, env } = ctx();
    seedUser(DB, "u1");
    seedArtwork(DB, { id: "priv1", user_id: "u1", visibility: "private", published_at: null });
    const res = await app.request(`${BASE}/p/priv1`, {}, env as never);
    // Saving as Private and landing on "Internal Server Error" was the live
    // user-visible consequence.
    expect(res.status).toBe(200);
  });

  // Control: the shim really is immutable, so the two tests above are about the
  // route copying the response and not about the shim being lenient.
  it("the ASSETS shim genuinely refuses header mutation", () => {
    expect(() => immutableShell().headers.set("x", "y")).toThrow(/immutable/i);
  });

  // The public path CANNOT be covered here: it runs HTMLRewriter, a workerd
  // global Node does not have, so it 500s in this environment for a reason that
  // has nothing to do with the bug above. Asserting it would fail forever, and
  // asserting the 500 would pin an artefact of the test env as if it were
  // behaviour.
  //
  // It is covered instead by test/e2e/a11y.spec.ts's "artwork permalink" case,
  // which loads a real public permalink through the dev server and would fail if
  // this fix had pushed every request down the miss branch.
  it("documents why the public path is not tested here", () => {
    expect(typeof (globalThis as { HTMLRewriter?: unknown }).HTMLRewriter).toBe("undefined");
  });
});
