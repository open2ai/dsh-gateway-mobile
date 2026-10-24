/* Minimal shell cache for the gateway PWA. API and WebSocket traffic is never cached. */
const CACHE = 'dsh-gateway-mobile-v12'
const SHELL = [
  '/mobile/',
  '/mobile/assets/app.css?v=10',
  '/mobile/assets/common.js?v=7',
  '/mobile/assets/app.js?v=7',
  '/mobile/assets/shell.js?v=7',
  '/mobile/assets/diag.js?v=7',
  '/mobile/assets/pair.css?v=10',
  '/mobile/assets/pair.js?v=8',
  '/mobile/assets/devices.js?v=7',
  '/mobile/assets/oauth.js?v=7',
  '/mobile/icon.svg',
  '/mobile/manifest.webmanifest',
]

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (event.request.method !== 'GET' || url.pathname.startsWith('/mobile/api/') || url.pathname.startsWith('/api/')) return
  // Never serve a cached HTML document: the admin console changes often and a
  // stale document would keep pointing at old asset URLs.
  if (event.request.mode === 'navigate' || event.request.destination === 'document') return
  if (!url.pathname.startsWith('/mobile/')) return
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
      const copy = response.clone()
      caches.open(CACHE).then((cache) => cache.put(event.request, copy)).catch(() => {})
      return response
    })),
  )
})
