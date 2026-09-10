const CACHE = 'sumetec-rem-70bc1900eb';
const PREFIJO = 'sumetec-rem-';
// Assets pesados (jsPDF ~400 KB) en su PROPIA caché, versionada aparte del shell.
// Antes vivían dentro de CACHE: como ese nombre es un hash del shell, cambiar una
// coma del HTML tiraba la caché entera y el celular volvía a bajar los 400 KB de
// jsPDF aunque no hubiera cambiado. Esta versión solo se sube si de verdad se
// cambia de versión de jsPDF (checklist pwa-actualizacion-sin-cache, punto 7).
const CACHE_ASSETS = 'sumetec-rem-assets-jspdf251';
const PREFIJO_ASSETS = 'sumetec-rem-assets-';
const STATIC = [
  './remision.html',
  './calculos.js',
  './sync_audit.js',
  './version.js'
];
// H5: jsPDF servido LOCAL (vendor/) → los PDF funcionan sin internet y sin depender
// de un CDN externo. Las URLs del CDN quedan como respaldo (la app las usa solo si
// el archivo local falla; si llegan a pedirse, también se cachean).
const ASSETS = [
  './vendor/jspdf.umd.min.js',
  './vendor/jspdf.plugin.autotable.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.5.29/jspdf.plugin.autotable.min.js'
];

// Instalar: cachear el shell + (si faltan) los assets pesados.
// Se cachea cada recurso por separado (no addAll) para que un fallo puntual del
// CDN —p. ej. jsPDF no disponible en ese instante— NO aborte toda la instalación
// y deje la app sin nada en caché. Lo que sí se baje queda guardado.
//
// checklist pwa-actualizacion-sin-cache, punto 4 (2026-09-01): c.add(u) usa
// fetch() por dentro, que respeta la caché HTTP normal del navegador -- si
// GitHub Pages entregaba una copia vieja de esa caché, el SW "se instalaba
// bien" (nombre de caché nuevo, skipWaiting disparado) pero guardaba el
// contenido de siempre. { cache: 'reload' } bypassea esa caché HTTP
// explícitamente, sin perder la tolerancia a fallos de CDN de arriba.
async function precachearShell() {
  const cache = await caches.open(CACHE);
  await Promise.allSettled(STATIC.map(async (url) => {
    try {
      const resp = await fetch(url, { cache: 'reload' });
      await cache.put(url, resp);
    } catch (err) {
      console.warn('SW: no se pudo precachear', url, err);
    }
  }));
}

// Punto 7 del checklist: los assets pesados se bajan SOLO si de verdad faltan, y
// con la caché HTTP normal (aquí sí conviene: el objetivo es no re-bajar lo que
// no cambió). Si ya están de una versión anterior del shell, no se toca nada.
async function precachearAssets() {
  const cache = await caches.open(CACHE_ASSETS);
  await Promise.allSettled(ASSETS.map(async (url) => {
    try {
      if (!(await cache.match(url))) await cache.add(url);
    } catch (err) {
      console.warn('SW: no se pudo precachear asset', url, err);
    }
  }));
}

self.addEventListener('install', e => {
  e.waitUntil(
    Promise.all([precachearShell(), precachearAssets()])
      .then(() => self.skipWaiting())
  );
});

// Activar: limpiar cachés viejos DE ESTA APP. CacheStorage es por ORIGEN, no
// por scope: en GitHub Pages, Cotizador e Inventario comparten origen, así
// que borrar "todo lo que no sea mi CACHE" también borraba el caché offline
// del otro (jsPDF, HTML) hasta su próxima visita con señal.
//
// Ojo con el orden: PREFIJO ('sumetec-rem-') también casa con el nombre de la
// caché de assets ('sumetec-rem-assets-...'), así que la de assets se evalúa
// PRIMERO -- si no, cada deploy del shell borraría justo lo que el punto 7
// intenta conservar.
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => {
          if (k.startsWith(PREFIJO_ASSETS)) return k !== CACHE_ASSETS;
          return k.startsWith(PREFIJO) && k !== CACHE;
        }).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = e.request.url;

  // Apps Script y Google Fonts: solo red, nunca caché
  if (url.includes('script.google.com') || url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com')) {
    return;
  }

  // HTML principal: red primero, caché como fallback
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then(r => {
          // A1 audit 2026-07-05: nunca cachear respuestas de error (404/500) —
          // se quedaban pegadas hasta subir la versión del caché.
          if (r.ok) {
            const clone = r.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone));
          }
          return r;
        })
        .catch(() => caches.match('./remision.html'))
    );
    return;
  }

  // Assets estáticos (jsPDF, etc.): caché primero, red como fallback.
  // caches.match() sin `cacheName` busca en TODAS las cachés del origen, así que
  // encuentra tanto el shell como los assets pesados sin preguntar en cuál está.
  e.respondWith(
    caches.match(e.request).then(r => {
      if (r) return r;
      return fetch(e.request).then(r2 => {
        if (!r2.ok) return r2;   // A1: un error del CDN/Pages no se guarda en caché
        // Lo que viene de vendor/ o del CDN de jsPDF va a la caché de assets (no se
        // tira en cada deploy); todo lo demás, a la del shell.
        const esAsset = /\/vendor\/|cdnjs\.cloudflare\.com/.test(e.request.url);
        const destino = esAsset ? CACHE_ASSETS : CACHE;
        // Clonar ANTES de usar: una para caché, una para retornar
        const clone1 = r2.clone();
        const clone2 = r2.clone();
        caches.open(destino).then(c => c.put(e.request, clone1)).catch(()=>{});
        return clone2;
      });
    })
  );
});
