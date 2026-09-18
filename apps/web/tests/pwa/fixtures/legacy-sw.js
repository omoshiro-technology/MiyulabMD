// Test-only copy of the former #104 emergency kill switch.
self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await self.clients.claim();
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
      await self.registration.unregister();
      const clients = await self.clients.matchAll({
        includeUncontrolled: true,
        type: "window",
      });
      await Promise.all(clients.map((client) => client.navigate(client.url)));
    })(),
  );
});
