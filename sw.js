// Service worker del portal de familias: notificaciones push y funcionamiento básico sin conexión.
const CACHE = "cn-familias-v1";
const BASE = ["padre.html", "css/app.css", "js/comun.js", "js/padre.js", "icons/icon-192.png", "icons/icon-512.png", "manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(BASE)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Red primero (datos siempre frescos); si no hay conexión, se usa la copia guardada.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((r) => { if (r.ok) { const copia = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copia)); } return r; })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match("padre.html"))),
  );
});

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  e.waitUntil((async () => {
    await self.registration.showNotification(d.title || "Campus Norte", {
      body: d.body || "",
      icon: "icons/icon-192.png",
      badge: "icons/badge-72.png",
      tag: d.tag,
      requireInteraction: !!d.urgente,
      vibrate: d.urgente ? [300, 100, 300, 100, 300] : [120],
      data: { url: d.url || "./padre.html" },
    });
    const ventanas = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    ventanas.forEach((v) => v.postMessage({ tipo: "aviso" }));
  })());
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const destino = new URL(e.notification.data?.url || "./padre.html", self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((vs) => {
    for (const v of vs) if (v.url.split("#")[0].split("?")[0] === destino.split("?")[0] && "focus" in v) return v.focus();
    return self.clients.openWindow(destino);
  }));
});
