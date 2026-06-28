import { Hono } from "hono";
import type { AppEnv } from "../middleware";
import { getArtwork } from "../lib/db";
import { keys, serveObject } from "../lib/r2";

// 1200x630-ish OG image per permalink. The client uploads a composed OG render
// (og/{id}.webp); fall back to the square image, then the default asset. Private
// pieces don't expose an OG image.
export const og = new Hono<AppEnv>();

og.get("/:id", async (c) => {
  const art = await getArtwork(c.env, c.req.param("id"));
  if (!art || art.visibility === "private") {
    return c.redirect(`${c.env.PUBLIC_BASE_URL}/og-default.png`, 302);
  }
  const res = (await serveObject(c.env, keys.og(art.id))) ?? (await serveObject(c.env, art.image_key));
  return res ?? c.redirect(`${c.env.PUBLIC_BASE_URL}/og-default.png`, 302);
});
