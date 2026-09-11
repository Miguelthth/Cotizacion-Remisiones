const CACHE = 'sumetec-inv-425e38a34f'; // J-1 (2026-07-22): Gastos/Inventario -- bump obligatorio o los celulares siguen con la app vieja
const PREFIJO = 'sumetec-inv-';
const SHELL = ['./gastos-inventario.html', './manifest.json'];

self.addEventListener('install', e => {
  self.skipWaiting();
  // GI1 (plan 2026-08-19): antes era caches.open(CACHE).then(c => c.addAll(SHELL))
  // -- addAll() usa fetch() por dentro, que respeta el Cache-Control del
  // hosting: si GitHub Pages entregaba una copia vieja de la caché HTTP
  // normal del navegador, el service worker "se instalaba bien" (nombre de
  // caché nuevo, skipWaiting disparado) pero guardaba el contenido de
  // siempre. { cache: 'reload' } bypassea esa caché HTTP explícitamente.
  e.waitUntil(
    caches.open(CACHE).then(c => Promise.all(
      SHELL.map(url => fetch(url, { cache: 'reload' }).then(r => c.put(url, r)))
    ))
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    // Solo borra cachés DE ESTA APP. CacheStorage es por ORIGEN, no por scope:
    // en GitHub Pages, Cotizador e Inventario comparten origen, así que borrar
    // "todo lo que no sea mi CACHE" también borraba el caché offline del otro.
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k.startsWith(PREFIJO) && k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = e.request.url;

  // Apps Script: solo red, nunca cache (igual que sw.js de remisiones).
  if (url.includes('script.google.com')) return;

  // HTML principal: red primero, cache como fallback.
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then(r => {
          if (r.ok) {
            const clone = r.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone));
          }
          return r;
        })
        .catch(() => caches.match('./gastos-inventario.html'))
    );
    return;
  }

  // Assets estaticos: cache primero, red como fallback.
  e.respondWith(
    caches.match(e.request).then(r => {
      if (r) return r;
      return fetch(e.request).then(r2 => {
        if (!r2.ok) return r2;
        const clone1 = r2.clone();
        const clone2 = r2.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone1)).catch(() => {});
        return clone2;
      });
    })
  );
});
