// CACHE/CACHE_ASSETS los bumpea build_deploy.py en cada corrida (hash del
// contenido real) -- no se editan a mano, y no cambian si no hay cambios de
// verdad. Dos cachés, no una (punto 7 del checklist pwa-actualizacion-sin-
// cache, 2026-09-11): el shell de código (html/js/css) cambia seguido; las
// fuentes del tema (~220 KB) casi nunca cambian -- solo si el ERP cambia de
// marca. Si compartieran una sola caché, arreglar una coma en caja.js
// forzaría a redescargar las fuentes completas en el siguiente uso.
const CACHE = 'sumetec-direccion-f49ea24671';
const CACHE_ASSETS = 'sumetec-direccion-assets-089af8bd65';
const PREFIJO = 'sumetec-direccion-';
const SHELL = [
  './', './direccion.html', './app.js', './caja.js',
  './corte.js', './dashboard.js', './inventario.js', './seguridad.js', './estilos.css',
  './manifest.json', './version.js',
  // Tema visual del ERP (2026-09-11, generar_tema.py) -- sin esto, el
  // teléfono sin señal cargaría la app con las tarjetas/botones/letra rotos.
  './sumetec-tema.css', './tema-inicial.js'
];
const ARCHIVOS_ASSETS = [
  './fonts/ibm-plex-sans-variable.woff2', './fonts/ibm-plex-mono-400.woff2',
  './fonts/ibm-plex-mono-500.woff2', './fonts/ibm-plex-mono-600.woff2',
  './fonts/bootstrap-icons.woff2'
];

self.addEventListener('install', e => {
  self.skipWaiting();
  // addAll() usa fetch() por dentro, que respeta el Cache-Control del
  // hosting -- si el navegador tenía una copia vieja en su caché HTTP
  // normal, el SW "se instalaba bien" pero guardaba el contenido de
  // siempre. { cache: 'reload' } bypassea esa caché HTTP explícitamente.
  // Las fuentes van aparte: cache.add() normal (SÍ respeta la caché HTTP a
  // propósito) y solo si de verdad faltan -- son pesadas y casi nunca
  // cambian, no hay que insistir en bajarlas de nuevo en cada instalación.
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
    // Solo borra cachés DE ESTA APP -- CacheStorage es por origen, no por
    // scope; si Dirección comparte origen con otra PWA de SUMETEC, borrar
    // "todo lo que no sea mi CACHE" le borraría el offline a la otra.
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k.startsWith(PREFIJO) && k !== CACHE && k !== CACHE_ASSETS).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = e.request.url;

  // Apps Script: solo red, nunca caché -- son movimientos de dinero.
  if (url.includes('script.google.com')) return;

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
        .catch(() => caches.match('./direccion.html'))
    );
    return;
  }

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
