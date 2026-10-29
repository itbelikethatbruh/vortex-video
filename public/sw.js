/* Vortex Video service worker: makes the app installable, opens it offline, and shows call alerts.
   The page is always fetched fresh when online (network first), so a deploy shows up
   on the next load; calls, relays and media never go through here. */
const CACHE = 'vortex-shell-v3';
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put('/', copy)); }
      return r;
    }).catch(() => caches.match('/')));
    return;
  }
  if (url.pathname.startsWith('/icons/') || url.pathname === '/manifest.webmanifest') {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
  }
});

/* ---- call alerts: a friend's ring arrives as a Web Push (sent by /api/ring) ----
   { t: 'ring', id, from, name, room, tok, at }  → "Name is calling" with Answer / Decline
   { t: 'end', id, reason }                       → clears it ("Missed call" if nobody answered) */
self.addEventListener('push', (e) => {
  let d = null;
  try { d = e.data ? e.data.json() : null; } catch { d = null; }
  if (!d || typeof d.id !== 'string' || d.id.length > 20) return;
  e.waitUntil(onPush(d));
});

async function onPush(d) {
  const tag = 'ring-' + d.id;
  const name = String(d.name || 'A friend').slice(0, 40);
  if (d.t === 'ring') {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.some((w) => w.visibilityState === 'visible')) return;          // the open app rings by itself
    if (Date.now() - (+d.at || 0) > 60000) return missed(tag, name);        // arrived too late to answer
    return self.registration.showNotification(`${name} is calling`, {
      body: 'Vortex video call · tap to see them and answer',
      tag, renotify: true, requireInteraction: true,
      icon: '/icons/icon-192.png',
      // the ringtone's rhythm (Android browsers; the Vortex app's call channel rings and buzzes on its own)
      vibrate: [80, 40, 80, 40, 80, 40, 320, 220, 80, 40, 80, 40, 80, 40, 450, 1250, 80, 40, 80, 40, 80, 40, 320, 220, 80, 40, 80, 40, 80, 40, 450],
      actions: [{ action: 'answer', title: 'Answer' }, { action: 'decline', title: 'Decline' }],
      data: d,
    });
  }
  if (d.t === 'end') {
    const open = await self.registration.getNotifications({ tag });
    for (const n of open) n.close();
    if (d.reason === 'missed' && open.length) return missed(tag, name);
  }
}

function missed(tag, name) {
  return self.registration.showNotification(`Missed call from ${name}`, {
    body: 'Open Vortex to call back', tag, silent: true, icon: '/icons/icon-192.png', data: { t: 'missed' },
  });
}

self.addEventListener('notificationclick', (e) => {
  const n = e.notification, d = n.data || {};
  n.close();
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find((w) => new URL(w.url).origin === location.origin);
    if (d.t !== 'ring') { if (win) return win.focus(); return self.clients.openWindow('/'); }
    if (e.action === 'decline') {
      // only an open Vortex window is signed in and can tell the caller; otherwise their ring just times out
      if (win) win.postMessage({ type: 'vortex-ring-decline', d });
      return;
    }
    const go = e.action === 'answer';
    if (win) {
      win.postMessage({ type: 'vortex-ring', d, go });
      return win.focus();
    }
    const q = new URLSearchParams({ ring: d.id, from: d.from || '', room: d.room || '', inv: d.tok || '', n: d.name || '', at: String(d.at || 0) });
    if (go) q.set('go', '1');
    return self.clients.openWindow('/?' + q);
  })());
});
