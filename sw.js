/**
 * sw.js — Aperture service worker.
 * Cache-first strategy for app shell + CDN dependencies.
 *
 * IMPORTANT: REPO must match the GitHub Pages subpath (repo name).
 * All shell paths are absolute from origin with the REPO prefix.
 */

const REPO    = '/foto';
const VERSION = 'v1';
const CACHE   = `aperture-${VERSION}`;

const SHELL = [
  `${REPO}/`,
  `${REPO}/index.html`,
  `${REPO}/css/app.css`,
  `${REPO}/js/app.js`,
  `${REPO}/js/camera.js`,
  `${REPO}/js/capture.js`,
  `${REPO}/js/capabilities.js`,
  `${REPO}/js/modes.js`,
  `${REPO}/js/overlays.js`,
  `${REPO}/js/exif.js`,
  `${REPO}/js/calculator.js`,
  `${REPO}/js/gallery.js`,
  `${REPO}/workers/hdr.worker.js`,
  `${REPO}/workers/stack.worker.js`,
  `${REPO}/manifest.webmanifest`,
  `${REPO}/icons/icon-192.svg`,
  `${REPO}/icons/icon-512.svg`,
];

const CDN_URLS = [
  'https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css',
  'https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css',
  'https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js',
  'https://cdn.jsdelivr.net/npm/piexifjs@1.0.6/piexif.js',
];

// Bootstrap Icons uses font files — cache them too
const ICON_FONT_PATTERNS = [
  'https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/fonts/',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll([...SHELL, ...CDN_URLS]))
      .then(() => self.skipWaiting())
      .catch(err => console.warn('[SW] Install cache failed:', err))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => {
          console.log('[SW] Deleting old cache:', k);
          return caches.delete(k);
        })
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = request.url;

  // Only handle GET requests
  if (request.method !== 'GET') return;

  // Skip non-http(s) requests
  if (!url.startsWith('http')) return;

  // Skip camera API and dynamic requests
  if (url.includes('getUserMedia') || url.includes('blob:')) return;

  // Cache-first for shell and CDN
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;

      return fetch(request).then(response => {
        // Cache CDN responses and icon fonts
        const shouldCache = CDN_URLS.includes(url)
          || ICON_FONT_PATTERNS.some(p => url.startsWith(p))
          || url.startsWith(self.location.origin + REPO);

        if (shouldCache && response.ok) {
          const clone = response.clone();
          caches.open(CACHE).then(c => c.put(request, clone));
        }
        return response;
      }).catch(() => {
        // Offline fallback for navigation requests
        if (request.mode === 'navigate') {
          return caches.match(`${REPO}/index.html`);
        }
        return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
      });
    })
  );
});
