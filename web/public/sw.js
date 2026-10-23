// Keeps Mitzi's app shell available so it opens quickly from the home screen. API calls, media, share pages
// and webhooks always go to the network.
const CACHE = 'mitzi-shell-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin || /^\/(api|media|s|hooks)\//.test(url.pathname)) return;
  // Built assets never change (their names do): cache first.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(event.request).then(
        (hit) =>
          hit ||
          fetch(event.request).then((res) => {
            if (res.ok) caches.open(CACHE).then((c) => c.put(event.request, res.clone()));
            return res;
          }),
      ),
    );
    return;
  }
  // Pages: the network first, the last copy when offline.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          if (res.ok) caches.open(CACHE).then((c) => c.put('/', res.clone()));
          return res;
        })
        .catch(() => caches.match('/')),
    );
  }
});
