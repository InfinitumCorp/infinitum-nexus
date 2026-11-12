/*
 * Cumulus://Mail service worker. Caches only the app shell so the installed app opens fast and
 * shows a friendly screen offline. Mail itself (anything under /api/) is never cached: it is
 * private and always comes from the server.
 */
const SHELL = "cmail-shell-v4";
const FILES = ["/", "/app.css", "/app.js", "/id/bar.js", "/search.js", "/i18n.css", "/i18n.js", "/i18n-start.js", "/i18n-catalogs.js", "/icon.svg", "/icon-192.png", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/") || url.pathname === "/cumulus-config.js") return;
  // Network first, so a deploy shows up at once; the cached shell is the offline fallback.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok && FILES.includes(url.pathname)) {
          const copy = response.clone();
          caches.open(SHELL).then((cache) => cache.put(url.pathname, copy));
        }
        return response;
      })
      .catch(() => caches.match(url.pathname).then((hit) => hit || caches.match("/"))),
  );
});
