// CACHE lo bumpea build_deploy.py en cada corrida (hash del contenido real)
// -- no se edita a mano, y no cambia si no hay cambios de verdad.
const CACHE = 'sumetec-direccion-5d0e22b489';
const PREFIJO = 'sumetec-direccion-';
const SHELL = [
  './', './index.html', './app.js', './caja.js', './compras.js',
  './corte.js', './dashboard.js', './seguridad.js', './estilos.css',
  './manifest.json', './version.js'
];

self.addEventListener('install', e => {
  self.skipWaiting();
  // addAll() usa fetch() por dentro, que respeta el Cache-Control del
  // hosting -- si el navegador tenía una copia vieja en su caché HTTP
  // normal, el SW "se instalaba bien" pero guardaba el contenido de
  // siempre. { cache: 'reload' } bypassea esa caché HTTP explícitamente.
  e.waitUntil(
    caches.open(CACHE).then(c => Promise.all(
      SHELL.map(url => fetch(url, { cache: 'reload' }).then(r => c.put(url, r)))
    ))
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    // Solo borra cachés DE ESTA APP -- CacheStorage es por origen, no por
    // scope; si Dirección comparte origen con otra PWA de SUMETEC, borrar
    // "todo lo que no sea mi CACHE" le borraría el offline a la otra.
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k.startsWith(PREFIJO) && k !== CACHE).map(k => caches.delete(k)))
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
        .catch(() => caches.match('./index.html'))
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
