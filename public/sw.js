const CACHE = 'finance-v4';
const SHELL = ['/', '/index.html', '/app-core.js', '/app-views.js', '/app-features.js', '/app-extra.js', '/app-boot.js', '/styles.css', '/icon.svg', '/manifest.webmanifest'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/') || e.request.method !== 'GET') return; // always live for data
  // Network-first for the app shell: a code/style change shows up on the next
  // load with no hard-refresh. Fall back to cache only when offline. (The old
  // cache-first strategy froze the UI on whatever was cached first — every
  // front-end edit then needed a manual cache-version bump to appear.)
  e.respondWith(
    fetch(e.request)
      .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('/index.html')))
  );
});
