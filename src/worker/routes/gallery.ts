import { Hono } from "hono";
import type { AppEnv } from "../middleware";
import { requireAuth } from "../middleware";
import { listPublic, listByUser, randomPublic, encodeCursor } from "../lib/db";
import { serveAvatar } from "../lib/r2";

export const gallery = new Hono<AppEnv>();

const PAGE = 24;

// Public: a user's cached avatar, served same-origin (CSP img-src 'self').
// 404 when none stored — the client falls back to initials.
gallery.get("/users/:id/avatar", async (c) => {
  return (await serveAvatar(c.env, c.req.param("id"))) ?? c.body(null, 404);
});

// Public wall, newest first, keyset paginated.
gallery.get("/gallery", async (c) => {
  const cursor = c.req.query("cursor") ?? null;
  const items = await listPublic(c.env, { cursor, limit: PAGE + 1 });
  const hasMore = items.length > PAGE;
  const page = items.slice(0, PAGE);
  const nextCursor = hasMore ? encodeCursor(page[page.length - 1]) : null;

  return c.json({
    items: page.map((a) => ({
      id: a.id,
      title: a.title,
      author: { name: a.author_name, avatar: a.author_avatar },
      thumb: `/api/artworks/${a.id}/thumb`,
      likes: a.likes,
      createdAt: a.created_at,
    })),
    nextCursor,
  });
});

// Public: a random batch of public pieces for the iOS home-screen widget. No auth.
// The widget fetches K at once and pre-bakes a rotating timeline from them, so the
// *selection* must never be edge-cached (no-store); the images it points at keep their
// own immutable cache. URLs are absolute so the widget can render them straight off.
gallery.get("/gallery/random", async (c) => {
  const raw = parseInt(c.req.query("count") ?? "", 10);
  const count = Math.min(50, Math.max(1, Number.isNaN(raw) ? 12 : raw));
  const base = c.env.PUBLIC_BASE_URL;
  const items = (await randomPublic(c.env, count)).map((a) => ({
    id: a.id,
    title: a.title,
    author: a.author_name,
    imageUrl: `${base}/api/artworks/${a.id}/image`,
    permalink: `${base}/p/${a.id}`,
  }));
  c.header("Cache-Control", "no-store");
  return c.json({ items });
});

// Bonus no-code fallback: 302 to one random public image (also un-cached selection).
gallery.get("/gallery/random/image", async (c) => {
  const [art] = await randomPublic(c.env, 1);
  c.header("Cache-Control", "no-store");
  if (!art) return c.json({ error: "not_found" }, 404);
  return c.redirect(`${c.env.PUBLIC_BASE_URL}/api/artworks/${art.id}/image`, 302);
});

// The signed-in caller's own pieces (all visibilities).
gallery.get("/users/me/artworks", requireAuth, async (c) => {
  const user = c.get("user")!;
  const cursor = c.req.query("cursor") ?? null;
  const items = await listByUser(c.env, user.id, { cursor, limit: PAGE + 1 });
  const hasMore = items.length > PAGE;
  const page = items.slice(0, PAGE);
  const nextCursor = hasMore ? encodeCursor(page[page.length - 1]) : null;

  return c.json({
    items: page.map((a) => ({
      id: a.id,
      title: a.title,
      visibility: a.visibility,
      thumb: `/api/artworks/${a.id}/thumb`,
      likes: a.likes,
      createdAt: a.created_at,
    })),
    nextCursor,
  });
});
