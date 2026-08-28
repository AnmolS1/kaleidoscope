// Lemon Squeezy webhook verification + hosted-checkout URL (PLAN §2.3).
//
// The web half of Kaleidoscope Plus. LS posts a signed JSON webhook on purchase
// and on refund; the checkout itself is a plain redirect to LS's hosted page, so
// no CSP change is needed (§2.3 explicitly: "redirect, not overlay").
//
// Field paths below were checked against lemonsqueezy.js's own `orders/types.ts`
// and their reference Next.js webhook handler, not from memory. They live in ONE
// typed interface so a correction is one edit rather than a hunt.

import type { Env } from "../types";
import { envFlag } from "./validate";

/**
 * The webhook fields we act on. Everything is `unknown`-typed at the boundary:
 * this is attacker-reachable JSON, and a field that is confidently typed but
 * actually absent is how a check turns into a no-op.
 */
export interface LsWebhook {
  meta?: {
    event_name?: unknown;
    test_mode?: unknown;
    /** What `checkout[custom][user_id]` comes back as. */
    custom_data?: Record<string, unknown>;
    /** Older/alternate spelling seen in the wild; harmless to also accept. */
    custom?: Record<string, unknown>;
  };
  data?: {
    /** The LS order id — our `external_id`. */
    id?: unknown;
    attributes?: {
      status?: unknown; // "pending" | "failed" | "paid" | "refunded" | "fraudulent"
      total?: unknown; // cents
      test_mode?: unknown;
      refunded?: unknown;
      store_id?: unknown;
      first_order_item?: { variant_id?: unknown; test_mode?: unknown };
    };
  };
}

/** Lowercase hex of an ArrayBuffer. */
function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string compare. Length is not secret (both are 64-char hex). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify the `X-Signature` header: HMAC-SHA256 of the **raw body bytes**, hex.
 *
 * `raw` must be the exact bytes LS sent — `await c.req.text()`, never
 * `JSON.stringify(await c.req.json())`. Re-stringifying reorders keys and drops
 * whitespace, which matches in a test that built its body the same way and never
 * matches a real webhook. `verifyLsSignature`'s own test feeds it a body with
 * non-canonical key order and spacing precisely so the two implementations are
 * distinguishable.
 */
export async function verifyLsSignature(
  secret: string,
  raw: string,
  signature: string | undefined,
): Promise<boolean> {
  // No secret configured means we cannot verify anything. Reject rather than
  // skip: an unconfigured webhook endpoint that accepts everything is worse
  // than one that accepts nothing.
  if (!secret || !signature) return false;
  if (!/^[0-9a-f]+$/i.test(signature)) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  return timingSafeEqual(toHex(mac), signature.toLowerCase());
}

/**
 * Is this a test-mode payload?
 *
 * Truthy-anywhere on purpose, and it is the only field here that gets this
 * treatment. Every other check fails CLOSED when its path is wrong — a missing
 * `status` reads `undefined`, which is not `"paid"`, so nothing is granted. A
 * missing `test_mode` reads `undefined`, which is falsy, which reads as
 * "this is a real purchase". That one fails OPEN, and the failure is test-mode
 * orders granting real Plus. So check every place LS is known to put it
 * (`meta`, the order attributes, and the order item) and treat any of them as
 * decisive.
 */
export function isTestMode(body: LsWebhook): boolean {
  const attrs = body.data?.attributes;
  return !!(body.meta?.test_mode || attrs?.test_mode || attrs?.first_order_item?.test_mode);
}

export type LsCheck =
  | { ok: true; orderId: string; userId: string }
  | { ok: false; reason: string };

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** LS sends numeric ids as JSON numbers in `attributes` and as strings in
 *  `data.id`. Compare as strings so a config var of "12345" matches either. */
const idStr = (v: unknown): string | null => {
  if (typeof v === "string" && v !== "") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
};

/**
 * Decide whether a SIGNATURE-VERIFIED `order_created` payload grants Plus.
 *
 * Signature validity says "Lemon Squeezy really sent this". Everything here says
 * "…and it is a real, paid purchase of OUR product, attributed to a user".
 */
export function checkLsOrder(
  body: LsWebhook,
  o: { variantId: string; allowTest: boolean },
): LsCheck {
  if (isTestMode(body) && !o.allowTest) return { ok: false, reason: "test_mode" };

  const attrs = body.data?.attributes;
  if (str(attrs?.status) !== "paid") return { ok: false, reason: "not_paid" };

  // Fail closed on an unconfigured variant: `LS_VARIANT_ID` ships as "" in
  // wrangler.jsonc, and "" === "" would otherwise match a payload with no
  // variant at all and grant Plus on any signed webhook.
  const variant = idStr(attrs?.first_order_item?.variant_id);
  if (!o.variantId || !variant || variant !== o.variantId) {
    return { ok: false, reason: "wrong_variant" };
  }

  const total = typeof attrs?.total === "number" ? attrs.total : NaN;
  if (!Number.isFinite(total) || total <= 0) return { ok: false, reason: "not_positive_total" };

  const orderId = idStr(body.data?.id);
  if (!orderId) return { ok: false, reason: "missing_order_id" };

  const custom = body.meta?.custom_data ?? body.meta?.custom;
  const userId = str(custom?.user_id);
  if (!userId) return { ok: false, reason: "unattributed" };

  return { ok: true, orderId, userId };
}

/**
 * The hosted-checkout URL for Plus.
 *
 * LS's hosted checkout lives at `https://<store>.lemonsqueezy.com/buy/<variant>`
 * and reads pass-through data from `checkout[custom][...]`, which is what comes
 * back as `meta.custom_data` on the webhook. That round trip is the ONLY thing
 * tying a payment to an account, so `user_id` is not optional decoration.
 *
 * Returns null when either var is unset — `LS_STORE_ID`/`LS_VARIANT_ID` ship as
 * "" until the store exists, and a URL built from empty strings is a live link
 * to a 404 rather than an honest "not configured yet".
 *
 * NOTE for T20: `LS_STORE_ID` is used here as the store SUBDOMAIN. Confirm
 * against the real store when it is created — LS's hosted URL is keyed by the
 * store's slug, which may not equal its numeric id.
 */
export function checkoutUrl(env: Env, userId: string): string | null {
  const store = (env.LS_STORE_ID ?? "").trim();
  const variant = (env.LS_VARIANT_ID ?? "").trim();
  if (!store || !variant) return null;

  const url = new URL(`https://${store}.lemonsqueezy.com/buy/${encodeURIComponent(variant)}`);
  url.searchParams.set("checkout[custom][user_id]", userId);
  // Full-page hosted checkout, not the overlay — the overlay would need LS's
  // script in our CSP (§2.3: "redirect, not overlay — CSP unchanged").
  url.searchParams.set("embed", "0");
  return url.toString();
}

/** Whether test-mode LS webhooks are accepted (the pre-launch switch). */
export function testModeAllowed(env: Env): boolean {
  return envFlag(env.PLUS_ALLOW_TEST);
}
