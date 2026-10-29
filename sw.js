const CACHE_NAME = 'mit-triage-v38-2026-10-29-decisions';
// Map tiles live in their own cache so app updates do not throw them away, capped so storage cannot fill up.
const TILE_CACHE = 'mit-tiles-v1';
// The printed-number reader (vendor/tesseract, ~10 MB, fetched on demand) is kept across app updates too,
// otherwise every release silently threw it away and the next offline read failed.
const OCR_CACHE = 'mit-ocr-v1';
const TILE_CACHE_MAX = 600;
const PRECACHE_URLS = [
    './',
    './index.html',
    './manifest.json',
    './privacy.html',
    './icon.svg',
    './apple-touch-icon.png',
    './icon-192.png',
    './icon-512.png',
    './icon-maskable-512.png',
    './quick-reference.html',
    './commander.html',
    './commander.js',
    './accessibility.html',
    './lib.js',
    './vendor/qrcode.min.js',
    './vendor/html5-qrcode.min.js',
    './vendor/pako_inflate.min.js',
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
    // The page asks: is every file needed to work without signal stored on this phone?
    // If the page lists the printed-number reader's files, say whether they are stored too (they are fetched on
    // demand, so "ready offline" without them would be only half true for reading printed numbers).
    if (event.data && event.data.type === 'OFFLINE_STATUS') {
        const ocrFiles = Array.isArray(event.data.ocrFiles) ? event.data.ocrFiles.slice(0, 10) : null;
        event.waitUntil(Promise.all([
            caches.open(CACHE_NAME).then(cache => Promise.all(PRECACHE_URLS.map(u => cache.match(u).then(hit => hit ? null : u)))),
            ocrFiles ? caches.open(OCR_CACHE).then(cache => Promise.all(ocrFiles.map(u => cache.match(u).then(hit => !!hit)))) : Promise.resolve(null),
        ]).then(([results, ocrHits]) => {
            const missing = results.filter(Boolean);
            const ocrReady = ocrHits ? ocrHits.every(Boolean) : null;
            if (event.source) event.source.postMessage({ type: 'OFFLINE_STATUS', ready: missing.length === 0, missing, ocrReady, cache: CACHE_NAME });
        }));
    }
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.filter(n => n !== CACHE_NAME && n !== TILE_CACHE && n !== OCR_CACHE).map(n => caches.delete(n))
            );
        }).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    const req = event.request;
    // Only cache GET requests; never cache POST/etc.
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    // Live data for the incident commander is never served from cache.
    if (url.pathname.indexOf('/api/') === 0 || url.pathname.indexOf('/.netlify/') === 0) return;
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
    // Printed-number reader files: cache-first into their own long-lived cache.
    if (url.origin === self.location.origin && url.pathname.indexOf('/vendor/tesseract/') > -1) {
        event.respondWith(
            caches.open(OCR_CACHE).then(cache => cache.match(req).then(hit => hit || fetch(req).then(resp => {
                if (resp && resp.status === 200 && resp.type === 'basic') cache.put(req, resp.clone()).catch(() => {});
                return resp;
            })))
        );
        return;
    }
    // The app page and lib.js: served from the cache at once, then fetched again in the background so a phone that
    // opens the app once after a release already has the new files next time. Nothing reloads by itself.
    if (url.origin === self.location.origin && isShellPath(url.pathname)) {
        event.respondWith(caches.match(req).then(cached => {
            if (cached) { event.waitUntil(refreshShell()); return cached; }
            return fetch(req).catch(() => req.mode === 'navigate' ? caches.match('./index.html') : Response.error());
        }));
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

const SCOPE_PATH = new URL('./', self.location.href).pathname;
function isShellPath(p) { return p === SCOPE_PATH || p === SCOPE_PATH + 'index.html' || p === SCOPE_PATH + 'lib.js'; }
// index.html and lib.js are stored as a pair or not at all, so a refresh cut short by a lost signal can never
// leave a new page running with an old lib.js. At most once a minute.
let lastShellRefresh = 0;
function refreshShell() {
    if (Date.now() - lastShellRefresh < 60 * 1000) return Promise.resolve();
    lastShellRefresh = Date.now();
    const get = (u) => fetch(u, { cache: 'no-cache' }).then(r => (r && r.status === 200 && r.type === 'basic' && !r.redirected) ? r : Promise.reject(new Error(u)));
    return Promise.all([get('./'), get('./lib.js')]).then(([page, lib]) => caches.open(CACHE_NAME).then(cache => Promise.all([
        cache.put('./', page.clone()), cache.put('./index.html', page), cache.put('./lib.js', lib),
    ]))).catch(() => {});
}

function trimTileCache(cache) {
    return cache.keys().then(keys => {
        if (keys.length <= TILE_CACHE_MAX) return;
        return Promise.all(keys.slice(0, keys.length - TILE_CACHE_MAX).map(k => cache.delete(k)));
    });
}
