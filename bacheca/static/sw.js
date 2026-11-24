// Service worker della bacheca: tiene in cache la pagina, gli script e la libreria Firebase,
// così l'app si apre anche senza rete. I dati non passano di qui: li tiene Firestore in IndexedDB.
//
// File della pagina: prima la rete (si pubblica spesso), con 3 secondi di attesa massima, poi la cache.
// Libreria Firebase su gstatic: ha la versione nell'indirizzo, quindi prima la cache.
const CACHE = "bacheca-v23";
const FIREBASE = "https://www.gstatic.com/firebasejs/12.4.0/";
const SHELL = [
  "/", "/index.html", "/config.js", "/app.js", "/store.js", "/md.js", "/app.css", "/icon.svg",
  "/manifest.webmanifest", "/apple-touch-icon.png", "/icon-192.png", "/icon-512.png",
  "/__/firebase/init.json",
  FIREBASE + "firebase-app.js", FIREBASE + "firebase-auth.js", FIREBASE + "firebase-firestore.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Uno alla volta: se ne manca uno (init.json in locale) gli altri entrano lo stesso.
    await Promise.all(SHELL.map((url) => cache.add(url).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name !== CACHE) await caches.delete(name);
    await self.clients.claim();
  })());
});

async function networkFirst(request, key) {
  const cache = await caches.open(CACHE);
  const network = fetch(request).then((response) => {
    if (response.ok) cache.put(key, response.clone());
    return response;
  });
  network.catch(() => {}); // se vince l'attesa, l'errore della rete non resta senza gestione
  const timeout = new Promise((resolve) => setTimeout(resolve, 3000));
  try {
    const response = await Promise.race([network, timeout]);
    // Un errore del server (404, 5xx) non deve battere la copia in cache.
    if (response?.ok) return response;
  } catch { /* offline: si passa alla cache */ }
  const cached = await cache.match(key);
  if (cached) return cached;
  return network; // niente in cache: si aspetta la rete, o il suo errore
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  if (url.href.startsWith(FIREBASE)) return event.respondWith(cacheFirst(request));
  if (url.origin !== location.origin) return; // Firestore, Google, foto profilo: direttamente in rete

  // Accesso Google e pagina di login del connettore MCP: sempre dalla rete.
  if (url.pathname.startsWith("/__/auth/") || url.pathname.startsWith("/mcp-login")) return;

  if (request.mode === "navigate") return event.respondWith(networkFirst(request, "/index.html"));
  event.respondWith(networkFirst(request, url.pathname));
});

/* ---------- Notifiche delle scadenze ----------
   Le manda il Worker (mcp-worker/src/avvisi.ts) con Web Push: {title, body, url, tag}.
   Il tag è la chiave dell'avviso: la stessa notifica non compare due volte. */
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data?.text() || "" }; }
  event.waitUntil(self.registration.showNotification(data.title || "Jarvis", {
    body: data.body || "",
    tag: data.tag || undefined,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: { url: data.url || "/" },
  }));
});

// Tocco sulla notifica: apre la scheda nella bacheca già aperta, o in una nuova finestra.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
    if (open) {
      open.postMessage({ open: url });
      return open.focus();
    }
    return self.clients.openWindow(url);
  })());
});
