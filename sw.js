const CACHE_NAME = 'pickup-tracker-v3';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './splash-bg.jpg',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js'
];
 
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});
 
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});
 
self.addEventListener('fetch', (event) => {
  const isMapTile = event.request.url.includes('tile.openstreetmap.org');
  if (isMapTile) {
    // карту без сети всё равно не подгрузить, просто пробуем сеть и падаем тихо
    event.respondWith(fetch(event.request).catch(() => new Response('', { status: 504 })));
    return;
  }
 
  // Network-first: всегда пытаемся взять свежую версию из сети,
  // а кэш используем только как запасной вариант, если сети нет (офлайн).
  event.respondWith(
    fetch(event.request)
      .then((resp) => {
        const respClone = resp.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, respClone));
        return resp;
      })
      .catch(() => caches.match(event.request))
  );
});
 
// Тап по пуш-уведомлению из шторки ("забыл нажать Стоп?") - закрываем уведомление
// и открываем/фокусируем уже открытую вкладку приложения вместо новой
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientsArr) => {
      const existing = clientsArr.find((c) => 'focus' in c);
      if (existing) return existing.focus();
      return self.clients.openWindow('./index.html');
    })
  );
});
 
 
