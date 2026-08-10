/* Aspotï Service Worker v3 — background-audio-safe */
const CACHE = 'aspoti-v3';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;

  const url = e.request.url;

  // ── NEVER intercept audio streams or API calls ──
  // These must go directly to network; any SW interception can prevent
  // iOS from establishing/keeping its background audio session assertion.
  if (
    url.includes('pipedapi') ||
    url.includes('pipedapi.') ||
    url.includes('invidious') ||
    url.includes('yewtu.be') ||
    url.includes('googleapis.com') ||
    url.includes('videoplayback') ||
    url.includes('/api/v1/') ||
    url.includes('/streams/') ||
    url.includes('googlevideo.com') ||
    url.includes('ytimg.com')        // thumbnail images — let browser handle
  ) {
    // Passthrough: do NOT call e.respondWith() — browser handles natively.
    // This is critical: calling e.respondWith(fetch(e.request)) still goes
    // through the SW thread and can block/delay the media session on iOS.
    return;
  }

  // ── Cache-first for app shell assets only ──
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res && res.ok && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => {
        // Return cached version if network fails for shell assets
        return caches.match('./index.html');
      });
    })
  );
});
