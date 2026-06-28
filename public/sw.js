// Service worker — offline drawing. The app shell + hashed assets are cached so
// the studio loads and draws offline; saves/gallery (network) fail gracefully.
const CACHE = "kld-v1";
const SHELL = ["/", "/index.html", "/manifest.webmanifest", "/favicon.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  // never cache API or OG — always hit the network
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/og/")) return;

  // navigations: network-first, fall back to the cached shell when offline
  if (e.request.mode === "navigate") {
    e.respondWith(fetch(e.request).catch(() => caches.match("/index.html")));
    return;
  }

  // static assets: cache-first, populate on miss
  if (url.origin === location.origin) {
    e.respondWith(
      caches.match(e.request).then(
        (hit) =>
          hit ||
          fetch(e.request).then((resp) => {
            if (resp.ok) {
              const copy = resp.clone();
              caches.open(CACHE).then((c) => c.put(e.request, copy));
            }
            return resp;
          }),
      ),
    );
  }
});
