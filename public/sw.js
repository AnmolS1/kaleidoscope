// Service worker — offline drawing. The app shell + hashed assets are cached so
// the studio loads and draws offline; saves/gallery (network) fail gracefully.
const CACHE = "kld-v1";
const SHELL = ["/", "/index.html", "/manifest.webmanifest", "/favicon.svg"];

/** Must match SKIP_WAITING in src/client/swUpdate.ts. */
const SKIP_WAITING = "kld-skip-waiting";

self.addEventListener("install", (e) => {
  // Deliberately NO `skipWaiting()` here. An unconditional skip swaps the code
  // out from under a page that is still running the old bundle — mid-save,
  // mid-stroke — with no reload to resynchronise it. So a new worker installs
  // and WAITS; the page notices, offers "Update available", and only then sends
  // the message below. (On a first-ever install there is nothing to wait behind,
  // so that visit still activates immediately.)
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
});

// The other half of the prompt: the page asks, and only then do we take over.
self.addEventListener("message", (e) => {
  if (e.data && e.data.type === SKIP_WAITING) self.skipWaiting();
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
