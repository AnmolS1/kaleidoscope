import { Hono } from "hono";
import type { AppEnv } from "../middleware";
import { requireCsrf } from "../middleware";
import { buildAuthUrl, createPkce, exchangeCode, verifyIdToken } from "../lib/oauth";
import { verifyAppleIdentityToken } from "../lib/apple";
import { randomToken } from "../lib/ids";
import {
  upsertUser,
  setUserAvatar,
  upsertAppleUser,
  linkAppleToUser,
  getUserByAppleSub,
  getUserByEmail,
} from "../lib/db";
import { cacheRemoteAvatar } from "../lib/r2";
import { createSession, destroySession, writeSessionCookie } from "../lib/session";
import type { SessionUser, User } from "../types";

const OAUTH_TTL = 600; // 10 min

// Native (iOS) clients can't receive the httpOnly cookie, so the Google flow
// hands the session back via a custom-scheme redirect instead.
const APP_SCHEME = "kaleidoscope";

interface OAuthState {
  nonce: string;
  verifier: string;
  returnTo: string;
  client?: string; // "ios" → hand the session to the app via APP_SCHEME redirect
}

function sessionUser(u: User): SessionUser {
  return { id: u.id, name: u.name, avatar: u.avatar_url, role: u.role, flagged: !!u.flagged };
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
  const client = c.req.query("client") === "ios" ? "ios" : undefined;

  const payload: OAuthState = { nonce, verifier, returnTo, client };
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
      avatar_url: null,
    });

    // Cache Google's avatar server-side and store our own same-origin path
    // (the raw googleusercontent.com URL would be blocked by our img-src CSP).
    // Best-effort: wrapped so a cache/DB hiccup here can never block login.
    try {
      let avatarPath: string | null = null;
      if (claims.picture && (await cacheRemoteAvatar(c.env, user.id, claims.picture))) {
        avatarPath = `/api/users/${user.id}/avatar`;
      }
      await setUserAvatar(c.env, user.id, avatarPath);
    } catch {
      /* avatar is best-effort; never block login */
    }

    const { id, csrf } = await createSession(c.env, user.id);

    // Native clients can't receive the httpOnly cookie — hand the session to the
    // app via its custom scheme. Token/csrf go in the URL *fragment* (never sent
    // to a server, kept out of referrer logs), not the query string.
    if (stored.client === "ios") {
      const frag = `token=${encodeURIComponent(id)}&csrf=${encodeURIComponent(csrf)}`;
      return c.redirect(`${APP_SCHEME}://auth-callback#${frag}`, 302);
    }

    writeSessionCookie(c, id);
    return c.redirect(`${home}${stored.returnTo}`, 302);
  } catch {
    return c.redirect(`${home}/?auth_error=verify`, 302);
  }
});

// Sign in with Apple (native). The app does the Apple auth and posts us the
// identity token + the raw nonce it committed to; we verify against Apple's JWKS
// and mint a session, returned as JSON (no cookie — native uses Bearer).
auth.post("/apple", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    identityToken?: string;
    rawNonce?: string;
    name?: string;
    email?: string;
  };
  if (!body.identityToken || !body.rawNonce) {
    return c.json({ error: "missing_token" }, 400);
  }

  let identity;
  try {
    identity = await verifyAppleIdentityToken(c.env, body.identityToken, body.rawNonce);
  } catch {
    return c.json({ error: "apple_verify_failed" }, 401);
  }

  // Only the token's OWN verified email may drive account linking or backfill —
  // never a client-supplied value. Otherwise a caller could link their Apple id
  // onto a victim's account by posting the victim's email with a token that has
  // no email claim. body.email is trusted only to seed a brand-new account's
  // display email on first sign-in (no victim exists to hijack).
  const linkEmail = identity.email_verified ? (identity.email ?? null) : null;
  const name = body.name ?? null;

  // Resolve: by apple_sub → by verified email (link to existing user) → create.
  let user = await getUserByAppleSub(c.env, identity.sub);
  if (user) {
    // Returning user: refresh last_seen, backfill only from the verified token.
    user = await upsertAppleUser(c.env, { apple_sub: identity.sub, email: linkEmail, name });
  } else {
    const existingByEmail = linkEmail ? await getUserByEmail(c.env, linkEmail) : null;
    if (existingByEmail) {
      user = await linkAppleToUser(c.env, existingByEmail.id, identity.sub, { email: linkEmail, name });
    } else {
      // Brand-new account — safe to seed display email from client input here.
      const createEmail = identity.email ?? body.email ?? null;
      user = await upsertAppleUser(c.env, { apple_sub: identity.sub, email: createEmail, name });
    }
  }

  const { id, csrf } = await createSession(c.env, user.id);
  return c.json({ token: id, csrf, user: sessionUser(user) });
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
