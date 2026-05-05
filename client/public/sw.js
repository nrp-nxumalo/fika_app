const LEGACY_CACHE_PREFIX = 'fika-app-shell-';

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) =>
        Promise.all(
          cacheNames
            .filter((cacheName) => cacheName.startsWith(LEGACY_CACHE_PREFIX))
            .map((cacheName) => caches.delete(cacheName))
        )
      )
      .then(() => self.registration.unregister())
      .then(() => self.clients.claim())
  );
});
