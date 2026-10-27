// Stripe Checkout with Managed Payments — the web half of Kaleidoscope Plus.
//
// Managed Payments makes Stripe (through Link) the merchant of record, so sales
// tax, VAT and GST are Stripe's to collect and remit, not ours. The integration
// itself is ordinary hosted Checkout: the worker creates a Checkout Session and
// the client NAVIGATES to its URL (no Stripe.js, so the CSP is unchanged), and a
// signed webhook reports the payment.
//
// No Stripe SDK. Two REST calls and an HMAC do not justify a dependency in the
// worker bundle, and keeping the wire format in one file makes it reviewable.
// Shapes checked against docs.stripe.com (Managed Payments set-up, Checkout
// Sessions, webhook signatures; 2026-10-27), not from memory. Only fields that
// are stable across API versions are read, because the webhook payload shape is
// governed by the ENDPOINT's version in the dashboard, not by the pin below.

import type { Env } from "../types";
import { envFlag } from "./validate";

/** Pinned on every call. `managed_payments` on Checkout Sessions shipped in
 *  this version; an unpinned call would follow the account default, which can
 *  move under us. Create the webhook endpoint on the same version. */
export const STRIPE_API_VERSION = "2026-04-22.dahlia";
const API = "https://api.stripe.com/v1";

/** Stripe's own libraries reject signatures more than five minutes old. */
export const SIGNATURE_TOLERANCE_SEC = 300;

/** Every Stripe call gives up after this. Without it a hung connection holds
 *  the request until the platform kills it, and the webhook answers nothing
 *  useful; with it, the grant path answers 503 and Stripe retries. */
const STRIPE_TIMEOUT_MS = 10_000;

/** Marks a Checkout Session as ours. The Stripe account may sell other things
 *  (another product, another app), and a valid signature only proves "Stripe
 *  sent this for this account". Metadata can only be set with our secret key,
 *  so it is what binds a payment to Kaleidoscope Plus. */
export const SESSION_METADATA = { app: "kaleidoscope", product: "plus" } as const;

/** The webhook fields we act on. Everything is `unknown`-typed at the boundary:
 *  this is attacker-shaped JSON until proven otherwise, and a field that is
 *  confidently typed but actually absent is how a check turns into a no-op. */
export interface StripeEvent {
  id?: unknown;
  type?: unknown;
  livemode?: unknown;
  data?: { object?: Record<string, unknown> };
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** An expandable field arrives as an id string, or as an object with an id. */
const idOf = (v: unknown): string | null => str(v) ?? (isRecord(v) ? str(v.id) : null);

// ---- signature --------------------------------------------------------------

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time compare. Length is not secret (both are 64-char hex). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Parse `Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>][,v0=<hex>]`.
 *
 * More than one `v1` is normal: while an endpoint secret is being rolled,
 * Stripe signs with every active secret, and only one of them is ours. `v0` is
 * a legacy test-mode scheme that Stripe's libraries ignore, and so do we — a
 * verifier that accepted "any vN" would accept a scheme nobody agreed to.
 *
 * A malformed `v1` entry is skipped rather than fatal, matching the libraries.
 * The timestamp is the opposite: a missing, non-numeric or DUPLICATED `t` makes
 * the whole header invalid, because the MAC covers exactly one `t` and
 * guessing which one was signed is the attacker's game, not ours.
 */
function parseSignatureHeader(header: string): { t: number; v1: string[] } | null {
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t") {
      if (t !== null || !/^\d{1,12}$/.test(v)) return null;
      t = Number(v);
    } else if (k === "v1" && /^[0-9a-f]{64}$/i.test(v)) {
      v1.push(v.toLowerCase());
    }
  }
  return t === null || v1.length === 0 ? null : { t, v1 };
}

/**
 * Verify a webhook: HMAC-SHA256 keyed with the endpoint secret (the WHOLE
 * `whsec_…` string, prefix included — it is not base64 to decode) over
 * `"<t>.<raw body>"`, hex, compared with each `v1`.
 *
 * `raw` must be the exact bytes Stripe sent — `await c.req.text()`, never a
 * re-serialized parse, which reorders keys and drops whitespace and so matches
 * only bodies a test built the same way.
 *
 * Fails closed: no secret, no header, a malformed header, or a timestamp more
 * than five minutes either side of now all return false. The timestamp is
 * inside the signed string, so the window is what stops a captured delivery
 * being replayed indefinitely; the tombstone covers replays inside it.
 *
 * The secret is trimmed: `wrangler secret put` from a pasted line keeps the
 * newline, and a key with a trailing "\n" verifies nothing, silently.
 */
export async function verifyStripeSignature(
  secret: string,
  raw: string,
  header: string | undefined,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const key = (secret ?? "").trim();
  // No secret means we cannot verify anything. Reject rather than skip: an
  // unconfigured endpoint that accepts everything is worse than one that
  // accepts nothing. (WebCrypto also refuses a zero-length HMAC key.)
  if (!key || !header) return false;
  const parsed = parseSignatureHeader(header);
  if (!parsed) return false;
  if (Math.abs(nowMs / 1000 - parsed.t) > SIGNATURE_TOLERANCE_SEC) return false;

  const hmac = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = toHex(
    await crypto.subtle.sign("HMAC", hmac, new TextEncoder().encode(`${parsed.t}.${raw}`)),
  );
  // Every candidate is compared, without short-circuiting, so the time taken
  // does not say which `v1` (if any) matched.
  let match = false;
  for (const sig of parsed.v1) match = timingSafeEqual(mac, sig) || match;
  return match;
}

// ---- event checks -----------------------------------------------------------

/** The environment column value for a Stripe row (see `liveEntitlement`). */
export type StripeEnvironment = "Production" | "Test";

export type StripeGrantCheck =
  | { ok: true; paymentIntentId: string; userId: string; environment: StripeEnvironment }
  | { ok: false; reason: string };

/** Event types that can grant. `async_payment_succeeded` is the late success of
 *  a delayed method (Managed Payments offers some — Klarna, Bancontact…), whose
 *  `completed` event arrived with `payment_status: "unpaid"`. */
export const GRANT_EVENTS: ReadonlySet<string> = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
]);

/** Event types that can revoke. */
export const REVOKE_EVENTS: ReadonlySet<string> = new Set(["charge.refunded", "charge.dispute.closed"]);

/**
 * Decide whether a SIGNATURE-VERIFIED checkout event is a paid purchase of Plus
 * attributed to an account. Signature validity says "Stripe really sent this";
 * everything here says "…and it is a real, paid purchase of OUR product, by a
 * user we named when we created the session". Every check fails closed: a
 * missing field is a refusal, never a pass.
 */
export function checkCheckoutEvent(event: StripeEvent, o: { allowTest: boolean }): StripeGrantCheck {
  const s = isRecord(event.data?.object) ? event.data.object : {};

  // Live only when BOTH the event and the session say so, as the boolean
  // `true`. A missing or odd flag reads as TEST, which is the direction that
  // fails closed: a malformed payload can only ever grant under PLUS_ALLOW_TEST,
  // and a test-mode payment (card 4242…, no money) never grants real Plus.
  const live = event.livemode === true && s.livemode === true;
  if (!live && !o.allowTest) return { ok: false, reason: "test_mode" };

  if (s.object !== "checkout.session") return { ok: false, reason: "not_a_session" };

  // Bound to Plus, not just to "this Stripe account".
  const meta = isRecord(s.metadata) ? s.metadata : {};
  if (meta.app !== SESSION_METADATA.app || meta.product !== SESSION_METADATA.product) {
    return { ok: false, reason: "wrong_product" };
  }
  if (s.mode !== "payment") return { ok: false, reason: "wrong_mode" };

  // "paid" exactly. `unpaid` is a delayed method still in flight (its
  // async_payment_succeeded comes later); `no_payment_required` is a 100%
  // discount or a $0 session, which is not a purchase of a paid unlock.
  if (s.payment_status !== "paid") return { ok: false, reason: "not_paid" };

  const total = typeof s.amount_total === "number" ? s.amount_total : NaN;
  if (!Number.isFinite(total) || total <= 0) return { ok: false, reason: "not_positive_total" };

  // The payment intent is our external_id: refunds and disputes point at it,
  // and the re-read below fetches it.
  const paymentIntentId = idOf(s.payment_intent);
  if (!paymentIntentId) return { ok: false, reason: "missing_payment_intent" };

  // Two copies of the user id, both written by our server when it created the
  // session. They must agree; one without the other is a session we did not
  // build the way we build sessions (a hand-made Payment Link, say).
  const ref = str(s.client_reference_id);
  const metaUser = str(meta.user_id);
  if (!ref || !metaUser) return { ok: false, reason: "unattributed" };
  if (ref !== metaUser) return { ok: false, reason: "attribution_mismatch" };

  return { ok: true, paymentIntentId, userId: ref, environment: live ? "Production" : "Test" };
}

export type StripeRevocation =
  | { ok: true; paymentIntentId: string }
  | { ok: false; reason: string };

/**
 * A refund or a lost dispute takes Plus away.
 *
 * - `charge.refunded` fires for partial refunds too. Only a FULL refund
 *   (`refunded: true`) revokes; a partial refund of a one-time unlock is a
 *   goodwill credit, not a cancellation.
 * - A dispute revokes only when it is LOST. Managed Payments fights disputes
 *   on our behalf, and an open or won dispute is still a paying customer.
 *
 * No livemode gate: payment intent ids are unique across live and test mode,
 * so a test-mode refund can only ever name a test-mode row.
 */
export function checkRevocationEvent(event: StripeEvent): StripeRevocation {
  const o = isRecord(event.data?.object) ? event.data.object : {};
  if (event.type === "charge.refunded") {
    if (o.object !== "charge") return { ok: false, reason: "not_a_charge" };
    if (o.refunded !== true) return { ok: false, reason: "partial_refund" };
  } else if (event.type === "charge.dispute.closed") {
    if (o.object !== "dispute") return { ok: false, reason: "not_a_dispute" };
    if (o.status !== "lost") return { ok: false, reason: "dispute_not_lost" };
  } else {
    return { ok: false, reason: "event" };
  }
  const paymentIntentId = idOf(o.payment_intent);
  if (!paymentIntentId) return { ok: false, reason: "missing_payment_intent" };
  return { ok: true, paymentIntentId };
}

/** The ids a log line about this event should carry: enough for support to find
 *  it in the Stripe dashboard, and nothing else. Never the object itself — a
 *  Checkout Session carries `customer_details.email`. */
export function eventIds(event: StripeEvent): {
  eventId: string | null;
  objectId: string | null;
  paymentIntentId: string | null;
} {
  const o = isRecord(event.data?.object) ? event.data.object : {};
  return { eventId: str(event.id), objectId: str(o.id), paymentIntentId: idOf(o.payment_intent) };
}

// ---- REST calls ---------------------------------------------------------------

/** A Stripe call that did not produce a usable answer. `status` is the HTTP
 *  status (0 when there was no response at all); `code` is Stripe's error code
 *  or type, or ours. Neither ever carries the key or the request body. */
export class StripeApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(`stripe ${status} ${code}`);
    this.name = "StripeApiError";
    this.status = status;
    this.code = code;
  }
}

/** sk_live_/rk_live_ → "live", sk_test_/rk_test_ → "test", anything else null
 *  (a publishable `pk_` key, a blank, a typo). */
export function keyMode(key: string): "live" | "test" | null {
  if (/^(sk|rk)_live_/.test(key)) return "live";
  if (/^(sk|rk)_test_/.test(key)) return "test";
  return null;
}

/** Whether test-mode Stripe payments may grant (the pre-launch switch). */
export function testModeAllowed(env: Env): boolean {
  return envFlag(env.PLUS_ALLOW_TEST);
}

/**
 * Whether checkout can be offered at all.
 *
 * A TEST key on a deploy that does not accept test grants counts as
 * unconfigured: real visitors would be sent to a checkout that takes their
 * card details, charges nothing, and grants nothing. The `price_` prefix
 * catches the likeliest paste error, a `prod_` id, which Stripe would reject
 * on every click.
 */
export function checkoutConfigured(env: Env): boolean {
  const mode = keyMode((env.STRIPE_SECRET_KEY ?? "").trim());
  const price = (env.STRIPE_PRICE_ID ?? "").trim();
  if (!mode || !price.startsWith("price_")) return false;
  if (mode === "test" && !testModeAllowed(env)) return false;
  return true;
}

/**
 * One Stripe call. Throws `StripeApiError` on anything but a 2xx with a JSON
 * OBJECT body — including a 2xx whose body is HTML from a proxy, which a
 * `.catch(() => ({}))` would quietly turn into "every field missing".
 */
async function stripeRequest(
  env: Env,
  path: string,
  init: { method: "GET" | "POST"; body?: URLSearchParams },
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetchImpl(`${API}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${(env.STRIPE_SECRET_KEY ?? "").trim()}`,
        "Stripe-Version": STRIPE_API_VERSION,
        ...(init.body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      body: init.body?.toString(),
      signal: AbortSignal.timeout(STRIPE_TIMEOUT_MS),
    });
  } catch (err) {
    // Network failure or timeout. The name only: the error object can hold the
    // request, and the request holds the key.
    throw new StripeApiError(0, err instanceof Error ? err.name : "network");
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new StripeApiError(res.status, "non_json");
  }
  if (!res.ok) {
    const e = isRecord(json) && isRecord(json.error) ? json.error : {};
    throw new StripeApiError(res.status, str(e.code) ?? str(e.type) ?? "error");
  }
  if (!isRecord(json)) throw new StripeApiError(res.status, "non_object");
  return json;
}

/**
 * Create a Managed Payments Checkout Session for Plus and return its URL.
 *
 * `client_reference_id` and `metadata[user_id]` are the ONLY link between the
 * payment and the account, so neither is optional. The same metadata goes on
 * the PaymentIntent, which is what refunds and disputes point at and what
 * support sees first in the dashboard.
 *
 * Deliberately absent, because Managed Payments rejects them or because the
 * default is what we want: `automatic_tax`, `tax_id_collection`,
 * `payment_method_types`, `customer_update`, statement descriptors, shipping,
 * `receipt_email` (Link sends the receipt), and `ui_mode` (hosted is the
 * default; embedded would put Stripe.js on our origin and change the CSP).
 */
export async function createCheckoutSession(
  env: Env,
  userId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const base = env.PUBLIC_BASE_URL.replace(/\/+$/, "");
  const body = new URLSearchParams({
    mode: "payment",
    "line_items[0][price]": (env.STRIPE_PRICE_ID ?? "").trim(),
    "line_items[0][quantity]": "1",
    "managed_payments[enabled]": "true",
    client_reference_id: userId,
    "metadata[app]": SESSION_METADATA.app,
    "metadata[product]": SESSION_METADATA.product,
    "metadata[user_id]": userId,
    "payment_intent_data[metadata][app]": SESSION_METADATA.app,
    "payment_intent_data[metadata][product]": SESSION_METADATA.product,
    "payment_intent_data[metadata][user_id]": userId,
    success_url: `${base}/?plus=thanks`,
    cancel_url: `${base}/`,
  });
  const session = await stripeRequest(env, "/checkout/sessions", { method: "POST", body }, fetchImpl);
  // The client navigates wherever this says. Anything but an https URL is a
  // broken redirect at best, so refuse it here rather than hand it out.
  const url = str(session.url);
  if (!url || !url.startsWith("https://")) throw new StripeApiError(200, "no_session_url");
  return url;
}

/**
 * What the re-read says. `retry: true` means "not yet" — the route answers 503
 * so Stripe redelivers; `retry: false` is a final no and answers 200.
 */
export type PaymentState =
  | { ok: true }
  | { ok: false; retry: boolean; reason: string };

/** Final refusals by PaymentIntent status. Every other non-`succeeded` status
 *  (processing, requires_action, requires_confirmation, requires_capture, and
 *  anything Stripe adds later) can still become a payment, so it retries. */
const FINAL_STATUS: Record<string, string> = {
  canceled: "payment_canceled",
  requires_payment_method: "payment_failed",
};

/**
 * Re-read the payment before granting, rather than trusting the event snapshot.
 *
 * Stripe's docs warn that a snapshot can be stale, and here it matters: if the
 * grant webhook is delayed (our endpoint down, Stripe retrying for up to three
 * days) and the customer is refunded meanwhile, the refund event finds no row
 * to tombstone and the late grant would hand out Plus for free.
 *
 * A DISPUTED charge still grants. Disputes take weeks to close and Stripe stops
 * retrying after three days, so refusing here would strand a paying customer
 * whose dispute is then won. A lost dispute arrives as `charge.dispute.closed`
 * and revokes the row this writes.
 *
 * Throws `StripeApiError` (→ 503, Stripe retries) when the answer is unusable,
 * including a `succeeded` intent whose charge did not come back expanded: that
 * is our request being wrong, not the customer being unpaid.
 */
export async function fetchPaymentState(
  env: Env,
  paymentIntentId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PaymentState> {
  const qs = new URLSearchParams({ "expand[]": "latest_charge" });
  const pi = await stripeRequest(
    env,
    `/payment_intents/${encodeURIComponent(paymentIntentId)}?${qs}`,
    { method: "GET" },
    fetchImpl,
  );
  const status = str(pi.status) ?? "missing";
  if (status !== "succeeded") {
    const final = FINAL_STATUS[status];
    return final
      ? { ok: false, retry: false, reason: final }
      : { ok: false, retry: true, reason: `payment_${status}` };
  }
  const charge = pi.latest_charge;
  if (!isRecord(charge) || !str(charge.id)) throw new StripeApiError(200, "charge_not_expanded");
  // FULL refund only, matching `checkRevocationEvent`: a partial refund does
  // not revoke, so it must not block the grant either.
  if (charge.refunded === true) return { ok: false, retry: false, reason: "refunded" };
  return { ok: true };
}
