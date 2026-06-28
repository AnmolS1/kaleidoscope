import { Hono } from "hono";
import type { AppEnv } from "../middleware";
import { requireCsrf } from "../middleware";
import { buildAuthUrl, createPkce, exchangeCode, verifyIdToken } from "../lib/oauth";
import { randomToken } from "../lib/ids";
import { upsertUser } from "../lib/db";
import { createSession, destroySession, writeSessionCookie } from "../lib/session";

const OAUTH_TTL = 600; // 10 min

interface OAuthState {
  nonce: string;
  verifier: string;
  returnTo: string;
}

/** Only allow same-site path redirects (no protocol-relative // or absolute). */
function safeReturnTo(raw: string | undefined): string {
  if (!raw) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}

export const auth = new Hono<AppEnv>();

auth.get("/login", async (c) => {
  const { verifier, challenge } = await createPkce();
  const state = randomToken(24);
  const nonce = randomToken(24);
  const returnTo = safeReturnTo(c.req.query("returnTo"));

  const payload: OAuthState = { nonce, verifier, returnTo };
  await c.env.OAUTH.put(state, JSON.stringify(payload), { expirationTtl: OAUTH_TTL });

  return c.redirect(buildAuthUrl(c.env, { state, nonce, challenge }), 302);
});

auth.get("/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const home = c.env.PUBLIC_BASE_URL;

  if (!code || !state) return c.redirect(`${home}/?auth_error=1`, 302);

  // single-use: read then delete
  const stored = await c.env.OAUTH.get<OAuthState>(state, "json");
  await c.env.OAUTH.delete(state);
  if (!stored) return c.redirect(`${home}/?auth_error=state`, 302);

  try {
    const tokens = await exchangeCode(c.env, code, stored.verifier);
    const claims = await verifyIdToken(c.env, tokens.id_token, stored.nonce);

    const user = await upsertUser(c.env, {
      google_sub: claims.sub,
      email: claims.email ?? null,
      name: claims.name ?? null,
      avatar_url: claims.picture ?? null,
    });

    const { id } = await createSession(c.env, user.id);
    writeSessionCookie(c, id);
    return c.redirect(`${home}${stored.returnTo}`, 302);
  } catch {
    return c.redirect(`${home}/?auth_error=verify`, 302);
  }
});

auth.post("/logout", requireCsrf, async (c) => {
  const session = c.get("session");
  if (session) await destroySession(c, session.id);
  return c.body(null, 204);
});

// Dev/test only: create a session without Google. Gated by ALLOW_TEST_LOGIN,
// which is never set in production — returns 404 otherwise.
auth.post("/test-login", async (c) => {
  if (c.env.ALLOW_TEST_LOGIN !== "true") return c.json({ error: "not_found" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as {
    sub?: string;
    name?: string;
    email?: string;
  };
  const user = await upsertUser(c.env, {
    google_sub: body.sub || "test-sub-1",
    email: body.email || "test@example.com",
    name: body.name || "Test User",
    avatar_url: null,
  });
  const { id } = await createSession(c.env, user.id);
  writeSessionCookie(c, id);
  return c.json({ ok: true, userId: user.id });
});
