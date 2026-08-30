// sw.js — offline app-shell service worker.
//
// Strategy:
//   * Precache the known app shell on install (best-effort; a missing file
//     never blocks activation).
//   * Same-origin navigations: network-first, falling back to the cached
//     shell so the app opens offline.
//   * Same-origin assets (JS/CSS/icons): stale-while-revalidate.
//   * Supabase, api.github.com, and any other cross-origin request: never
//     cached, so tokens and fresh remote data are never stored here.
//
// All paths are repository-relative so this works under a GitHub Pages subpath.

const CACHE = "pickleball-v8";

const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./css/styles.css",
  "./js/app.js",
  "./js/auth.js",
  "./js/config.js",
  "./js/supabase.js",
  "./js/schema.js",
  "./js/state.js",
  "./js/storage.js",
  "./js/rng.js",
  "./js/samples.js",
  "./js/scheduler.js",
  "./js/scoring.js",
  "./js/bookings.js",
  "./js/stats.js",
  "./js/portability.js",
  "./js/github.js",
  "./js/ui/dom.js",
  "./js/ui/feedback.js",
  "./js/ui/login.js",
  "./js/ui/roster.js",
  "./js/ui/session.js",
  "./js/ui/schedule.js",
  "./js/ui/constraints.js",
  "./js/ui/stats.js",
  "./js/ui/more.js",
  "./js/ui/display.js",
  "./assets/icons/icon.svg",
  "./assets/icons/icon-192.png",
  "./assets/icons/icon-512.png",
  "./assets/icons/icon-maskable.png",
  "./data/sample-players.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Best-effort: a single 404 (e.g. an icon not yet added) must not abort.
      await Promise.allSettled(APP_SHELL.map((url) => cache.add(url)));
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Never touch the GitHub API (or any cross-origin request) with the cache.
  if (url.origin !== self.location.origin) return;

  // Navigations: network-first, fall back to cached shell.
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          const cache = await caches.open(CACHE);
          cache.put("./index.html", fresh.clone());
          return fresh;
        } catch {
          const cached = await caches.match("./index.html");
          return cached || Response.error();
        }
      })(),
    );
    return;
  }

  // Same-origin assets: stale-while-revalidate.
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(request);
      const network = fetch(request)
        .then((resp) => {
          if (resp && resp.ok) cache.put(request, resp.clone());
          return resp;
        })
        .catch(() => null);
      return cached || (await network) || Response.error();
    })(),
  );
});
