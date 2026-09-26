const CACHE_NAME = 'mit-triage-v11-2026-09-26-bugfix-sweep';
// Map tiles live in their own cache so app updates do not throw them away, capped so storage cannot fill up.
const TILE_CACHE = 'mit-tiles-v1';
const TILE_CACHE_MAX = 600;
const PRECACHE_URLS = [
    './',
    './index.html',
    './manifest.json',
    './icon.svg',
    './lib.js',
    './vendor/qrcode.min.js',
    './vendor/html5-qrcode.min.js',
    './vendor/leaflet.css',
    './vendor/leaflet.js',
    './vendor/markercluster.css',
    './vendor/markercluster-default.css',
    './vendor/markercluster.js',
    './vendor/images/layers.png',
    './vendor/images/layers-2x.png',
    './vendor/images/marker-icon.png',
    './vendor/images/marker-icon-2x.png',
    './vendor/images/marker-shadow.png'
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE_URLS))
    );
    // Do NOT auto-skipWaiting; we want the page to surface an "Update available"
    // banner so an in-progress incident is not disrupted by an unexpected reload.
});

self.addEventListener('message', event => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.filter(n => n !== CACHE_NAME && n !== TILE_CACHE).map(n => caches.delete(n))
            );
        }).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    const req = event.request;
    // Only cache GET requests; never cache POST/etc.
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    // Map tile traffic: stale-while-revalidate into a separate, size-capped cache
    if (/tile\.openstreetmap\.org$/.test(url.hostname)) {
        event.respondWith(
            caches.open(TILE_CACHE).then(cache => cache.match(req).then(hit => {
                const fetchPromise = fetch(req).then(resp => {
                    if (resp && (resp.status === 200 || resp.type === 'opaque')) {
                        cache.put(req, resp.clone()).then(() => trimTileCache(cache)).catch(() => {});
                    }
                    return resp;
                }).catch(() => hit || Response.error());
                return hit || fetchPromise;
            }))
        );
        return;
    }
    // Same-origin: cache-first, fall back to network, then back to index for navigations
    event.respondWith(
        caches.match(req).then(cached => {
            if (cached) return cached;
            return fetch(req).then(resp => {
                if (!resp || resp.status !== 200 || resp.type !== 'basic') return resp;
                const clone = resp.clone();
                caches.open(CACHE_NAME).then(c => c.put(req, clone)).catch(() => {});
                return resp;
            }).catch(() => {
                // Offline navigation fallback
                if (req.mode === 'navigate') return caches.match('./index.html');
                return Response.error();
            });
        })
    );
});

function trimTileCache(cache) {
    return cache.keys().then(keys => {
        if (keys.length <= TILE_CACHE_MAX) return;
        return Promise.all(keys.slice(0, keys.length - TILE_CACHE_MAX).map(k => cache.delete(k)));
    });
}
