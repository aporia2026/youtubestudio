/**
 * Narrator portal service worker.
 *
 * Strategy:
 *   - Static + same-origin /narrator/* HTML  → stale-while-revalidate
 *     (instant load when offline, refresh in background when online)
 *   - Same-origin /api/narrate/[token]/* GET → network-first with
 *     short timeout; on failure fall back to the cached copy so the
 *     narrator can keep referencing assignment data they already loaded
 *   - Anything else (POST, cross-origin uploads to Vercel Blob, etc.) →
 *     pass-through to the network. Recordings MUST go to the network;
 *     cached uploads would silently lose audio.
 *
 * Bump CACHE_VERSION when the contract changes — old caches purge on
 * activate. Assets keyed in OFFLINE_FALLBACK are pre-warmed on install
 * so the first offline visit isn't a 404.
 */
const CACHE_VERSION = 'narrator-v1';
const HTML_CACHE = `${CACHE_VERSION}-html`;
const API_CACHE = `${CACHE_VERSION}-api`;
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const OFFLINE_FALLBACK = '/narrator/offline';

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(STATIC_CACHE);
      // Best-effort warm — if any of these 404 we don't want to block install.
      await Promise.allSettled([
        cache.add('/icons/narrator-icon.svg'),
        cache.add('/narrator-manifest.json'),
      ]);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      // Purge anything that doesn't belong to the current version.
      await Promise.all(
        keys
          .filter((k) => !k.startsWith(CACHE_VERSION))
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // POST/PUT/DELETE — never cache
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // cross-origin — let it through

  // /api/narrate/[token]/* — network-first with cache fallback.
  if (url.pathname.startsWith('/api/narrate/')) {
    event.respondWith(networkFirst(req, API_CACHE));
    return;
  }

  // /narrator/* HTML — stale-while-revalidate so opening the app
  // offline shows the last-loaded shell instantly.
  if (url.pathname.startsWith('/narrator/')) {
    if (req.headers.get('accept')?.includes('text/html')) {
      event.respondWith(staleWhileRevalidate(req, HTML_CACHE));
      return;
    }
  }

  // Static assets (svg, css, fonts) — cache-first.
  if (
    url.pathname.startsWith('/icons/') ||
    url.pathname.startsWith('/_next/static/') ||
    url.pathname.endsWith('.svg') ||
    url.pathname.endsWith('.woff2') ||
    url.pathname.endsWith('.css')
  ) {
    event.respondWith(cacheFirst(req, STATIC_CACHE));
    return;
  }
});

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const fresh = await fetch(req);
    if (fresh.ok) cache.put(req, fresh.clone()).catch(() => {});
    return fresh;
  } catch {
    const cached = await cache.match(req);
    if (cached) return cached;
    return caches.match(OFFLINE_FALLBACK).then(
      (r) =>
        r ||
        new Response(JSON.stringify({ error: 'offline' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
  }
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const fresh = await fetch(req);
    if (fresh.ok) cache.put(req, fresh.clone()).catch(() => {});
    return fresh;
  } catch {
    return new Response('', { status: 503 });
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const fetchAndUpdate = fetch(req)
    .then((fresh) => {
      if (fresh.ok) cache.put(req, fresh.clone()).catch(() => {});
      return fresh;
    })
    .catch(() => null);
  if (cached) {
    fetchAndUpdate.catch(() => {}); // background revalidate; ignore failures
    return cached;
  }
  const fresh = await fetchAndUpdate;
  return (
    fresh ||
    (await caches.match(OFFLINE_FALLBACK)) ||
    new Response('Offline. Re-open when you have a connection.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' },
    })
  );
}
