/* Bump CACHE on every deploy — a stale shell is the classic PWA support call. */
const CACHE = 'manager-accountability-v3-input-styling';

const SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'brand.js',
  'cloud.js',
  'data/checklists.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never cache the ledger — an offline read must come from the app's own cache
  // layer, not a stale HTTP response that looks authoritative.
  if (url.pathname.startsWith('/api/') || url.hostname.endsWith('workers.dev')) return;

  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(request).then((cached) => {
        const network = fetch(request)
          .then((response) => {
            if (response && response.ok) {
              caches.open(CACHE).then((cache) => cache.put(request, response.clone()));
            }
            return response;
          })
          .catch(() => cached);
        return cached || network;
      }),
    );
  }
});
