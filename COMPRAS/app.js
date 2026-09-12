// Compras -- app propia (F3 del plan de diseño, 2026-09-11). Una sola
// pantalla (no hay nav ni vista() como en Dirección): vincular, capturar,
// enviar. Copiado y recortado de 14.- SUMETEC DIRECCION/app.js.

function estado() {
  const pendientes = leer(COLAS.compras).length;
  $('#estado').textContent = pendientes
    ? `${pendientes} pendientes`
    : (navigator.onLine ? 'Al día' : 'Sin conexión');
}

async function vincular() {
  const url = $('#url').value.trim();
  const codigo = $('#codigo').value.trim();
  const pin = $('#pin').value;
  if (!url || !codigo || pin.length < 4) return;

  const dispositivo = localStorage.getItem('sumetec_compras_dispositivo') || crypto.randomUUID();
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
  localStorage.setItem('sumetec_compras_dispositivo', dispositivo);
  localStorage.setItem('sumetec_compras_url', url);
  $('#vincular').close();
  estado();
  _actualizarSnapshotCompras_(pin).catch(() => {});
}

function iniciar() {
  $('#app').innerHTML = formularioComprasDireccion();
  activarComprasDireccion();
}
iniciar();
estado();

$('#enlazar').onclick = e => { e.preventDefault(); vincular().catch(x => alert(x.message)); };
window.addEventListener('online', estado);
window.addEventListener('offline', estado);

// Mismo candado que Dirección (hallazgo 2026-09-10/11): el diálogo de
// vinculación no se puede descartar con Escape/atrás sin vincular de
// verdad -- ver el comentario largo en 14.- SUMETEC DIRECCION/app.js.
$('#vincular').addEventListener('cancel', e => e.preventDefault());
new MutationObserver(() => {
  if (!$('#vincular').open && !localStorage.getItem(SESION_KEY)) $('#vincular').showModal();
}).observe($('#vincular'), { attributes: true, attributeFilter: ['open'] });
if (!localStorage.getItem(SESION_KEY)) {
  $('#vincular').showModal();
} else {
  // Ya vinculado de antes: refresca el historial reciente en cuanto haya
  // sesión, sin esperar a que el usuario toque nada -- pide el PIN una sola
  // vez (pedirPinDireccion lo cachea) y si lo cancela, el historial se
  // queda con lo que ya había en caché (best-effort, no bloquea la pantalla).
  pedirPinDireccion().then(pin => _actualizarSnapshotCompras_(pin)).catch(() => {});
}

// Registro + actualización activa del service worker -- mismo patrón que
// Dirección/Gastos/Cotizador.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then(registro => {
    const revisar = () => registro.update().catch(() => {});
    setInterval(revisar, 5 * 60 * 1000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') revisar();
    });
    window.addEventListener('online', revisar);
  });

  let huboControlador = !!navigator.serviceWorker.controller;
  let recargaPendiente = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!huboControlador) { huboControlador = true; return; }
    localStorage.setItem('compras_ultima_actualizacion', String(Date.now()));
    if (hayTrabajoSinGuardarCompras()) { recargaPendiente = true; return; }
    window.location.reload();
  });
  document.addEventListener('visibilitychange', () => {
    if (!recargaPendiente || document.visibilityState !== 'hidden') return;
    if (hayTrabajoSinGuardarCompras()) return;
    window.location.reload();
  });
}

// VERSION_DEPLOY y VERSION_CODIGO vienen de version.js (los escribe
// build_deploy.py en cada corrida). Mismo patrón que Dirección/Gastos/Cotizador.
function _mostrarVersionInstalada() {
  const codigo = (typeof VERSION_CODIGO !== 'undefined' && VERSION_CODIGO) ? VERSION_CODIGO : null;
  const v = (typeof VERSION_DEPLOY !== 'undefined' && VERSION_DEPLOY)
    ? new Date(VERSION_DEPLOY).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' })
    : 'Sin información';
  const ultima = Number(localStorage.getItem('compras_ultima_actualizacion') || 0);
  const u = ultima
    ? new Date(ultima).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' })
    : 'Aún no se ha detectado una actualización nueva en este dispositivo.';
  alert(`Act. software: ${codigo ? codigo + ' · ' : ''}${v}\nÚltima actualización: ${u}`);
}

function hayTrabajoSinGuardarCompras() {
  const activo = document.activeElement;
  if (activo && (activo.tagName === 'INPUT' || activo.tagName === 'TEXTAREA') && activo.value) {
    return true;
  }
  const form = document.querySelector('#app form');
  if (!form) return false;
  return [...form.elements].some(el => (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.value);
}
