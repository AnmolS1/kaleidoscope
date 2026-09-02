// Kaleidoscope Plus: StoreKit grants, App Store Server Notifications, the
// Lemon Squeezy webhook, and the hosted-checkout redirect (PLAN §2.3).
//
// Four routes with deliberately different gates:
//
//   POST /api/billing/apple              auth + CSRF + rate limit  (the iOS app calls it)
//   POST /api/billing/apple/notifications  NONE                    (Apple's server calls it)
//   POST /api/billing/lemonsqueezy         NONE                    (LS's server calls it)
//   GET  /api/billing/checkout           auth + rate limit         (the web client calls it)
//
// The two webhooks are unauthenticated by necessity — Apple and Lemon Squeezy
// have no session with us. Their ONLY authentication is the signature, which is
// why both signature paths are fail-closed and mutation-tested.

import { Hono } from "hono";
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
  verifyLsSignature,
  checkLsOrder,
  checkoutUrl,
  testModeAllowed,
  type LsWebhook,
} from "../lib/lemonsqueezy";
import type { Env, PlusSource } from "../types";

export const billing = new Hono<AppEnv>();

/** §2.3: 10/h on both authenticated billing routes. */
const BILLING_RULE = { limit: 10, windowSec: 3600 };

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
 *  refund, and Lemon Squeezy retries `order_created` for three days and offers
 *  a manual resend. Clearing the tombstone here would re-grant on a replay and
 *  undo the whole point of having one. */
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
): Promise<boolean> {
  const res = await env.DB.prepare(
    "UPDATE entitlements SET revoked_at = ? WHERE source = ? AND external_id = ? AND revoked_at IS NULL",
  )
    .bind(Date.now(), source, externalId)
    .run();
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

  const removed = await revokeEntitlement(c.env, "apple", originalTransactionId);
  return c.json({ ok: true, removed });
});

// ---- POST /api/billing/lemonsqueezy ---------------------------------------
//
// Unauthenticated; the HMAC over the RAW BODY is the only credential.
//
// Business rejections (test mode, unpaid, wrong variant, unknown user) answer
// 200 `{ ignored: true, reason }` rather than 4xx, because LS retries non-2xx on
// a schedule and none of these will ever succeed on a retry. The security
// assertion in the tests is therefore "no entitlement row exists", not the
// status code — a bad signature is the one case that stays a hard 401.
billing.post("/lemonsqueezy", async (c) => {
  // The raw bytes, exactly as sent. Re-serializing a parsed body would change
  // key order and whitespace, so the HMAC would match only bodies we built
  // ourselves and never a real webhook.
  const raw = await c.req.text();
  const signature = c.req.header("X-Signature");

  if (!(await verifyLsSignature(c.env.LS_WEBHOOK_SECRET ?? "", raw, signature))) {
    return c.json({ error: "bad_signature" }, 401);
  }

  let body: LsWebhook;
  try {
    body = JSON.parse(raw) as LsWebhook;
  } catch {
    return c.json({ error: "bad_body" }, 400);
  }

  const event = typeof body.meta?.event_name === "string" ? body.meta.event_name : "";
  const orderId =
    typeof body.data?.id === "string"
      ? body.data.id
      : typeof body.data?.id === "number"
        ? String(body.data.id)
        : null;

  if (event === "order_refunded") {
    if (!orderId) return c.json({ ok: true, ignored: true, reason: "missing_order_id" });
    const removed = await revokeEntitlement(c.env, "lemonsqueezy", orderId);
    return c.json({ ok: true, removed });
  }

  if (event !== "order_created") return c.json({ ok: true, ignored: true, reason: "event" });

  const check = checkLsOrder(body, {
    variantId: (c.env.LS_VARIANT_ID ?? "").trim(),
    allowTest: testModeAllowed(c.env),
  });
  if (!check.ok) return c.json({ ok: true, ignored: true, reason: check.reason });

  // `entitlements.user_id` has a FK to `users`. A custom_data user_id that no
  // longer resolves would raise a constraint error and turn into a 500, which
  // LS would then retry forever; check first and answer cleanly instead.
  if (!(await getUserById(c.env, check.userId))) {
    return c.json({ ok: true, ignored: true, reason: "unknown_user" });
  }

  // A refunded order stays refunded (REVIEW M2). LS retries `order_created` for
  // up to three days and the dashboard offers a manual resend; the retry is
  // byte-identical and correctly signed, so nothing upstream distinguishes it
  // from the original. 200 rather than an error code, because a non-2xx here
  // makes LS retry the thing we are declining.
  if (await isRevoked(c.env, "lemonsqueezy", check.orderId)) {
    return c.json({ ok: true, ignored: true, reason: "revoked" });
  }

  await upsertEntitlement(c.env, {
    source: "lemonsqueezy",
    externalId: check.orderId,
    userId: check.userId,
    environment: null,
  });

  return c.json({ ok: true, plus: true });
});

// ---- GET /api/billing/checkout --------------------------------------------
//
// Returns a URL for the client to navigate to. A redirect, not an overlay: the
// overlay would need LS's script host in `script-src`, and §2.3 pins the CSP as
// unchanged. Nothing in security.ts needed touching.
billing.get("/checkout", requireAuth, async (c) => {
  const user = c.get("user")!;

  // While Plus is dark there is nothing to sell. The grant paths above stay
  // live on purpose even then — refusing to RECORD a payment we already took
  // would be much worse than recording one that is not yet useful.
  if (!envFlag(c.env.PLUS_ENABLED)) return c.json({ error: "not_enabled" }, 503);

  if (!(await checkAll(c.env, [{ key: `billing:checkout:${user.id}:h`, rule: BILLING_RULE }]))) {
    return c.json({ error: "rate_limited" }, 429);
  }

  const url = checkoutUrl(c.env, user.id);
  if (!url) return c.json({ error: "not_configured" }, 503);

  return c.json({ url });
});
