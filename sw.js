// Shell-only service worker. Audio streams straight from GitHub Releases
// (cross-origin) and is deliberately never intercepted or cached here —
// intercepting media range requests breaks seeking on some browsers.
const CACHE = 'ab-shell-v6';
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png',
  'privacy.html', 'legal.html', 'accessibility.html'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // media streams (and any ranged request) must reach the network untouched —
  // intercepting them breaks seeking, especially on Safari
  if (url.pathname.includes('/media/') || e.request.headers.has('range')) return;
  // network-first so updates land; cache fallback for offline shell
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.status === 200) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, {ignoreSearch: url.pathname.endsWith('/') || url.pathname.endsWith('index.html')}))
  );
});
