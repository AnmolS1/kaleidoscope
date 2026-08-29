import { expect, test, type Page } from "@playwright/test";

/**
 * Submit the Save dialog and wait for the permalink redirect.
 *
 * The Turnstile test widget issues its token asynchronously (~2.4s), and it
 * populates the hidden input slightly before our `callback` sets React state —
 * so a fixed `waitForTimeout` before clicking is a race. Retry the click until
 * navigation happens: a click with no token just re-shows the inline message
 * (a no-op), and the next click once the token has landed navigates.
 *
 * Targeted by ROLE IN THE DIALOG, not by the label "Save piece": the primary
 * button is "Save unlisted" at the cap, "Save as new" on a changed remix of
 * your own piece, and "Try again" after a failure (DESIGN.md §4). A name-based
 * locator silently waits out its 20s timeout in three of the eleven states and
 * then blames Turnstile.
 */
export async function submitSavePiece(page: Page): Promise<void> {
  await expect(async () => {
    await page.locator(".save-actions .btn-primary").click();
    await page.waitForURL(/\/p\/[A-Za-z0-9]+/, { timeout: 2500 });
  }).toPass({ timeout: 20_000 });
}

/**
 * Open the save dialog and wait for the pre-flight to finish.
 *
 * The dialog opens on a "Checking your gallery…" placeholder while
 * `GET /api/artworks/hash/:sha` runs, so asserting on the body the instant the
 * dialog is visible can assert against the placeholder — and pass for a reason
 * that has nothing to do with the state under test.
 */
export async function openSave(page: Page): Promise<void> {
  await page.getByLabel("Save to gallery").click();
  await expect(page.getByRole("dialog", { name: "Save to gallery" })).toBeVisible();
  await expect(page.locator(".save-checking")).toHaveCount(0);
}

/** The dialog's resolved state, stamped on the card as `data-save-state`. */
export function saveState(page: Page) {
  return page.getByRole("dialog", { name: "Save to gallery" });
}

// Per-run perturbation, so a drawing made in one run never hashes the same as
// one made in another.
//
// Uniqueness has to live in the DRAWING, not just the account. Saving is
// content-addressed: an identical drawing is refused as a duplicate whoever
// makes it — 200 `deduped` for the same user, 409 `duplicate_of_other` for a
// different one. Giving each spec a fresh account therefore does not isolate it;
// it converts a benign dedupe into a hard 409 against the previous run's user.
// (Learned by making exactly that change and watching the failure get worse.)
//
// CI starts with an empty D1 every run, so this is invisible there. A dev box
// keeps .wrangler/state, which is why the suite has to be re-runnable locally.
//
// 🔴 THE RUN AXIS AND THE SEED AXIS MUST NOT BE THE SAME ONE. This used to add a
// per-run `dx` of 0..59 to the seed's own `seed * 11`, which means run A seed 14
// and run B seed 4 can land on the identical path — the seeds and the runs trade
// places. That produced an INTERMITTENT `SaveOtherUnchanged` in a spec expecting
// a fresh save: red maybe one run in ten, green on the re-run, and pointing at
// axe or Turnstile rather than at the fixture. So the seed owns x-offset alone,
// and the run owns a per-POINT noise vector: ~7^24 distinct paths, and no value
// of one axis can imitate a value of the other.
const RUN_PATH_NOISE = Array.from({ length: 40 }, () => Math.floor(Math.random() * 7));

// 🔴 AND THE FILE AXIS IS A THIRD ONE, for the same reason.
//
// The run noise is computed at MODULE LOAD, so it is fixed per PROCESS — and
// Playwright gives each worker its own process. With one worker every spec
// shares a noise vector, which is what makes `drawOnCanvas(page, 3)` in two
// different FILES produce the identical path. The seed namespace is global and
// uncoordinated (seeds 1, 2, 3, 4, 6 and 21 are each used by two specs), and
// `uniqueSub` gives each spec its own account — so the second spec to save that
// path sees the first one's artwork as ANOTHER USER'S and lands on
// `SaveOtherUnchanged` where it expected `SaveFirst`.
//
// It is invisible at high worker counts, because the colliding files land in
// different processes with different noise. CI runs 2 workers, which is exactly
// the count that put `a11y.spec.ts` (seed 3) and `save-flow.spec.ts` (seed 3) in
// one process: green locally on 8 workers, red on CI, and pointing at the save
// dialog rather than at the fixture.
//
// So the path also carries a per-FILE component. Two specs cannot collide even
// on the same seed in the same process, while two calls with the same seed
// WITHIN a file still agree — which is what the remix tests rely on.
function fileSalt(): number {
  let name = "";
  try {
    // Only defined inside a running test; the catch keeps the helper usable
    // from a fixture or a bare import.
    name = test.info().titlePath[0] ?? "";
  } catch {
    return 0;
  }
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
const RUN_DRAWING_JITTER = {
  extra: Math.floor(Math.random() * 16),
};

/**
 * Draw a stroke across the live canvas with the mouse (commits one stroke).
 *
 * `seed` perturbs the path so two calls produce drawings with DIFFERENT content
 * hashes. Dedupe and the remix block are both keyed on that hash, so a test that
 * needs "the same piece again" and one that needs "a changed piece" differ only
 * by this argument.
 *
 * By default the path is ALSO perturbed per run, so re-running the suite against
 * a populated local database does not collide with itself. `{ stable: true }`
 * opts out and reproduces the original path byte for byte at seed 0.
 *
 * NOTE, because the earlier advice here was actively harmful: `stable` is NOT
 * the tool for a test that needs two accounts to hold the same drawing. Stable
 * collides across RUNS as well, so with a per-run account the FIRST save is then
 * refused 409 against a user from the previous run — the collision arrives one
 * step too early and in the wrong place. Within one run the default is already
 * deterministic (the noise vector is fixed for the whole process), so calling
 * `drawOnCanvas(page, 10)` twice is the way to make two hashes agree on purpose.
 * `stable` is for the rare test that needs a path fixed across runs too.
 */
export async function drawOnCanvas(
  page: Page,
  seed = 0,
  opts: { stable?: boolean } = {},
): Promise<void> {
  const canvas = page.locator(".canvas-host canvas").last();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("canvas not found");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  // Whole numbers of pixels throughout: capture drops moves under ~1.1px, so a
  // fractional offset can perturb the path without changing a single stored
  // point — i.e. without changing the hash, which is the thing being varied.
  const stable = opts.stable === true;
  const extra = stable ? 0 : RUN_DRAWING_JITTER.extra;
  // `stable` stays byte-identical — no run noise AND no file salt — because its
  // entire purpose is a path that reproduces exactly.
  const salt = stable ? 0 : fileSalt();
  const noise = (i: number) =>
    stable
      ? 0
      : (RUN_PATH_NOISE[i % RUN_PATH_NOISE.length] + (((salt + Math.imul(i, 2654435761)) >>> 0) % 7)) % 7;
  const dx = seed * 11;
  await page.mouse.move(cx + dx + noise(0), cy - 90);
  await page.mouse.down();
  for (let i = 1; i <= 24 + extra; i++) {
    await page.mouse.move(cx + dx + noise(i) + Math.sin(i / 3) * 70, cy - 90 + i * 7);
  }
  await page.mouse.up();
}

/**
 * A distinct signed-in user, sharing the page's cookie jar.
 *
 * `/api/auth/test-login` (dev only) keys the account on `sub`, so passing a
 * different one is genuinely a different user — which is what the cross-user
 * remix block needs to be tested against. Calling it again replaces the session
 * cookie, so a spec switches users by calling it and reloading.
 */
export async function testLogin(
  page: Page,
  user: { sub?: string; name?: string; email?: string } = {},
): Promise<string> {
  const sub = user.sub ?? "test-sub-1";
  const res = await page.request.post("/api/auth/test-login", {
    data: {
      sub,
      name: user.name ?? "E2E User",
      email: user.email ?? `${sub}@example.com`,
    },
  });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { userId: string };
  await page.reload();
  // Wait on the SESSION, not on a piece of chrome. `.avatar-btn` is only in the
  // desktop header — at phone width the account control lives elsewhere — so
  // asserting it here made this helper silently unusable from mobile.spec.
  // Asking the API is layout-independent and is the actual precondition every
  // caller needs: subsequent locator calls auto-wait for their own UI.
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const r = await fetch("/api/me", { credentials: "same-origin" });
          const d = (await r.json()) as { user: unknown | null };
          return d.user !== null;
        }),
      { message: "signed-in session after test-login", timeout: 10_000 },
    )
    .toBe(true);
  return body.userId;
}

/** The second test account — a different person from `testLogin`'s default. */
export function secondUser(): { sub: string; name: string; email: string } {
  return { sub: "test-sub-2", name: "E2E Other", email: "other@example.com" };
}

// One id per suite run, so every `uniqueSub` in a run agrees and no two runs
// collide. Not exported: a spec that wants two accounts in the SAME run should
// call `uniqueSub` twice with different prefixes, which is clearer than sharing
// a counter.
const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * A signed-in account that belongs to this spec and this run alone.
 *
 * Saving is deduplicated per user on the drawing's content hash, so two specs
 * that draw the same shape as the same account no longer both get a save: the
 * second is handed the FIRST one's piece, and any assertion about its own title
 * or permalink then fails. Which spec loses depends on scheduling order, so the
 * failure is intermittent rather than reliable — the worst kind.
 *
 * The same collision happens across runs, because the local D1 in
 * .wrangler/state persists (CI starts empty, a dev box does not). Keying the
 * account on a per-run id fixes both at once and leaves the drawing geometry
 * alone, so nothing about what is rendered changes.
 *
 * Use this wherever a spec just needs "some signed-in user who can save". A
 * spec that is deliberately TESTING dedupe or the cross-user remix block wants
 * the opposite — a fixed `sub` via `testLogin`, plus a fixed `drawOnCanvas`
 * seed — so that the hashes do collide on purpose.
 */
export function uniqueSub(prefix: string): { sub: string; name: string; email: string } {
  const sub = `${prefix}-${RUN_ID}`;
  return { sub, name: `E2E ${prefix}`, email: `${sub}@example.com` };
}

/** A 1×1 PNG. Any `image/*` of non-zero size satisfies the upload validation. */
const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/**
 * Create an artwork by POSTing a hand-written drawing, as the page's current
 * user, without going through the studio.
 *
 * The one thing this buys that the UI cannot: a drawing whose only layer is
 * HIDDEN. That is the `SaveNothingVisible` precondition, and the panel that can
 * hide a layer belongs to T06c and does not exist on this branch — so the
 * alternative was to assert nothing about the state the whole guard exists for.
 * Everything else (validation, hashing, R2, the row) is the real server path.
 */
export async function craftPiece(
  page: Page,
  opts: { drawing: unknown; title: string; visibility?: "public" | "unlisted" | "private" },
): Promise<string> {
  const out = await page.evaluate(
    async ({ drawing, title, visibility, png }) => {
      const me = (await (await fetch("/api/me", { credentials: "same-origin" })).json()) as {
        csrf: string;
      };
      const blob = await (await fetch(png)).blob();
      const fd = new FormData();
      fd.set("drawing", JSON.stringify(drawing));
      fd.set("image", blob, "image.png");
      fd.set("thumb", blob, "thumb.png");
      fd.set("og", blob, "og.png");
      fd.set("title", title);
      fd.set("visibility", visibility);
      fd.set("turnstile", "e2e");
      const res = await fetch("/api/artworks", {
        method: "POST",
        body: fd,
        credentials: "same-origin",
        headers: { "X-CSRF-Token": me.csrf, "X-Client-Caps": "v2" },
      });
      return { status: res.status, body: await res.text() };
    },
    { drawing: opts.drawing, title: opts.title, visibility: opts.visibility ?? "private", png: TINY_PNG },
  );
  // Status, not res.ok(): a 400 from validation and a 500 from a missing table
  // look identical through a boolean, and that ambiguity has already cost this
  // build one wrong diagnosis.
  expect(out.status, `craftPiece POST: ${out.body}`).toBe(201);
  return (JSON.parse(out.body) as { id: string }).id;
}

/**
 * A v2 drawing whose only INK is on a hidden layer, plus an empty visible one.
 *
 * The empty visible layer is not decoration. `serializeForHash` drops hidden
 * layers entirely — deliberately, so that toggling one is not a new piece — and
 * a drawing with ONLY hidden layers therefore projects to `layers: []` and
 * hashes the same as every other such drawing, whoever made it. Two accounts
 * cannot both hold one: the second is refused `409 duplicate_of_other`, against
 * a user from a previous run. The empty visible layer carries a random opacity
 * and fold count, both of which the projection keeps, so each fixture is a
 * distinct picture again — while `visibleStrokeCount` stays 0, which is the
 * whole point.
 */
export function hiddenOnlyDrawing() {
  const r = () => Math.round(Math.random() * 900) / 1000;
  const segments = 3 + Math.floor(Math.random() * 22);
  return {
    v: 2,
    bg: "light",
    layers: [
      {
        id: "l1",
        name: "Hidden",
        visible: false,
        opacity: 1,
        sym: { segments: 12, mirror: true },
        strokes: [
          {
            tool: "solid",
            color: "#e84a27",
            size: 6,
            opacity: 1,
            pts: [
              [r(), r(), 1],
              [r(), r(), 1],
              [r(), r(), 1],
            ],
          },
        ],
      },
      {
        id: "l2",
        name: "Empty",
        visible: true,
        opacity: Math.round((0.2 + Math.random() * 0.79) * 1000) / 1000,
        sym: { segments, mirror: true },
        strokes: [],
      },
    ],
  };
}

/**
 * Make /api/me report an account sitting at the public cap.
 *
 * `PLUS_ENABLED` is unset in .dev.vars, so `capPolicy` reports no cap at all
 * locally and the cap states are otherwise unreachable from a browser. This
 * MERGES into the real response rather than replacing it — a fabricated body
 * would drop `csrf` and `turnstileSiteKey` and every save would then fail 403
 * for a reason that has nothing to do with the cap.
 *
 * What this does and does not prove: it exercises the CLIENT's rendering of a
 * capped account, which is what T06a owns. The Worker's own cap arithmetic is
 * covered by the worker unit tests (T02a/T02d), not by this.
 */
export async function mockAtCap(page: Page, count = 10, cap = 10): Promise<void> {
  await page.route("**/api/me", async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as Record<string, unknown>;
    const plus = (body.plus ?? {}) as Record<string, unknown>;
    body.plus = {
      ...plus,
      active: false,
      sources: [],
      publicCount: count,
      publicCap: cap,
      layerCap: 3,
      enabled: true,
    };
    await route.fulfill({ response: res, json: body });
  });
}
