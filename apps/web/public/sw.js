// Brain service worker (E096): static shell only. API traffic is never
// intercepted or cached, so there is no offline approval path — offline, the
// shell loads and every action fails visibly until the Governor is reachable.
// Cache names are versioned; activation deletes every older cache, so updates
// take effect on the next visit without serving a stale shell.
const CACHE = "brain-shell-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET") return; // mutations always hit the network
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/v1/") || url.pathname.startsWith("/api/") || url.pathname.startsWith("/runner/")) return;
  event.respondWith(
    caches.match(event.request).then((hit) => {
      const network = fetch(event.request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return response;
      });
      // Offline: serve the cached shell (visible fallback); navigations fall
      // back to the cached root document.
      return network.catch(() => hit ?? caches.match("/"));
    }),
  );
});

// Push (T45): notifications are attention hints only — opening one lands on
// the approvals inbox, where the durable, authorized decision flow runs.
self.addEventListener("push", (event) => {
  let data = { title: "Keyrus Brain", body: "Something needs your attention.", url: "/#/approvals" };
  try { if (event.data) data = { ...data, ...event.data.json() }; } catch { /* keep defaults */ }
  event.waitUntil(self.registration.showNotification(data.title, { body: data.body, data: { url: data.url } }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url ?? "/#/approvals";
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
    for (const client of clients) {
      if ("focus" in client) { client.navigate(url); return client.focus(); }
    }
    return self.clients.openWindow(url);
  }));
});
