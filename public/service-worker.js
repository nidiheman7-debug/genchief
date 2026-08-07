// Omega Prep — service worker
// Caches the app shell so the site can install as a PWA and open even with
// a flaky connection. API calls (quiz generation, auth) always go to the
// network — we never want to serve a stale AI response from cache.

const CACHE_NAME = "omega-prep-shell-v1";
const SHELL_ASSETS = [
  "/",
  "/index.html",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Never cache API calls — always hit the network so quiz generation,
  // sign-in, and any dynamic data stay fresh.
  if (request.url.includes("/api/")) {
    return; // let the browser handle it normally
  }

  // Cache-first for the app shell, falling back to network, and updating
  // the cache in the background when a fresh copy comes back.
  event.respondWith(
    caches.match(request).then((cached) => {
      const networkFetch = fetch(request)
        .then((response) => {
          if (response && response.status === 200 && request.method === "GET") {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => cached); // offline — fall back to whatever we have cached

      return cached || networkFetch;
    })
  );
});
