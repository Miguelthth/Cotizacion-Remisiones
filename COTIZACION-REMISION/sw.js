const CACHE = 'sumetec-rem-9b41dc1a24';
const PREFIJO = 'sumetec-rem-';
// Assets pesados (jsPDF ~400 KB) en su PROPIA caché, versionada aparte del shell.
// Antes vivían dentro de CACHE: como ese nombre es un hash del shell, cambiar una
// coma del HTML tiraba la caché entera y el celular volvía a bajar los 400 KB de
// jsPDF aunque no hubiera cambiado. Esta versión solo se sube si de verdad se
// cambia de versión de jsPDF (checklist pwa-actualizacion-sin-cache, punto 7).
const CACHE_ASSETS = 'sumetec-rem-assets-jspdf251';
const PREFIJO_ASSETS = 'sumetec-rem-assets-';
const STATIC = [
  './version.js'
];
const MANIFIESTO_PRECACHE = './precache-manifest.json';
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
  const respuesta = await fetch(MANIFIESTO_PRECACHE, { cache: 'reload' });
  if (!respuesta.ok) throw new Error('no se pudo leer precache-manifest.json');
  const manifiesto = await respuesta.json();
  if (!Array.isArray(manifiesto.files)) throw new Error('precache-manifest.json inválido');
  const rutas = [...new Set([MANIFIESTO_PRECACHE, ...STATIC, ...manifiesto.files.map(ruta => './' + ruta)])];
  let faltante = false;
  await Promise.allSettled(rutas.map(async (url) => {
    try {
      const resp = await fetch(url, { cache: 'reload' });
      // Hallazgo 4 (auditoría Cotizador, 2026-09-10): fetch() NO lanza en un 404/500 --
      // solo resuelve con ok:false. Sin este chequeo, un archivo nuevo (sync_audit.js,
      // version.js) que todavía no existiera en el hosting en el momento exacto del
      // deploy se guardaba en caché COMO SI fuera el archivo real, y ya no se
      // corregía solo hasta el próximo cambio de versión del shell.
      if (resp.ok) {
        await cache.put(url, resp);
      } else {
        faltante = true;
        console.warn('SW: respuesta no-ok al precachear (no se guarda)', url, resp.status);
      }
    } catch (err) {
      faltante = true;
      console.warn('SW: no se pudo precachear', url, err);
    }
  }));
  // M-12 (auditoría de robustez, 2026-09-10): si faltó CUALQUIER pieza del shell,
  // la instalación FALLA a propósito. Antes solo se anotaba en el log y el SW se
  // activaba igual: con activate() ya corriendo se borraban las cachés anteriores,
  // así que el celular se quedaba con una versión nueva incompleta y sin la vieja
  // a la que volver. Al lanzar aquí, install() se rechaza, este SW se descarta y el
  // anterior sigue mandando intacto; el navegador reintenta en la próxima carga.
  if (faltante) {
    console.warn('SW: precacheo del shell incompleto -- se conserva la versión anterior');
    throw new Error('precacheo del shell incompleto');
  }
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

// M-12: el shell es indispensable y su fallo ABORTA la instalación (ver arriba).
// Los assets pesados NO: precachearAssets() se traga sus errores a propósito, para
// que un CDN caído no impida instalar una versión nueva del shell — jsPDF se baja
// después, en el primer fetch que lo pida.
self.addEventListener('install', e => {
  e.waitUntil(precachearShell().then(() => precachearAssets()));
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
  e.waitUntil(self.clients.claim());
});

// La página sólo llega aquí después de guardar su captura. Mantener la caché
// anterior hasta CONFIRMAR_ARRANQUE permite recuperar recursos si el arranque falla.
self.addEventListener('message', e => {
  if(e.data?.type === 'ACTIVAR_ACTUALIZACION') self.skipWaiting();
  if(e.data?.type === 'CONFIRMAR_ARRANQUE') {
    e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => {
      if(k.startsWith(PREFIJO_ASSETS)) return k !== CACHE_ASSETS;
      return k.startsWith(PREFIJO) && k !== CACHE;
    }).map(k => caches.delete(k)))));
  }
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

  // version.js: RED PRIMERO, caché como fallback (2026-09-12).
  // Es el único archivo del shell que NO entra en el hash del CACHE --
  // build_deploy.py lo excluye a propósito porque lleva la hora del build, así que
  // incluirlo haría que el hash cambiara en cada corrida y nunca se estabilizara.
  // Servido caché-primero como el resto del shell, esa exclusión tenía una
  // consecuencia fea: un deploy que solo cambia version.js (mismo CACHE, sw.js
  // idéntico byte a byte -> el navegador no instala nada) era INVISIBLE en el
  // celular, y la pantalla "Act. software" seguía mostrando la fecha vieja para
  // siempre. O sea: justo la pantalla con la que se verifica si la actualización
  // llegó era la que no se podía actualizar -- de ahí el "no se actualiza desde
  // ayer a las 11 pm" con el service worker haciendo su trabajo bien.
  // Red primero lo arregla sin reintroducir la circularidad del hash. Se pide con
  // { cache: 'reload' } por la misma razón del punto 4 del checklist: sin eso,
  // GitHub Pages puede entregar la copia vieja de la caché HTTP del navegador.
  if (/\/version\.js(\?|$)/.test(url)) {
    e.respondWith(
      fetch(url, { cache: 'reload' })
        .then(r => {
          if (r.ok) {
            const clone = r.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone)).catch(()=>{});
          }
          return r;
        })
        // Sin señal: la última copia guardada. Si tampoco está, que falle el
        // fetch y no una excepción del SW -- version.js solo alimenta la etiqueta
        // de versión en pantalla, nunca un cálculo de dinero.
        .catch(() => caches.match(e.request).then(r => r || caches.match('./version.js')))
    );
    return;
  }

  // release.json decide si hay un worker nuevo; se consulta por red y sólo usa
  // una copia anterior como respaldo cuando no hay señal.
  if (/\/release\.json(\?|$)/.test(url)) {
    e.respondWith(
      fetch(url, { cache: 'reload' })
        .then(r => {
          if(r.ok) caches.open(CACHE).then(c => c.put(e.request, r.clone())).catch(()=>{});
          return r;
        })
        .catch(() => caches.match(e.request).then(r => r || caches.match('./release.json')))
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
