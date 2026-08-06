const CACHE = 'nusa-pos-shell-v203';
// Only cache the critical shell during an update. Large spreadsheet/scanner
// assets are cached by the fetch handler when used, so an update cannot
// compete with login and catalog recovery on a shop device.
const SHELL = ['/', '/styles.css?v=203', '/app.js?v=203', '/manifest.webmanifest'];
const RUNTIME_SHELL = ['/vendor/xlsx.full.min.js', '/vendor/zxing-browser.min.js', '/auth-store.mjs', '/date.mjs', '/pricing.mjs', '/receipt.mjs', '/escpos-printer.mjs', '/offline-store.mjs', '/pos-units.mjs', '/payment-keypad.mjs', '/product-workbook.mjs', '/product-labels.mjs', '/kaspin-import.mjs', '/variant-suggestions.mjs', '/icon-192.svg', '/icon-512.svg'];
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

self.addEventListener('push',(event)=>{
  let payload={};
  try{payload=event.data?.json?.()??{};}catch{payload={title:'Kasir Nusa POS',body:event.data?.text?.()??'Ada kabar penting baru.'};}
  const title=String(payload.title??'Kasir Nusa POS');
  event.waitUntil(self.registration.showNotification(title,{
    body:String(payload.body??'Ada kabar penting baru.'),icon:payload.icon??'/icon-192.svg',badge:payload.badge??'/icon-192.svg',
    tag:payload.tag??'nusa-update',data:payload.data??{url:'/'},timestamp:Number(payload.timestamp??Date.now())
  }));
});

self.addEventListener('notificationclick',(event)=>{
  event.notification.close();
  const targetUrl=new URL(event.notification.data?.url??'/',self.location.origin).href;
  event.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(async(clients)=>{
    const existing=clients.find((client)=>new URL(client.url).origin===self.location.origin);
    if(existing){await existing.focus();existing.postMessage({type:'OPEN_NOTIFICATION',url:targetUrl,page:event.notification.data?.page??''});return;}
    await self.clients.openWindow(targetUrl);
  }));
});
