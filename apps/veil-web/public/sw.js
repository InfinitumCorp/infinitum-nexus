/* VEIL web app service worker: offline shell only. Downloads are never cached. */
const CACHE = "veil-shell-v13";
const SHELL = ["./", "index.html", "app.js", "search.html", "search.js", "lib/trackers.js", "firm-suite.js", "firm-suite.css", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.includes("/downloads/")) return;
  // Network first so updates show at once; fall back to the cached shell offline.
  e.respondWith(
    fetch(e.request, { cache: "no-cache" }) // revalidate, so new HTML never meets an old app.js
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("index.html"))),
  );
});
