// Lightweight KV rate limiting — abuse ceilings, not a product cap (spec §10).
// A fixed-window counter per key; KV isn't transactional, but slight slippage is
// fine for ceilings. Returns true if the request is allowed.

import type { Env } from "../types";

export interface RateRule {
  limit: number;
  windowSec: number;
}

export async function checkRateLimit(env: Env, key: string, rule: RateRule): Promise<boolean> {
  const k = `rl:${key}`;
  const current = parseInt((await env.RATELIMIT.get(k)) ?? "0", 10) || 0;
  if (current >= rule.limit) return false;
  await env.RATELIMIT.put(k, String(current + 1), { expirationTtl: rule.windowSec });
  return true;
}

/** Check several rules at once (e.g. per-hour and per-day); all must pass. */
export async function checkAll(
  env: Env,
  rules: { key: string; rule: RateRule }[],
): Promise<boolean> {
  for (const { key, rule } of rules) {
    if (!(await checkRateLimit(env, key, rule))) return false;
  }
  return true;
}
