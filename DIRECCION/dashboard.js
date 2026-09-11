function _dineroDireccion(v) { return '$' + Number(v || 0).toFixed(2); }

// Propuesta 6 (mejoras ecosistema 2026-09-10): las prioridades que el ERP ya
// calcula (services/estrategia.py::centro_accion), reempaquetadas para el
// celular. Pura -- separada de renderDashboardDireccion para poder probarla
// con listas vacías/varias sin construir todo el snapshot.
function _htmlPrioridadesDireccion_(prioridades) {
  if (!prioridades || !prioridades.length) {
    return '<p class="sin-prioridades">Sin prioridades pendientes en este momento.</p>';
  }
  return '<ol class="prioridades">' + prioridades.map(p => `<li class="nivel-${p.nivel || 'info'}">
    <strong>${p.motivo}</strong>
    ${p.detalle ? `<span class="detalle">${p.detalle}</span>` : ''}
    <span class="pantalla">Resolver en: ${p.pantalla}</span>
  </li>`).join('') + '</ol>';
}

function renderDashboardDireccion(s) {
  if (!s) return '<h1>Resumen</h1><p class="text-muted">Aún no hay una fotografía oficial publicada por el ERP.</p>';
  const p = s.pendienteIntegrar || {};
  const fecha = String(s.generadoEn || '').replace('T', ' ');
  return `<h1>Resumen</h1>
<p class="oficial">Oficial al ${fecha}</p>
<section class="metricas">
  <article class="card"><div class="card-body">Ventas<strong class="num">${_dineroDireccion(s.ventas)}</strong></div></article>
  <article class="card"><div class="card-body">Cobrado<strong class="num">${_dineroDireccion(s.cobrado)}</strong></div></article>
  <article class="card"><div class="card-body">Utilidad neta<strong class="num">${_dineroDireccion(s.utilidadNeta)}</strong></div></article>
  <article class="card"><div class="card-body">Gastos<strong class="num">${_dineroDireccion(s.gastos)}</strong></div></article>
  <article class="card"><div class="card-body">Compras<strong class="num">${_dineroDireccion(s.compras)}</strong></div></article>
  <article class="card"><div class="card-body">Cartera<strong class="num">${_dineroDireccion(s.cartera)}</strong></div></article>
</section>
<section class="prioridades-erp">
  <h2>Qué necesita tu atención</h2>
  ${_htmlPrioridadesDireccion_(s.prioridades)}
</section>
<section class="pendientes card">
  <div class="card-body">
    <h2>Pendiente de integrar</h2>
    <p>${Number(p.compras || 0)} compras · ${Number(p.movimientos || 0)} movimientos · ${Number(p.cierres || 0)} cortes</p>
    <small>No se suman a las cifras oficiales.</small>
  </div>
</section>`;
}

// Ecosistema centralizado (2026-09): aplica DENOMINACIONES_MXN/PIN_TIMEOUT_MS
// si el ERP publicó algo válido -- nunca deja los globales en un estado raro
// (lista vacía, timeout en 0), eso congelaría el corte o la sesión.
function _aplicarConfigDireccionPublicada_(direccion) {
  if (!direccion) return;
  if (Array.isArray(direccion.denominaciones_mxn) && direccion.denominaciones_mxn.length) {
    DENOMINACIONES_MXN = direccion.denominaciones_mxn;
  }
  if (typeof direccion.pin_timeout_minutos === 'number' && direccion.pin_timeout_minutos > 0) {
    PIN_TIMEOUT_MS = direccion.pin_timeout_minutos * 60000;
  }
}

async function cargarDashboardDireccion(pin) {
  const url = localStorage.getItem('sumetec_direccion_url');
  const token = await abrirSesionDireccion(pin);
  const r = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ tipo: 'dashboard_snapshot', token })
  }).then(x => x.json());
  if (!r.ok) throw Error(r.error || 'No se pudo consultar el resumen');
  // Propuesta 3 (mejoras ecosistema 2026-09-10). Hasta el 2026-09-11 esto lo
  // leía compras.js para su historial reciente -- desde F3 (Compras salió
  // como app propia) ya no aplica: Compras pide su PROPIO dashboard_snapshot
  // (ver 18.- SUMETEC COMPRAS/compras.js::_actualizarSnapshotCompras_), otro
  // origen, otro localStorage. Se conserva el cacheo aquí por si algo más
  // dentro de Dirección lo llega a necesitar; hoy no lo lee nadie más.
  try {
    localStorage.setItem('sumetec_direccion_snapshot_cache',
      JSON.stringify({ ts: new Date().toISOString(), snapshot: r.snapshot }));
  } catch (_) {}
  // Best-effort, en paralelo, nunca bloquea ni rompe el resumen: la sección
  // DIRECCION del ecosistema centralizado (ver services/publicar.py del ERP).
  fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ tipo: 'configuracion', token })
  }).then(x => x.json()).then(rc => {
    if (rc && rc.ok && rc.datos) {
      localStorage.setItem('sumetec_direccion_config_cache', JSON.stringify({ ts: rc.ts || '', datos: rc.datos }));
      _aplicarConfigDireccionPublicada_(rc.datos.DIRECCION);
      if (typeof _aplicarConfigInventarioPublicada_ === 'function') _aplicarConfigInventarioPublicada_(rc.datos.GASTOS);
    }
  }).catch(() => {});
  return r.snapshot;
}

async function activarDashboardDireccion() {
  // Hallazgo 2026-09-10 (Miguel: "Escape cierra el diálogo de vinculación"):
  // no era ese diálogo -- este código pedía el PIN sin fijarse si YA había
  // un teléfono vinculado. La primera vez que se abre la app (o cualquier
  // vez sin sesión), #vincular y #pin-modal terminaban abiertos los dos a
  // la vez, compitiendo; #pin-modal SÍ es cancelable a propósito (uso
  // diario), así que Escape lo cerraba a él, no al de vinculación, dejando
  // "PIN cancelado" en Resumen y la falsa impresión de que el candado de
  // #vincular no servía. Sin sesión, no hay nada que consultar todavía.
  if (!localStorage.getItem(SESION_KEY)) {
    document.querySelector('#app').innerHTML =
      '<h1>Resumen</h1><p>Vincula este teléfono para ver el resumen.</p>';
    return;
  }
  try {
    const pin = await pedirPinDireccion();
    const s = await cargarDashboardDireccion(pin);
    // Mientras el PIN y la consulta estaban pendientes, la navegación
    // (vista()) permite entrar a Compras/Caja/Corte con normalidad. Si el
    // usuario ya no está en Resumen cuando esta respuesta tardía llega, no
    // hay que reemplazar #app -- perdería lo que esté a medio capturar ahí.
    if (typeof vistaActivaDireccion === 'function' && vistaActivaDireccion() !== 'resumen') return;
    document.querySelector('#app').innerHTML = renderDashboardDireccion(s);
  } catch (e) {
    if (typeof vistaActivaDireccion === 'function' && vistaActivaDireccion() !== 'resumen') return;
    document.querySelector('#app').innerHTML = `<h1>Resumen</h1><p>${e.message}</p>`;
  }
}
