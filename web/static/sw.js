// Offline support. Network first, so you always get the latest app and notes
// when the server is reachable; if it isn't (or takes too long), the last
// copy cached here is used. Writes are never cached: unsaved edits wait in
// the page's own storage and are saved when the server is back.
// Service workers only run on https:// (e.g. Tailscale) and localhost.

// The build (scripts/build.mjs) fills these in: a cache name per build, and
// every file of the app, including the parts loaded only on demand (IDE mode,
// code languages), so they also work offline.
const CACHE = "notes-app-__BUILD__";
const SHELL = ["/", "/app.js", "/style.css", "/manifest.webmanifest", "/icon.svg", "/icon-maskable.svg" /* __CHUNKS__ */];
const CACHED_API = ["/api/info", "/api/notes", "/api/note", "/api/status", "/api/backlinks", "/api/file"];
const NETWORK_TIMEOUT_MS = 4000;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) {
    if (CACHED_API.includes(url.pathname)) event.respondWith(networkFirst(req, req));
    return; // events, search, settings, history…: network only
  }
  // App files; any page URL falls back to the app shell.
  const key = req.mode === "navigate" ? new Request("/") : req;
  event.respondWith(networkFirst(req, key));
});

async function networkFirst(req, cacheKey) {
  const cache = await caches.open(CACHE);
  try {
    const res = await withTimeout(fetch(req), NETWORK_TIMEOUT_MS);
    if (res.ok) await cache.put(cacheKey, res.clone());
    return res;
  } catch {
    const hit = await cache.match(cacheKey);
    return hit ?? Response.error();
  }
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
