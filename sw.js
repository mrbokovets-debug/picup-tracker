const CACHE_NAME = 'pickup-tracker-v42';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-192.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png',
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
  // POST и прочее не трогаем - пусть идут напрямую
  if (event.request.method !== 'GET') return;
  // облако (Supabase) не кэшируем: там личные данные, и они должны быть всегда свежими
  if (event.request.url.includes('.supabase.co')) return;
  // плитки любого провайдера карты: адрес вида .../{z}/{x}/{y}.png (иначе после смены провайдера они бы кэшировались как файлы приложения)
  const isMapTile = event.request.url.includes('tile.openstreetmap.org') || /\/\d{1,2}\/\d+\/\d+(@2x)?\.(png|jpe?g|webp)(\?|$)/.test(event.request.url);
  if (isMapTile) {
    // карту без сети всё равно не подгрузить, просто пробуем сеть и падаем тихо
    event.respondWith(fetch(event.request).catch(() => new Response('', { status: 504 })));
    return;
  }

  // Network-first: всегда пытаемся взять свежую версию из сети,
  // а кэш используем только как запасной вариант, если сети нет (офлайн).
  // cache:'no-cache' - всегда сверяемся с сервером (GitHub Pages иначе отдаёт файл из HTTP-кэша до 10 минут, и свежая версия не подхватывается)
  const sameOrigin = event.request.url.startsWith(self.location.origin);
  event.respondWith(
    (sameOrigin ? fetch(event.request, { cache: 'no-cache' }) : fetch(event.request))
      .then((resp) => {
        const respClone = resp.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, respClone));
        return resp;
      })
      .catch(() => caches.match(event.request))
  );
});

// Уведомлений и push в приложении больше нет. Оставляем только тап по старому уведомлению,
// если оно ещё висит в шторке: открываем приложение.
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
