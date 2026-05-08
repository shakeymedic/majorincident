const CACHE_NAME = 'mit-triage-v4-2026-05-08';
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
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.filter(n => n !== CACHE_NAME).map(n => caches.delete(n))
            );
        }).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    const req = event.request;
    // Only cache GET requests; never cache POST/etc.
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    // Map tile traffic: stale-while-revalidate with size cap
    if (/tile\.openstreetmap\.org$/.test(url.hostname)) {
        event.respondWith(
            caches.match(req).then(hit => {
                const fetchPromise = fetch(req).then(resp => {
                    if (resp && resp.status === 200) {
                        const clone = resp.clone();
                        caches.open(CACHE_NAME).then(c => c.put(req, clone)).catch(() => {});
                    }
                    return resp;
                }).catch(() => hit);
                return hit || fetchPromise;
            })
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
