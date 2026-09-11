const COLAS = {
  compras: 'sumetec_direccion_cola_compras',
  movimientos: 'sumetec_direccion_cola_movimientos',
  cortes: 'sumetec_direccion_cola_cortes'
};

const $ = s => document.querySelector(s);
const leer = k => JSON.parse(localStorage.getItem(k) || '[]');

function estado() {
  const pendientes = Object.values(COLAS).reduce((total, k) => total + leer(k).length, 0);
  $('#estado').textContent = pendientes
    ? `${pendientes} pendientes`
    : (navigator.onLine ? 'Al día' : 'Sin conexión');
}

// Sección visible ahora mismo (hallazgo DIR-02, 2026-09-09). El resumen pide
// datos al servidor de forma asíncrona; si el usuario ya navegó a otra
// pantalla cuando la respuesta llega, esa respuesta tardía no debe pisar lo
// que haya en #app (un formulario de compra a medio llenar, por ejemplo).
let _vistaActivaDireccion = null;
function vistaActivaDireccion() { return _vistaActivaDireccion; }

function vista(nombre) {
  _vistaActivaDireccion = nombre;
  const vistas = {
    caja: formularioCajaDireccion,
    corte: formularioCorteDireccion,
    compras: formularioComprasDireccion,
    resumen: () => '<h1>Resumen</h1><p>Cargando fotografía oficial…</p>'
  };
  const generador = vistas[nombre];
  $('#app').innerHTML = generador
    ? generador()
    : `<h1>${nombre[0].toUpperCase() + nombre.slice(1)}</h1><p></p>`;

  if (nombre === 'caja') activarCajaDireccion();
  if (nombre === 'corte') activarCorteDireccion();
  if (nombre === 'compras') activarComprasDireccion();
  if (nombre === 'resumen') activarDashboardDireccion();
}

async function vincular() {
  const url = $('#url').value.trim();
  const codigo = $('#codigo').value.trim();
  const pin = $('#pin').value;
  if (!url || !codigo || pin.length < 4) return;

  const dispositivo = localStorage.getItem('sumetec_direccion_dispositivo') || crypto.randomUUID();
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({
      tipo: 'vincular_dispositivo', codigo, dispositivo,
      nombre: navigator.userAgent.slice(0, 60)
    })
  }).then(x => x.json());
  if (!r.ok) throw Error(r.error);

  await guardarSesionDireccion(pin, r.token);
  localStorage.setItem('sumetec_direccion_dispositivo', dispositivo);
  localStorage.setItem('sumetec_direccion_url', url);
  $('#vincular').close();
  estado();
}

// Ecosistema centralizado (2026-09): aplica lo cacheado de la ÚLTIMA vez
// (antes de pedir el PIN) para que Corte no arranque con denominaciones
// viejas si el ERP publicó algo distinto en la sesión anterior. Sin caché
// aún (primera vez), sigue con los valores de fábrica de corte.js/seguridad.js.
try {
  const cacheCfg = JSON.parse(localStorage.getItem('sumetec_direccion_config_cache') || 'null');
  if (cacheCfg && cacheCfg.datos) _aplicarConfigDireccionPublicada_(cacheCfg.datos.DIRECCION);
} catch (_) {}

document.querySelectorAll('[data-vista]').forEach(b => b.onclick = () => vista(b.dataset.vista));
$('#enlazar').onclick = e => { e.preventDefault(); vincular().catch(x => alert(x.message)); };
window.addEventListener('online', estado);
window.addEventListener('offline', estado);
vista('resumen');
estado();
// Hallazgo 2026-09-10 (Miguel: "me dijo código incorrecto pero me dejó
// pasar"): <dialog> se cierra solo con Escape o el botón atrás de Android
// (evento nativo 'cancel'), y como #app ya tiene la pantalla de Resumen
// dibujada DETRÁS de este modal (vista('resumen') corrió arriba), cerrarlo
// así -- sin que vincular() haya tenido éxito -- deja ver la app entera sin
// ninguna sesión ni token guardado. Parece que "ya funcionó" y no vinculó
// nada. Bloqueado aquí: mientras no haya sesión, este diálogo no se puede
// descartar sin completar la vinculación de verdad.
$('#vincular').addEventListener('cancel', e => e.preventDefault());
// Segundo candado, y el que de verdad aguanta (2026-09-11, probado contra
// el sitio real): el preventDefault de arriba NO siempre se respeta.
// Chrome tiene una regla anti-abuso (CloseWatcher) por la que un diálogo
// abierto SIN que el usuario haya interactuado todavía con la página --
// justo este caso, se abre solo al cargar -- no puede bloquear el Escape,
// y se cierra aunque 'cancel' esté cancelado.
//
// Se vigila el atributo `open` del <dialog>, NO el evento 'close': medido
// en el navegador real, ese evento no llega de forma confiable cuando el
// cierre lo fuerza el navegador, así que un listener de 'close' dejaba el
// hueco abierto igual. El atributo sí cambia siempre, se cierre como se
// cierre (Escape, botón atrás de Android, o lo que venga después).
//
// Al vincular con éxito, vincular() guarda la sesión ANTES de llamar
// close(), así que aquí ya hay sesión y el diálogo se queda cerrado.
new MutationObserver(() => {
  if (!$('#vincular').open && !localStorage.getItem(SESION_KEY)) $('#vincular').showModal();
}).observe($('#vincular'), { attributes: true, attributeFilter: ['open'] });
if (!localStorage.getItem(SESION_KEY)) $('#vincular').showModal();

// Registro + actualización activa: el navegador por su cuenta solo revisa
// sw.js por HTTP cada ~24h, y esta PWA se abre desde el ícono de inicio
// (retomada de segundo plano) casi siempre -- sin esto, un bug corregido en
// el corte de caja podría tardar días en llegar al teléfono.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then(registro => {
    const revisar = () => registro.update().catch(() => {});
    setInterval(revisar, 5 * 60 * 1000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') revisar();
    });
    window.addEventListener('online', revisar);
  });

  // Cuando el SW nuevo toma control, recarga -- salvo que haya algo sin
  // enviar (una compra a medio capturar, un corte a medio contar): en ese
  // caso se difiere hasta que la app vuelva a estar inactiva.
  // huboControlador: el primer controllerchange (instalación inicial, sin SW
  // previo) no es una "actualización" -- no se registra como tal, mismo
  // patrón que 12.- GASTOS E INVENTARIO/gastos-inventario.html.
  let huboControlador = !!navigator.serviceWorker.controller;
  let recargaPendiente = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!huboControlador) { huboControlador = true; return; }
    localStorage.setItem('direccion_ultima_actualizacion', String(Date.now()));
    if (hayTrabajoSinGuardarDireccion()) { recargaPendiente = true; return; }
    window.location.reload();
  });
  document.addEventListener('visibilitychange', () => {
    if (!recargaPendiente || document.visibilityState !== 'hidden') return;
    // Hallazgo DIR-03 (2026-09-09): esto recargaba sin volver a comprobar si
    // seguía habiendo trabajo sin guardar. La protección de arriba solo mira
    // el momento en que llegó la actualización -- si el usuario terminó esa
    // captura y empezó una NUEVA antes de pasar la app a segundo plano (o
    // solo cambió a otra pantalla a medio llenar), esa captura se perdía
    // igual. Se vuelve a comprobar aquí, justo antes de recargar de verdad;
    // si sigue habiendo algo sin guardar, se queda pendiente y se reintenta
    // en el próximo cambio de visibilidad (el listener sigue vivo).
    if (hayTrabajoSinGuardarDireccion()) return;
    window.location.reload();
  });
}

// VERSION_DEPLOY y VERSION_CODIGO vienen de version.js (los escribe
// build_deploy.py en cada corrida): la hora real del build y el mismo hash
// que sw.js usa como nombre de caché ('sumetec-direccion-<código>'). "Última
// actualización" es la última vez que un service worker NUEVO tomó control
// en ESTE dispositivo -- si nunca ha habido una, se avisa en vez de mentir.
// Mismo patrón que 2.- COTIZADOR/remision.html y 12.- GASTOS E INVENTARIO.
function _mostrarVersionInstalada() {
  const codigo = (typeof VERSION_CODIGO !== 'undefined' && VERSION_CODIGO) ? VERSION_CODIGO : null;
  const v = (typeof VERSION_DEPLOY !== 'undefined' && VERSION_DEPLOY)
    ? new Date(VERSION_DEPLOY).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' })
    : 'Sin información';
  const ultima = Number(localStorage.getItem('direccion_ultima_actualizacion') || 0);
  const u = ultima
    ? new Date(ultima).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' })
    : 'Aún no se ha detectado una actualización nueva en este dispositivo.';
  alert(`Act. software: ${codigo ? codigo + ' · ' : ''}${v}\nÚltima actualización: ${u}`);
}

function hayTrabajoSinGuardarDireccion() {
  const activo = document.activeElement;
  if (activo && (activo.tagName === 'INPUT' || activo.tagName === 'TEXTAREA') && activo.value) {
    return true;
  }
  const form = document.querySelector('#app form');
  if (!form) return false;
  return [...form.elements].some(el => (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.value);
}
