const CACHE_NAME = 'trip-manager-pwa-v8';
const APP_SHELL = [
  './車趟記錄1.html',
  './manifest.webmanifest',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './cloud-config.js',
  './cloud-sync.js'
];

const RUNTIME_CACHE = 'trip-manager-runtime-v4';
const EXTERNAL_ASSETS = [
  'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/xlsx.full.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_SHELL);

    // These are optional: failure must never prevent the PWA from installing.
    for (const url of EXTERNAL_ASSETS) {
      try {
        const response = await fetch(url, { mode: 'cors', cache: 'no-cache' });
        if (response.ok) await cache.put(url, response.clone());
      } catch (error) {
        // The app can still run locally if an external asset is unavailable.
      }
    }

    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter(key => key !== CACHE_NAME && key !== RUNTIME_CACHE)
        .map(key => caches.delete(key))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

async function networkFirst(request, fallbackUrl) {
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      const cache = await caches.open(RUNTIME_CACHE);
      await cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    return caches.match(request) || caches.match(fallbackUrl);
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response && (response.ok || response.type === 'opaque')) {
      const cache = await caches.open(RUNTIME_CACHE);
      await cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    return Response.error();
  }
}

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const requestUrl = new URL(event.request.url);
  const isSameOrigin = requestUrl.origin === self.location.origin;
  const isExternalAsset = EXTERNAL_ASSETS.includes(event.request.url);

  if (event.request.mode === 'navigate') {
    event.respondWith(networkFirst(event.request, './車趟記錄1.html'));
    return;
  }

  if (isSameOrigin || isExternalAsset) {
    if (requestUrl.pathname.endsWith('/cloud-sync.js')) {
      event.respondWith(networkFirst(event.request, './cloud-sync.js'));
    } else {
      event.respondWith(cacheFirst(event.request));
    }
  }
});
