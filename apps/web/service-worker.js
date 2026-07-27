const CACHE = 'nusa-pos-shell-v61';
const SHELL = ['/', '/styles.css?v=61', '/app.js?v=61', '/vendor/zxing-browser.min.js', '/auth-store.mjs', '/date.mjs', '/pricing.mjs', '/receipt.mjs', '/escpos-printer.mjs', '/offline-store.mjs', '/pos-units.mjs', '/payment-keypad.mjs', '/manifest.webmanifest', '/icon-192.svg', '/icon-512.svg'];
self.addEventListener('install', (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', (event) => event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || event.request.url.includes('/api/')) return;
  event.respondWith(fetch(event.request).then((response) => {
    if (response.ok) {
      const copy = response.clone();
      event.waitUntil(caches.open(CACHE).then((cache) => cache.put(event.request, copy)));
    }
    return response;
  }).catch(async () => (await caches.match(event.request)) ?? (event.request.mode === 'navigate' ? caches.match('/') : Response.error())));
});
