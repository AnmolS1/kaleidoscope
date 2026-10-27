// Kaleidoscope Plus: StoreKit grants, App Store Server Notifications, the
// Stripe webhook, and the Stripe Checkout redirect (PLAN §2.3).
//
// Four routes with deliberately different gates:
//
//   POST /api/billing/apple              auth + CSRF + rate limit  (the iOS app calls it)
//   POST /api/billing/apple/notifications  NONE                    (Apple's server calls it)
//   POST /api/billing/stripe               NONE                    (Stripe's server calls it)
//   GET  /api/billing/checkout           auth + CSRF + rate limit  (the web client calls it)
//
// The two webhooks are unauthenticated by necessity — Apple and Stripe have no
// session with us. Their ONLY authentication is the signature, which is why
// both signature paths are fail-closed and mutation-tested.

import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../middleware";
import { requireAuth, requireCsrf } from "../middleware";
import { checkAll } from "../lib/ratelimit";
import { getUserById } from "../lib/db";
import { envFlag } from "../lib/validate";
import {
  verifyAppleJws,
  checkTransaction,
  sandboxAllowed,
  type AppleTransactionInfo,
} from "../lib/apple-billing";
import {
  verifyStripeSignature,
  checkCheckoutEvent,
  checkRevocationEvent,
  checkoutConfigured,
  createCheckoutSession,
  fetchPaymentState,
  eventIds,
  keyMode,
  testModeAllowed,
  StripeApiError,
  GRANT_EVENTS,
  REVOKE_EVENTS,
  type PaymentState,
  type StripeEvent,
} from "../lib/stripe";
import type { Env, PlusSource } from "../types";

export const billing = new Hono<AppEnv>();

/** §2.3: 10/h on both authenticated billing routes. */
const BILLING_RULE = { limit: 10, windowSec: 3600 };

/**
 * Ceiling for the two UNAUTHENTICATED webhook routes (S1).
 *
 * Both are open by design — the signature is the only credential — so every
 * byte of work before that signature is checked is reachable by anyone: an
 * x5c chain to parse on the Apple side, an HMAC over the raw body on the
 * Stripe side. Keyed by IP because there is no user to key on yet.
 *
 * Deliberately loose. Apple retries notifications and Stripe retries for up to
 * three days, so a tight limit would drop deliveries we actually want; this is
 * a ceiling on abuse, not a throttle on normal traffic. A dropped webhook is
 * re-sent by both providers, so 429 is safe here in a way it would not be on a
 * user-facing write.
 */
const WEBHOOK_IP_RULE = { limit: 300, windowSec: 60 };

/**
 * Record a webhook that did NOT result in a grant (S2).
 *
 * There was no `console.*` anywhere in the billing files, so a purchase with no
 * user to attach to — e.g. a Payment Link made by hand in the Stripe dashboard,
 * which carries none of our metadata — answered `200 {ignored:true}` and
 * vanished: money taken, nothing granted, no trace, no repair path, and no way
 * to even discover it had happened.
 *
 * `console.warn` reaches Workers Logs, which is the only observability this
 * project has. Ids only — the Stripe event, session and payment intent ids are
 * what support needs to find it in the dashboard. Never an email, never a raw
 * payload (a Checkout Session carries `customer_details.email`), never a key.
 */
function logNoGrant(source: string, reason: string, detail: Record<string, unknown> = {}): void {
  console.warn("billing: no grant", { source, reason, ...detail });
}


/** The client IP, or a single shared bucket when the header is absent. */
function ipKey(c: Context<AppEnv>, route: string): string {
  return `billing:${route}:ip:${c.req.header("CF-Connecting-IP") ?? "unknown"}:m`;
}

// ---- entitlement writes ---------------------------------------------------
//
// These live here rather than in `lib/db.ts` for an ownership reason, not a
// design one: T02a owns `db.ts` and shipped the entitlement READ side there
// (`hasPlus`, `plusSources`), which this file imports via /api/me rather than
// reimplementing. The write side did not exist and `db.ts` is not T02d's to
// edit. If billing ever grows a second consumer, these three belong next to
// their read counterparts.

interface EntitlementRow {
  user_id: string | null;
  revoked_at: number | null;
}

function findEntitlement(
  env: Env,
  source: PlusSource,
  externalId: string,
): Promise<EntitlementRow | null> {
  return env.DB.prepare(
    "SELECT user_id, revoked_at FROM entitlements WHERE source = ? AND external_id = ?",
  )
    .bind(source, externalId)
    .first<EntitlementRow>();
}

/** Insert-or-update by the (source, external_id) primary key. Idempotent: a
 *  replayed purchase re-writes the same row rather than adding a second.
 *
 *  🔴 `revoked_at` is deliberately NOT in the DO UPDATE list. A refunded row
 *  must stay refunded even if the same purchase is reported again — which both
 *  providers make easy: Apple's device still holds a JWS signed before the
 *  refund, and Stripe retries `checkout.session.completed` for up to three days
 *  and offers a manual resend. Clearing the tombstone here would re-grant on a
 *  replay and undo the whole point of having one. */
async function upsertEntitlement(
  env: Env,
  e: { source: PlusSource; externalId: string; userId: string; environment: string | null },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO entitlements (source, external_id, user_id, product, environment, granted_at)
     VALUES (?, ?, ?, 'plus', ?, ?)
     ON CONFLICT(source, external_id) DO UPDATE SET
       user_id = excluded.user_id,
       environment = excluded.environment`,
  )
    .bind(e.source, e.externalId, e.userId, e.environment, Date.now())
    .run();
}

/** Whether this purchase has already been refunded/revoked. */
async function isRevoked(env: Env, source: PlusSource, externalId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT revoked_at FROM entitlements WHERE source = ? AND external_id = ?",
  )
    .bind(source, externalId)
    .first<{ revoked_at: number | null }>();
  return !!row && row.revoked_at !== null;
}

/** Tombstone an entitlement (refund/revoke). Returns whether a row changed.
 *
 *  This used to DELETE. Deleting left no memory that the purchase had been
 *  revoked, so replaying the credential the client still holds re-granted it —
 *  a repeatable "refund and keep it" for both providers. Keeping the row is
 *  also what lets support see what happened. */
async function revokeEntitlement(
  env: Env,
  source: PlusSource,
  externalId: string,
  environment?: string,
): Promise<boolean> {
  // A SANDBOX refund may only revoke a SANDBOX row (minor).
  //
  // Apple delivers sandbox notifications to the same URL, and
  // originalTransactionId is not guaranteed unique across environments — so an
  // unscoped revoke let a sandbox refund cancel a paying customer's Plus. A
  // Production notification may still clear a legacy NULL row, because Apple
  // rows predating the environment column carry nothing to match on and a real
  // refund must not be ignored.
  const scope =
    environment === "Production"
      ? " AND (environment = 'Production' OR environment IS NULL)"
      : environment
        ? " AND environment = ?"
        : "";
  const stmt = env.DB.prepare(
    "UPDATE entitlements SET revoked_at = ? WHERE source = ? AND external_id = ? AND revoked_at IS NULL"
      + scope,
  );
  const bound =
    environment && environment !== "Production"
      ? stmt.bind(Date.now(), source, externalId, environment)
      : stmt.bind(Date.now(), source, externalId);
  const res = await bound.run();
  return (res.meta?.changes ?? 0) > 0;
}

// ---- POST /api/billing/apple ----------------------------------------------
//
// The iOS app finishes a StoreKit purchase and posts the signed transaction.
//
// TRAP (carried over from calque): the JWS string is `jwsRepresentation` on
// StoreKit's `VerificationResult`, NOT a property of `Transaction`. Unwrapping
// the Transaction first and looking for it there yields nothing, and the natural
// next move — sending the decoded Transaction as JSON — sends us an UNSIGNED
// payload. T14 must send `VerificationResult.jwsRepresentation` verbatim.
billing.post("/apple", requireAuth, requireCsrf, async (c) => {
  const user = c.get("user")!;

  const productId = (c.env.PLUS_PRODUCT_ID ?? "").trim();
  const bundleId = (c.env.APPLE_BUNDLE_ID ?? "").trim();
  // Fail closed rather than compare against "": an empty expected product would
  // otherwise match a transaction that carries no productId at all.
  if (!productId || !bundleId) return c.json({ error: "not_configured" }, 503);

  // Keyed per ROUTE, not just per user. A shared `billing:<id>` key would give
  // the grant path and the checkout path ONE 10/h budget between them, so ten
  // checkout-URL fetches would 429 the purchase report — the one failure mode
  // that means "paid, not granted".
  if (!(await checkAll(c.env, [{ key: `billing:apple:${user.id}:h`, rule: BILLING_RULE }]))) {
    return c.json({ error: "rate_limited" }, 429);
  }

  const body = (await c.req.json().catch(() => null)) as { jws?: unknown } | null;
  const jws = typeof body?.jws === "string" ? body.jws : null;
  if (!jws) return c.json({ error: "bad_body" }, 400);

  let tx: AppleTransactionInfo;
  try {
    tx = (await verifyAppleJws(jws)) as AppleTransactionInfo;
  } catch {
    // Deliberately opaque: the specific chain failure is a probing oracle and
    // tells a legitimate client nothing it can act on.
    return c.json({ error: "invalid_signature" }, 401);
  }

  const check = checkTransaction(tx, {
    bundleId,
    productId,
    userId: user.id,
    allowSandbox: sandboxAllowed(c.env, user.role),
  });
  if (!check.ok) return c.json({ error: check.reason }, 400);

  // The purchase stays with whoever claimed it first. A row whose user_id is
  // NULL is NOT "a different user" — that is a purchase whose account was
  // deleted (the FK is ON DELETE SET NULL), so it falls through to be claimed.
  // In practice that branch is unreachable from here, because appAccountToken
  // must already equal the CURRENT user's id and it carries the deleted user's
  // id; it is implemented and tested as the plain reading of the rule rather
  // than left to whatever the SQL happens to do. Flagged as an M1 item.
  const existing = await findEntitlement(c.env, "apple", check.originalTransactionId);
  if (existing && existing.user_id && existing.user_id !== user.id) {
    return c.json({ error: "bound_elsewhere" }, 409);
  }

  // A refunded purchase stays refunded (REVIEW M1).
  //
  // The device holds a JWS that was signed BEFORE the refund, so it carries no
  // `revocationDate` and passes verification perfectly — buy, keep the JWS,
  // refund, re-post it. Verification cannot catch this; only the tombstone can.
  if (existing && existing.revoked_at !== null) {
    return c.json({ error: "revoked" }, 409);
  }

  await upsertEntitlement(c.env, {
    source: "apple",
    externalId: check.originalTransactionId,
    userId: user.id,
    environment: check.environment,
  });

  return c.json({ ok: true, plus: true });
});

// ---- POST /api/billing/apple/notifications --------------------------------
//
// App Store Server Notifications V2. Unauthenticated; the signature is the only
// credential. Two nested JWS: the notification envelope, and the transaction
// inside it — both verified against the same pinned chain.
billing.post("/apple/notifications", async (c) => {
  // Unauthenticated route: bound the work an anonymous caller can ask for
  // before the signature is checked (S1). 429 is safe here — both providers
  // retry, so a dropped delivery comes back.
  if (!(await checkAll(c.env, [{ key: ipKey(c, "notifications"), rule: WEBHOOK_IP_RULE }]))) {
    return c.json({ error: "rate_limited" }, 429);
  }
  const productId = (c.env.PLUS_PRODUCT_ID ?? "").trim();
  const bundleId = (c.env.APPLE_BUNDLE_ID ?? "").trim();
  if (!productId || !bundleId) return c.json({ error: "not_configured" }, 503);

  const body = (await c.req.json().catch(() => null)) as { signedPayload?: unknown } | null;
  const signedPayload = typeof body?.signedPayload === "string" ? body.signedPayload : null;
  if (!signedPayload) return c.json({ error: "bad_body" }, 400);

  let note: {
    notificationType?: unknown;
    data?: { signedTransactionInfo?: unknown };
  };
  try {
    note = (await verifyAppleJws(signedPayload)) as typeof note;
  } catch {
    return c.json({ error: "invalid_signature" }, 401);
  }

  const signedTx = note.data?.signedTransactionInfo;
  if (typeof signedTx !== "string") return c.json({ ok: true, ignored: true });

  let tx: AppleTransactionInfo;
  try {
    tx = (await verifyAppleJws(signedTx)) as AppleTransactionInfo;
  } catch {
    return c.json({ error: "invalid_signature" }, 401);
  }

  // Bind on the INNER, verified transaction — not on the envelope. Apple signs
  // every developer's notifications with the same chain, so a valid signature
  // proves "some App Store app", not "Kaleidoscope". The row we are about to
  // delete is keyed by the inner originalTransactionId, so the inner payload is
  // what has to be checked; validating the envelope's bundleId and then acting
  // on the transaction would be checking one thing and acting on another.
  if (tx.bundleId !== bundleId || tx.productId !== productId) {
    return c.json({ ok: true, ignored: true });
  }
  const originalTransactionId =
    typeof tx.originalTransactionId === "string" ? tx.originalTransactionId : null;
  if (!originalTransactionId) return c.json({ ok: true, ignored: true });

  // §2.3: REFUND and REVOKE remove the entitlement; every other type is ignored.
  // Deliberately NOT re-granting on other types — a grant needs the session user
  // that only POST /apple has, and appAccountToken alone should not mint one.
  const type = tx.revocationDate !== undefined && tx.revocationDate !== null ? "REFUND" : null;
  const notificationType =
    typeof note.notificationType === "string" ? note.notificationType : type;
  if (notificationType !== "REFUND" && notificationType !== "REVOKE") {
    return c.json({ ok: true, ignored: true });
  }

  // Ignore a Sandbox notification unless Sandbox is currently accepted, and
  // pass the environment through so the revoke cannot cross environments.
  const noteEnv = typeof tx.environment === "string" ? tx.environment : "";
  if (noteEnv !== "Production" && !envFlag(c.env.PLUS_ALLOW_SANDBOX)) {
    logNoGrant("apple", "notification_wrong_environment", { environment: noteEnv });
    return c.json({ ok: true, ignored: true });
  }

  const removed = await revokeEntitlement(c.env, "apple", originalTransactionId, noteEnv);
  return c.json({ ok: true, removed });
});

// ---- POST /api/billing/stripe ---------------------------------------------
//
// Unauthenticated; the HMAC over the signed timestamp and the RAW BODY is the
// only credential.
//
// Business refusals (test mode, unpaid, wrong product, unknown user, refunded)
// answer 200 `{ ignored: true, reason }` rather than 4xx, because Stripe
// retries non-2xx for up to three days and none of these will ever succeed on a
// retry. The security assertion in the tests is therefore "no entitlement row
// exists", not the status code. Two things DO answer non-2xx on purpose: a bad
// signature (401), and anything that stops us confirming the payment with
// Stripe (503) — that one SHOULD be retried, because the customer has paid.
billing.post("/stripe", async (c) => {
  // Unauthenticated route: bound the work an anonymous caller can ask for
  // before the signature is checked (S1). 429 is safe here — both providers
  // retry, so a dropped delivery comes back.
  if (!(await checkAll(c.env, [{ key: ipKey(c, "stripe"), rule: WEBHOOK_IP_RULE }]))) {
    return c.json({ error: "rate_limited" }, 429);
  }
  // The raw bytes, exactly as sent. Re-serializing a parsed body would change
  // key order and whitespace, so the HMAC would match only bodies we built
  // ourselves and never a real webhook.
  const raw = await c.req.text();
  const signature = c.req.header("Stripe-Signature");

  if (!(await verifyStripeSignature(c.env.STRIPE_WEBHOOK_SECRET ?? "", raw, signature))) {
    return c.json({ error: "bad_signature" }, 401);
  }

  let event: StripeEvent;
  try {
    event = JSON.parse(raw) as StripeEvent;
  } catch {
    return c.json({ error: "bad_body" }, 400);
  }
  if (!event || typeof event !== "object") return c.json({ error: "bad_body" }, 400);

  const type = typeof event.type === "string" ? event.type : "";
  // Ids only, never the object: a Checkout Session carries the buyer's email.
  const { eventId, objectId, paymentIntentId } = eventIds(event);

  if (REVOKE_EVENTS.has(type)) {
    const rev = checkRevocationEvent(event);
    if (!rev.ok) {
      logNoGrant("stripe", rev.reason, { type, eventId, objectId, paymentIntent: paymentIntentId });
      return c.json({ ok: true, ignored: true, reason: rev.reason });
    }
    // An unknown payment intent changes nothing and inserts nothing: there is
    // no placeholder row for a refund that arrives before its grant. That case
    // is closed by the grant path's re-read, which sees the refunded charge.
    const removed = await revokeEntitlement(c.env, "stripe", rev.paymentIntentId);
    return c.json({ ok: true, removed });
  }

  if (!GRANT_EVENTS.has(type)) {
    logNoGrant("stripe", "event", { type, eventId, objectId, paymentIntent: paymentIntentId });
    return c.json({ ok: true, ignored: true, reason: "event" });
  }

  const check = checkCheckoutEvent(event, { allowTest: testModeAllowed(c.env) });
  if (!check.ok) {
    // The one that loses money silently: a payment with no user to attach to
    // (a Payment Link made by hand in the dashboard carries none of our
    // metadata) answers 200 and is otherwise never heard of again.
    logNoGrant("stripe", check.reason, { type, eventId, sessionId: objectId, paymentIntent: paymentIntentId });
    return c.json({ ok: true, ignored: true, reason: check.reason });
  }
  const ids = { eventId, sessionId: objectId, paymentIntent: check.paymentIntentId };

  // `entitlements.user_id` has a FK to `users`. A user id that no longer
  // resolves would raise a constraint error and turn into a 500, which Stripe
  // would then retry for days; check first and answer cleanly instead.
  if (!(await getUserById(c.env, check.userId))) {
    logNoGrant("stripe", "unknown_user", { ...ids, userId: check.userId });
    return c.json({ ok: true, ignored: true, reason: "unknown_user" });
  }

  // A refunded purchase stays refunded (REVIEW M2). Stripe retries a grant event
  // for up to three days and the dashboard can resend it; the resend is
  // correctly signed and freshly timestamped, so only the tombstone tells it
  // apart from the original. Checked before the re-read so a replay costs no
  // Stripe call. 200, because a non-2xx makes Stripe retry what we declined.
  if (await isRevoked(c.env, "stripe", check.paymentIntentId)) {
    logNoGrant("stripe", "revoked", ids);
    return c.json({ ok: true, ignored: true, reason: "revoked" });
  }

  // Re-read the payment rather than trusting the snapshot (see
  // fetchPaymentState). Without a usable key we cannot, and granting unread
  // would reopen the refund-before-grant hole — so 503, and Stripe retries
  // until the key is fixed.
  if (!keyMode((c.env.STRIPE_SECRET_KEY ?? "").trim())) {
    console.error("billing: STRIPE_SECRET_KEY unset or malformed; cannot confirm payment", ids);
    return c.json({ error: "not_configured" }, 503);
  }
  let state: PaymentState;
  try {
    state = await fetchPaymentState(c.env, check.paymentIntentId);
  } catch (err) {
    // 503 so Stripe retries: a paid customer must not be dropped because one
    // API read failed.
    console.error("billing: stripe payment re-read failed", {
      ...ids,
      error: err instanceof StripeApiError ? `${err.status} ${err.code}` : "unknown",
    });
    return c.json({ error: "stripe_unavailable" }, 503);
  }
  if (!state.ok) {
    if (state.retry) {
      // Still settling (a delayed method, 3-D Secure in progress). Not a
      // refusal: Stripe redelivers, and a later delivery finds it succeeded.
      console.warn("billing: payment not settled yet", { ...ids, reason: state.reason });
      return c.json({ error: "payment_pending" }, 503);
    }
    logNoGrant("stripe", state.reason, ids);
    return c.json({ ok: true, ignored: true, reason: state.reason });
  }

  await upsertEntitlement(c.env, {
    source: "stripe",
    externalId: check.paymentIntentId,
    userId: check.userId,
    environment: check.environment,
  });

  return c.json({ ok: true, plus: true });
});

// ---- GET /api/billing/checkout --------------------------------------------
//
// Creates a Managed Payments Checkout Session and returns its URL for the
// client to navigate to. A redirect, not an embedded form: nothing from Stripe
// runs on our origin, so security.ts and the CSP are unchanged.
//
// `requireCsrf` on a GET is unusual and deliberate (REVIEW.md minor mB5). This
// route SPENDS something — a 10/h per-user budget, and a Stripe API call — and
// the session cookie is SameSite=Lax, which is sent on a cross-site top-level
// navigation. A hostile page could bounce a signed-in visitor through this URL
// ten times and leave the real Buy button answering 429 for the next hour. The
// CSRF token is not readable cross-origin and cannot be attached to a
// navigation, so requiring it is what makes the budget the user's own to spend.
// Bearer callers are exempt inside the middleware, which is correct: a token
// sent by hand is not an ambient credential.
billing.get("/checkout", requireAuth, requireCsrf, async (c) => {
  const user = c.get("user")!;

  // While Plus is dark there is nothing to sell. The grant paths above stay
  // live on purpose even then — refusing to RECORD a payment we already took
  // would be much worse than recording one that is not yet useful.
  // Gated on the SURFACE, not on cap enforcement. If the paywall is visible,
  // the buy button behind it has to work — otherwise the review window shows a
  // purchase the user can see and cannot make.
  if (!envFlag(c.env.PLUS_SURFACE_ENABLED)) return c.json({ error: "not_enabled" }, 503);

  // CONFIG BEFORE THE RATE LIMIT (minor). `not_configured` is permanent: no
  // amount of retrying fills in a price or a key. Charging the per-user budget
  // for it meant ten clicks on a button that can never work earned a 429 — so
  // the user was told to slow down about a thing that was never going to
  // happen, and the honest error was replaced by a misleading one.
  if (!checkoutConfigured(c.env)) return c.json({ error: "not_configured" }, 503);

  if (!(await checkAll(c.env, [{ key: `billing:checkout:${user.id}:h`, rule: BILLING_RULE }]))) {
    return c.json({ error: "rate_limited" }, 429);
  }

  try {
    return c.json({ url: await createCheckoutSession(c.env, user.id) });
  } catch (err) {
    // 502: our upstream failed, not the request. The client shows its generic
    // error, which is the right message. Status and Stripe's code only — never
    // the key, and never the error object, which can hold the request.
    console.error("billing: checkout session failed", {
      userId: user.id,
      error: err instanceof StripeApiError ? `${err.status} ${err.code}` : "unknown",
    });
    return c.json({ error: "checkout_failed" }, 502);
  }
});
