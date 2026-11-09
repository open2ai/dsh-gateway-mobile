/*
 * Shell cache for the gateway PWA.
 *
 * The cache name and precache list are derived from `/mobile/assets/build.json`
 * (written by scripts/build-web.mjs) so every deploy gets a fresh cache and the
 * precached asset URLs carry the same `?v=<hash>` the gateway rewrites into the
 * HTML. API and WebSocket traffic is never cached.
 */
const CACHE_PREFIX = 'dsh-gateway-mobile-'
const FALLBACK_CACHE = `${CACHE_PREFIX}fallback-v1`
const MANIFEST_URL = '/mobile/assets/build.json'
const FALLBACK_SHELL = [
  '/mobile/',
  '/mobile/assets/app.css',
  '/mobile/assets/common.js',
  '/mobile/assets/app.js',
  '/mobile/assets/shell.js',
  '/mobile/assets/diag.js',
  '/mobile/assets/pair.css',
  '/mobile/assets/pair.js',
  '/mobile/assets/devices.js',
  '/mobile/assets/oauth.js',
  '/mobile/icon.svg',
  '/mobile/manifest.webmanifest',
]

let cacheName = FALLBACK_CACHE

/** Read the build manifest; resolves null when it is unavailable or invalid. */
async function readManifest() {
  try {
    const response = await fetch(MANIFEST_URL, { cache: 'no-store' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const manifest = await response.json()
    const assets = manifest && typeof manifest.assets === 'object' ? manifest.assets : null
    if (!assets) throw new Error('missing assets map')
    const entries = Object.entries(assets).filter(([name, hash]) => typeof name === 'string' && typeof hash === 'string')
    if (entries.length === 0) throw new Error('empty assets map')
    return {
      version: String(manifest.version || 'dev'),
      shell: [
        '/mobile/',
        ...entries.map(([name, hash]) => `/mobile/assets/${name}?v=${hash}`),
        '/mobile/icon.svg',
        '/mobile/manifest.webmanifest',
      ],
    }
  } catch {
    return null
  }
}

async function precache(cache, urls) {
  // addAll rejects the whole batch when one URL is missing; add entries
  // individually so a single stale asset cannot blank the PWA shell.
  await Promise.all(urls.map((url) => cache.add(url).catch(() => undefined)))
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const manifest = await readManifest()
    if (manifest) cacheName = `${CACHE_PREFIX}${manifest.version}`
    const cache = await caches.open(cacheName)
    await precache(cache, manifest ? manifest.shell : FALLBACK_SHELL)
    await self.skipWaiting()
  })())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const manifest = await readManifest()
    if (manifest) cacheName = `${CACHE_PREFIX}${manifest.version}`
    const keys = await caches.keys()
    // With a manifest we know the current cache and can drop every other one;
    // without it only drop legacy names, never a precache we cannot identify.
    const stale = manifest
      ? keys.filter((key) => key !== cacheName)
      : keys.filter((key) => !key.startsWith(CACHE_PREFIX))
    await Promise.all(stale.map((key) => caches.delete(key)))
    await self.clients.claim()
  })())
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
      caches.open(cacheName).then((cache) => cache.put(event.request, copy)).catch(() => {})
      return response
    })),
  )
})
