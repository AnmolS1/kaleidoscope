import { Hono } from "hono";
import type { AppEnv } from "../middleware";
import { getArtworkWithAuthor, listPublicIds } from "../lib/db";

// Server-rendered OG tags for permalinks + a dynamic sitemap. /p/* is routed to
// the Worker (run_worker_first) so social scrapers — which don't run JS — get
// per-piece og:image/og:title injected into the static index.html via
// HTMLRewriter. Humans get the same shell and the SPA boots normally.
export const permalink = new Hono<AppEnv>();

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function indexHtml(c: { env: AppEnv["Bindings"]; req: { url: string } }): Promise<Response> {
  return c.env.ASSETS.fetch(new Request(new URL("/index.html", c.req.url)));
}

permalink.get("/p/:id", async (c) => {
  const id = c.req.param("id");
  const shell = await indexHtml(c);
  const art = id ? await getArtworkWithAuthor(c.env, id) : null;
  if (!art || art.visibility === "private") return shell;

  const base = c.env.PUBLIC_BASE_URL;
  const title = esc(`${art.title} — Kaleidoscope`);
  const desc = esc(
    `${art.title}${art.author_name ? ` by ${art.author_name}` : ""} — a ${art.segments}-fold kaleidoscope drawing.`,
  );
  const ogImage = `${base}/og/${art.id}`;
  const url = `${base}/p/${art.id}`;

  const setContent = (content: string) => ({
    element(el: { setAttribute(n: string, v: string): void }) {
      el.setAttribute("content", content);
    },
  });

  return new HTMLRewriter()
    .on("title", {
      element(el) {
        el.setInnerContent(title);
      },
    })
    .on('meta[name="description"]', setContent(desc))
    .on('meta[property="og:title"]', setContent(title))
    .on('meta[property="og:description"]', setContent(desc))
    .on('meta[property="og:url"]', setContent(url))
    .on('meta[property="og:image"]', setContent(ogImage))
    .transform(shell);
});

permalink.get("/sitemap.xml", async (c) => {
  const base = c.env.PUBLIC_BASE_URL;
  const ids = await listPublicIds(c.env, 5000);
  const urls = [
    `<url><loc>${base}/</loc></url>`,
    `<url><loc>${base}/gallery</loc></url>`,
    ...ids.map(
      (a) =>
        `<url><loc>${base}/p/${a.id}</loc><lastmod>${new Date(a.created_at).toISOString()}</lastmod></url>`,
    ),
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join("")}</urlset>`;
  return c.body(xml, 200, { "Content-Type": "application/xml", "Cache-Control": "public, max-age=3600" });
});
