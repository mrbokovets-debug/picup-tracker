const CACHE_NAME = 'pickup-tracker-v5';
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

// ---------- IndexedDB 'pickup-push': общая «записка» между приложением и service worker ----------
function idbOpen() {
  return new Promise((resolve, reject) => {
    const rq = indexedDB.open('pickup-push', 1);
    rq.onupgradeneeded = () => { rq.result.createObjectStore('cfg'); };
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
}
async function idbGet(key) {
  try {
    const db = await idbOpen();
    return await new Promise((resolve) => {
      const g = db.transaction('cfg', 'readonly').objectStore('cfg').get(key);
      g.onsuccess = () => { db.close(); resolve(g.result === undefined ? null : g.result); };
      g.onerror = () => { db.close(); resolve(null); };
    });
  } catch (e) { return null; }
}
// добавляем запись в массив одной транзакцией (чтобы не потерять параллельную запись приложения)
async function idbPushItem(key, item) {
  try {
    const db = await idbOpen();
    await new Promise((resolve) => {
      const tx = db.transaction('cfg', 'readwrite');
      const store = tx.objectStore('cfg');
      const g = store.get(key);
      g.onsuccess = () => {
        const list = Array.isArray(g.result) ? g.result : [];
        list.push(item);
        store.put(list, key);
      };
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = tx.onabort = () => { db.close(); resolve(); };
    });
  } catch (e) {}
}

// Нажали кнопку «Стоп» / «Забрал заказ» прямо в уведомлении: приложение открывать не нужно.
// Записываем остановку (с настоящим временем нажатия), снимаем напоминание на сервере,
// а приложение применит остановку, когда его откроют (или сразу, если оно уже открыто).
async function handleStopAction(d) {
  const ts = Date.now();
  await idbPushItem('pendingStops', { kind: d.kind, id: String(d.id), ts });
  const state = await idbGet('state');
  try {
    const sub = await self.registration.pushManager.getSubscription();
    if (sub && state && state.server) {
      await fetch(String(state.server).replace(/\/+$/, '') + '/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: sub.endpoint, kind: d.kind, id: String(d.id) })
      });
    }
  } catch (e) { /* не страшно: приложение отменит при открытии */ }
  const clientsArr = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  clientsArr.forEach((c) => { try { c.postMessage({ type: 'apply-stops' }); } catch (e) {} });

  // короткое подтверждение, чтобы было видно, что остановилось
  const tpl = state && state.texts && state.texts.stopped;
  if (tpl) {
    const min = d.startTs ? Math.max(1, Math.round((ts - d.startTs) / 60000)) : '';
    await self.registration.showNotification(String(tpl).replace(/\{min\}/g, String(min)), {
      icon: 'icon-192.png', badge: 'icon-192.png', tag: 'pickup-stopped', silent: true
    });
    await new Promise((r) => setTimeout(r, 4000));
    const shown = await self.registration.getNotifications({ tag: 'pickup-stopped' });
    shown.forEach((n) => n.close());
  }
}

// Тап по уведомлению ("забыл нажать Стоп?"): кнопка «Стоп» - останавливаем в фоне;
// тап по самому уведомлению - открываем/фокусируем приложение
self.addEventListener('notificationclick', (event) => {
  const d = event.notification.data || {};
  event.notification.close();
  if (event.action === 'stop' && d.kind && d.id) {
    event.waitUntil(handleStopAction(d));
    return;
  }
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
self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    const state = await idbGet('state');
    const stops = (await idbGet('pendingStops')) || [];
    const stopped = new Set(stops.map((x) => x.kind + ':' + x.id));
    const texts = (state && state.texts) || {};
    // идущие таймеры, которые уже остановили кнопкой в уведомлении, не напоминаем
    const timers = ((state && state.timers) || []).filter((x) => !stopped.has(x.kind + ':' + x.id));
    // по одному уведомлению на каждый вид таймера (ожидание на точке / доезд), берём самый давний
    const kinds = ['arrival', 'route'].filter((k) => timers.some((x) => x.kind === k));
    const fill = (str, min) => String(str || '').replace(/\{min\}/g, String(min));
    const base = { icon: 'icon-192.png', badge: 'icon-192.png', renotify: true, requireInteraction: true, vibrate: [200, 100, 200, 100, 400] };

    if (!kinds.length) {
      // таймеров уже нет (остановили, пока пуш летел). iPhone требует показать уведомление на КАЖДЫЙ пуш,
      // поэтому показываем нейтральное и сразу убираем
      await self.registration.showNotification((texts.route && texts.route.title) || 'PickupMap', { icon: base.icon, badge: base.badge, tag: 'pickup-idle', silent: true });
      const idle = await self.registration.getNotifications({ tag: 'pickup-idle' });
      idle.forEach((n) => n.close());
      return;
    }
    for (const kind of kinds) {
      const pick = timers.filter((x) => x.kind === kind).sort((a, b) => a.startTs - b.startTs)[0];
      const tx = texts[kind] || {
        title: kind === 'arrival' ? '⏱ Не забыл забрать заказ?' : '🚴 Не забыл нажать «Стоп»?',
        body: 'Проверь таймер в приложении PickupMap.'
      };
      const min = Math.max(1, Math.round((Date.now() - pick.startTs) / 60000));
      const opts = Object.assign({}, base, {
        body: fill(tx.body, min),
        tag: 'pickup-' + kind,
        data: { kind, id: String(pick.id), startTs: pick.startTs }
      });
      if (tx.action) opts.actions = [{ action: 'stop', title: tx.action }];
      await self.registration.showNotification(fill(tx.title, min), opts);
    }
  })());
});
