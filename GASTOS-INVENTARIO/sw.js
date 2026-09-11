// CACHE/CACHE_ASSETS los bumpea build_deploy.py en cada corrida (hash del
// contenido real) -- no se editan a mano, y no cambian si no hay cambios de
// verdad. Dos cachés, no una (F5b, 2026-09-11, punto 7 del checklist
// pwa-actualizacion-sin-cache): el shell de código (el HTML) cambia seguido;
// las fuentes del tema (~220 KB) casi nunca cambian -- solo si el ERP
// cambia de marca. Si compartieran una sola caché, corregir una coma en el
// HTML forzaría a redescargar las fuentes completas en el siguiente uso.
const CACHE = 'sumetec-inv-5237531bab'; // bump obligatorio o los celulares siguen con la app vieja
const CACHE_ASSETS = 'sumetec-inv-assets-089af8bd65';
const PREFIJO = 'sumetec-inv-';
const SHELL = ['./gastos-inventario.html', './manifest.json', './sumetec-tema.css', './tema-inicial.js'];
const ARCHIVOS_ASSETS = [
  './fonts/ibm-plex-sans-variable.woff2', './fonts/ibm-plex-mono-400.woff2',
  './fonts/ibm-plex-mono-500.woff2', './fonts/ibm-plex-mono-600.woff2',
  './fonts/bootstrap-icons.woff2'
];

self.addEventListener('install', e => {
  self.skipWaiting();
  // GI1 (plan 2026-08-19): antes era caches.open(CACHE).then(c => c.addAll(SHELL))
  // -- addAll() usa fetch() por dentro, que respeta el Cache-Control del
  // hosting: si GitHub Pages entregaba una copia vieja de la caché HTTP
  // normal del navegador, el service worker "se instalaba bien" (nombre de
  // caché nuevo, skipWaiting disparado) pero guardaba el contenido de
  // siempre. { cache: 'reload' } bypassea esa caché HTTP explícitamente.
  // Las fuentes van aparte: cache.add() normal (SÍ respeta la caché HTTP a
  // propósito) y solo si de verdad faltan.
  e.waitUntil(Promise.all([
    caches.open(CACHE).then(c => Promise.all(
      SHELL.map(url => fetch(url, { cache: 'reload' }).then(r => c.put(url, r)))
    )),
    caches.open(CACHE_ASSETS).then(c => Promise.all(
      ARCHIVOS_ASSETS.map(url => c.match(url).then(hit => hit || c.add(url)))
    ))
  ]));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    // Solo borra cachés DE ESTA APP. CacheStorage es por ORIGEN, no por scope:
    // en GitHub Pages, Cotizador e Inventario comparten origen, así que borrar
    // "todo lo que no sea mi CACHE" también borraba el caché offline del otro.
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k.startsWith(PREFIJO) && k !== CACHE && k !== CACHE_ASSETS).map(k => caches.delete(k)))
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
