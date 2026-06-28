import { Hono } from "hono";
import type { AppEnv } from "../middleware";
import { requireAuth } from "../middleware";
import { listPublic, listByUser, encodeCursor } from "../lib/db";

export const gallery = new Hono<AppEnv>();

const PAGE = 24;

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
