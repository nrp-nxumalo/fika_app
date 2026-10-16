const APP_SHELL_CACHE = 'fika-app-shell-v4';
const APP_SHELL_PREFIX = 'fika-app-shell-';
const CORE_URLS = ['/', '/saved-timetables', '/asset-manifest.json', '/manifest.json'];

const cacheResponse = async (cache, request, response) => {
  if (response?.ok) {
    await cache.put(request, response.clone());
  }

  return response;
};

const precacheAppShell = async () => {
  const cache = await caches.open(APP_SHELL_CACHE);
  const assetUrls = new Set(CORE_URLS);

  try {
    const manifestResponse = await fetch('/asset-manifest.json', { cache: 'no-store' });

    if (manifestResponse.ok) {
      const manifest = await manifestResponse.clone().json();
      (manifest.entrypoints || []).forEach((assetPath) => {
        assetUrls.add(assetPath.startsWith('/') ? assetPath : `/${assetPath}`);
      });
      await cache.put('/asset-manifest.json', manifestResponse);
    }
  } catch (error) {
    // Runtime caching can still populate the shell after installation.
  }

  await Promise.allSettled([...assetUrls].map(async (assetUrl) => {
    const response = await fetch(assetUrl, { cache: 'no-store' });
    await cacheResponse(cache, assetUrl, response);
  }));
};

self.addEventListener('install', (event) => {
  event.waitUntil(precacheAppShell().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => Promise.all(
        cacheNames
          .filter((cacheName) => cacheName.startsWith(APP_SHELL_PREFIX) && cacheName !== APP_SHELL_CACHE)
          .map((cacheName) => caches.delete(cacheName))
      ))
      .then(() => self.clients.claim())
  );
});

const shouldBypassCache = (url) => (
  url.pathname === '/sw.js' ||
  url.pathname === '/robots.txt' ||
  url.pathname === '/sitemap.xml' ||
  url.pathname === '/schedules' ||
  url.pathname.startsWith('/schedule_times/') ||
  url.pathname.startsWith('/api/') ||
  url.pathname.startsWith('/admin/') ||
  url.pathname.startsWith('/healthz')
);

const networkFirstNavigation = async (request) => {
  const cache = await caches.open(APP_SHELL_CACHE);

  try {
    const response = await fetch(request);
    await cacheResponse(cache, request, response);
    return response;
  } catch (error) {
    return (await cache.match(request)) ||
      (await cache.match('/saved-timetables')) ||
      (await cache.match('/')) ||
      Response.error();
  }
};

const staleWhileRevalidate = async (request) => {
  const cache = await caches.open(APP_SHELL_CACHE);
  const cachedResponse = await cache.match(request);
  const networkResponse = fetch(request)
    .then((response) => cacheResponse(cache, request, response))
    .catch(() => null);

  return cachedResponse || (await networkResponse) || Response.error();
};

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (
    request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    shouldBypassCache(url)
  ) {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  event.respondWith(staleWhileRevalidate(request));
});
