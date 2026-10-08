const CACHE_NAME = 'pickup-tracker-v4';
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
  // POST и прочее (например запросы к push-серверу) не трогаем - пусть идут напрямую
  if (event.request.method !== 'GET') return;
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


// ---------- Пуш с сервера: «не забыл нажать Стоп?» ----------
// Сервер присылает пуш БЕЗ текста. Тексты (на языке пользователя) и список идущих таймеров приложение
// заранее кладёт в IndexedDB 'pickup-push' - отсюда и берём. Обязательно показываем уведомление на
// КАЖДЫЙ пуш (iPhone иначе отключает подписку).
function readPushState() {
  return new Promise((resolve) => {
    try {
      const rq = indexedDB.open('pickup-push', 1);
      rq.onupgradeneeded = () => { rq.result.createObjectStore('cfg'); };
      rq.onerror = () => resolve(null);
      rq.onsuccess = () => {
        try {
          const db = rq.result;
          const get = db.transaction('cfg', 'readonly').objectStore('cfg').get('state');
          get.onsuccess = () => { db.close(); resolve(get.result || null); };
          get.onerror = () => { db.close(); resolve(null); };
        } catch (e) { resolve(null); }
      };
    } catch (e) { resolve(null); }
  });
}

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    const state = await readPushState();
    const timers = (state && state.timers) || [];
    const texts = (state && state.texts) || {};
    // самый давний из идущих таймеров; сначала «ожидание на точке»
    const pick = timers.find((x) => x.kind === 'arrival') || timers[0];
    const kind = pick ? pick.kind : 'route';
    const tx = texts[kind] || {
      title: kind === 'arrival' ? '⏱ Не забыл забрать заказ?' : '🚴 Не забыл нажать «Стоп»?',
      body: 'Проверь таймер в приложении PickupMap.'
    };
    const min = pick ? Math.max(1, Math.round((Date.now() - pick.startTs) / 60000)) : '';
    const fill = (s) => String(s || '').replace(/\{min\}/g, String(min));
    await self.registration.showNotification(fill(tx.title), {
      body: fill(tx.body),
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      tag: 'pickup-' + kind,
      renotify: true,
      requireInteraction: true,
      vibrate: [200, 100, 200, 100, 400]
    });
  })());
});
