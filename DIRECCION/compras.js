// Mismo vocabulario que el ERP (routers/compras.py, routers/gastos.py): la
// evidencia describe el documento, "situacionFactura" si ya se facturó -- son
// dos preguntas distintas (§2.3 del plan: "factura es evidencia, no tipo de
// movimiento").
const SITUACIONES_FACTURA_DIRECCION = ['ESPERANDO_FACTURA', 'FACTURADO', 'NO_SE_FACTURARA'];
const EVIDENCIAS_COMPRA_DIRECCION = ['TICKET', 'CFDI', 'FOTO', 'OTRO'];

function nuevaCompraCampo(datos) {
  const id = datos.id || crypto.randomUUID();
  const total = Number(datos.total || 0);
  const pagos = datos.pagos || [];
  if (!datos.proveedor || !datos.fecha || total <= 0) throw Error('Faltan proveedor, fecha o total');

  const suma = pagos.reduce((a, p) => a + Number(p.monto || 0), 0);
  if (suma > total + 0.005) throw Error('Los pagos superan el total');
  if (datos.condicion === 'CONTADO' && Math.abs(suma - total) > 0.005) {
    throw Error('Una compra de contado debe quedar liquidada');
  }
  if (datos.situacionFactura === 'FACTURADO' && !String(datos.uuidCfdi || '').trim()) {
    throw Error('Un documento facturado requiere el UUID del CFDI');
  }

  const compra = {
    ...datos, id,
    situacionFactura: datos.situacionFactura || 'ESPERANDO_FACTURA',
    estado: 'PENDIENTE_ERP'
  };
  const cola = leer(COLAS.compras);
  if (!cola.some(x => x.id === id)) cola.push(compra);
  localStorage.setItem(COLAS.compras, JSON.stringify(cola));
  estado();
  return id;
}

// Propuesta 3 (mejoras ecosistema 2026-09-10): recibo local de cada envío
// confirmado -- es lo que permite al celular mostrar "enviada, esperando
// revisión" ANTES de que exista otra fuente de verdad (el snapshot del ERP,
// que puede tardar en publicarse). Acotado a las últimas
// MAX_HISTORIAL_COMPRAS: es un historial reciente, no un archivo completo.
const CLAVE_HISTORIAL_COMPRAS = 'sumetec_direccion_historial_compras';
const MAX_HISTORIAL_COMPRAS = 30;

function _registrarEnvioCompras_(compras) {
  if (!compras || !compras.length) return;
  const historial = leer(CLAVE_HISTORIAL_COMPRAS);
  const ahora = new Date().toISOString();
  compras.forEach(c => {
    const entrada = { id: c.id, proveedor: c.proveedor || '', total: Number(c.total || 0), fechaEnvio: ahora };
    const idx = historial.findIndex(h => h.id === c.id);
    if (idx >= 0) historial.splice(idx, 1);
    historial.unshift(entrada);
  });
  localStorage.setItem(CLAVE_HISTORIAL_COMPRAS, JSON.stringify(historial.slice(0, MAX_HISTORIAL_COMPRAS)));
}

async function enviarComprasCampo(pin) {
  const url = localStorage.getItem('sumetec_direccion_url');
  if (!url) throw Error('Vincula el teléfono primero');
  const token = await abrirSesionDireccion(pin);
  const cola = leer(COLAS.compras);
  const idsEnviados = [];
  const enviadasOk = [];

  for (const compra of cola) {
    const r = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ ...compra, tipo: 'compra_campo', token })
    }).then(x => x.json());
    if (r.ok && (r.estado === 'CREADO' || r.estado === 'YA_EXISTIA')) {
      idsEnviados.push(compra.id);
      enviadasOk.push(compra);
    }
  }

  // No sobrescribir con la foto de `cola`: mientras el envío estaba en curso
  // (fetch por compra, uno por uno) se pudo haber guardado una compra nueva
  // con nuevaCompraCampo(). Se vuelve a leer la cola vigente y solo se quitan
  // los ids que de verdad se confirmaron -- así no se pierde lo que se
  // capturó a medio envío (H-01, hallazgo 2026-09-09).
  const colaVigente = leer(COLAS.compras);
  const pendientes = colaVigente.filter(c => idsEnviados.indexOf(c.id) === -1);
  localStorage.setItem(COLAS.compras, JSON.stringify(pendientes));
  _registrarEnvioCompras_(enviadasOk);
  estado();
  return pendientes.length;
}

// ── Historial reciente (propuesta 3) ────────────────────────────────────
// Tres estados posibles por compra: PENDIENTE_ENVIO (sigue en la cola local,
// nunca tocó el servidor), ESPERANDO_REVISION (se mandó -- hay recibo local
// -- pero la última fotografía del ERP no la reporta IMPORTADO, o no hay
// fotografía todavía) e IMPORTADO (el snapshot SÍ la reporta integrada).
// Puro y testable: recibe la cola, el historial y el caché de snapshot ya
// leídos, no toca localStorage ni el DOM.
function _historialComprasDireccion_(cola, historialEnviadas, snapshotCache) {
  const recientesERP = (snapshotCache && snapshotCache.snapshot && snapshotCache.snapshot.comprasRecientes) || [];
  const porId = new Map(recientesERP.map(r => [r.id, r]));
  const snapshotTs = snapshotCache ? snapshotCache.ts : '';

  const pendientes = (cola || []).map(c => ({
    id: c.id, proveedor: c.proveedor || '', total: Number(c.total || 0),
    estado: 'PENDIENTE_ENVIO', fecha: '', snapshotTs: '',
  }));

  const enviadas = (historialEnviadas || []).map(h => {
    const erp = porId.get(h.id);
    return {
      id: h.id, proveedor: h.proveedor || '', total: Number(h.total || 0),
      estado: erp ? erp.estado : 'ESPERANDO_REVISION',
      fecha: erp ? erp.actualizadoEn : h.fechaEnvio,
      snapshotTs,
    };
  });

  return pendientes.concat(enviadas);
}

function _badgeEstadoCompraDireccion_(estado) {
  if (estado === 'PENDIENTE_ENVIO') return '⏳ Pendiente de envío';
  if (estado === 'IMPORTADO') return '✅ Integrada en el ERP';
  return '📨 Enviada, esperando revisión';
}

function _htmlHistorialComprasDireccion_(items) {
  if (!items.length) return '<p class="vacio">Sin compras recientes.</p>';
  const filas = items.map(it => `<li class="historial-item">
    <span class="proveedor">${it.proveedor || '(sin proveedor)'}</span>
    <span class="total">$${it.total.toFixed(2)}</span>
    <span class="badge">${_badgeEstadoCompraDireccion_(it.estado)}</span>
    ${it.fecha ? `<small class="fecha">${String(it.fecha).replace('T', ' ')}</small>` : ''}
  </li>`).join('');
  // La leyenda dice explícitamente de cuándo es el estado del ERP -- nunca se
  // presenta como "así está ahora mismo" si el snapshot ya lleva rato viejo.
  const primeraConTs = items.find(it => it.snapshotTs);
  const leyenda = primeraConTs
    ? `<p class="leyenda">Estado del ERP según el último resumen (${String(primeraConTs.snapshotTs).replace('T', ' ')}).</p>`
    : '<p class="leyenda">Aún no se ha consultado el Resumen en este teléfono -- abre esa pestaña para ver el estado del ERP.</p>';
  return leyenda + `<ul class="historial-compras">${filas}</ul>`;
}

function _leerSnapshotCacheDireccion_() {
  try { return JSON.parse(localStorage.getItem('sumetec_direccion_snapshot_cache') || 'null'); }
  catch (_) { return null; }
}

function _renderHistorialComprasDireccion_() {
  const el = document.querySelector('#historial-compras');
  if (!el) return;
  const items = _historialComprasDireccion_(leer(COLAS.compras), leer(CLAVE_HISTORIAL_COMPRAS), _leerSnapshotCacheDireccion_());
  el.innerHTML = _htmlHistorialComprasDireccion_(items);
}

function _filaLineaCompra() {
  return `<li class="linea">
    <input placeholder="Código" class="codigo">
    <input placeholder="Descripción" class="descripcion">
    <input placeholder="Cantidad" type="number" min="0" step="0.01" class="cantidad">
    <input placeholder="Costo unitario" type="number" min="0" step="0.01" class="costo">
    <button type="button" class="quitar">Quitar</button>
  </li>`;
}

function _filaPagoCompra() {
  return `<li class="pago">
    <input placeholder="Fecha" type="date" class="fecha">
    <input placeholder="Monto" type="number" min="0.01" step="0.01" class="monto">
    <select class="metodo"><option>EFECTIVO</option><option>TRANSFERENCIA</option><option>TARJETA</option><option>CHEQUE</option></select>
    <button type="button" class="quitar">Quitar</button>
  </li>`;
}

function _leerLineasCompra(ul) {
  return [...ul.querySelectorAll('li.linea')].map(li => ({
    codigo: li.querySelector('.codigo').value.trim(),
    descripcion: li.querySelector('.descripcion').value.trim(),
    cantidad: Number(li.querySelector('.cantidad').value) || 0,
    costoUnitario: Number(li.querySelector('.costo').value) || 0
  })).filter(l => l.codigo || l.descripcion);
}

function _leerPagosCompra(ul) {
  return [...ul.querySelectorAll('li.pago')].map(li => ({
    id: crypto.randomUUID(),
    fecha: li.querySelector('.fecha').value,
    monto: Number(li.querySelector('.monto').value) || 0,
    metodo: li.querySelector('.metodo').value
  })).filter(p => p.monto > 0);
}

function formularioComprasDireccion() {
  return `<h1>Compras</h1>
<p>Queda "Pendiente de ERP" hasta que se revise e importe -- no mueve el stock teórico.</p>
<form id="form-compra">
  <label>Proveedor<input name="proveedor" required></label>
  <label>Fecha<input name="fecha" type="date" required></label>
  <label>Folio del proveedor<input name="folio"></label>
  <label>Evidencia
    <select name="evidencia">${EVIDENCIAS_COMPRA_DIRECCION.map(x => `<option>${x}</option>`).join('')}</select>
  </label>
  <label>Situación de factura
    <select name="situacionFactura">${SITUACIONES_FACTURA_DIRECCION.map(x => `<option>${x}</option>`).join('')}</select>
  </label>
  <label>UUID CFDI (si ya está facturado)<input name="uuidCfdi"></label>
  <label>Subtotal<input name="subtotal" type="number" min="0" step="0.01" required></label>
  <label>IVA<input name="iva" type="number" min="0" step="0.01" value="0"></label>
  <label>Total<input name="total" type="number" min="0.01" step="0.01" required></label>
  <label>Condición<select name="condicion"><option>CREDITO</option><option>CONTADO</option></select></label>
  <fieldset>
    <legend>Líneas (opcional, se revisan en el ERP)</legend>
    <ul id="lineas-compra"></ul>
    <button type="button" id="agregar-linea">Agregar línea</button>
  </fieldset>
  <fieldset>
    <legend>Pagos (si ya se pagó algo desde el cajón)</legend>
    <ul id="pagos-compra"></ul>
    <button type="button" id="agregar-pago">Agregar pago</button>
  </fieldset>
  <button>Guardar compra</button>
</form>
<p id="resultado-compra" role="status"></p>
<button id="enviar-compras" type="button">Enviar compras pendientes</button>
<section aria-label="Historial reciente de compras">
  <h2>Historial reciente</h2>
  <div id="historial-compras"></div>
</section>`;
}

function activarComprasDireccion() {
  const f = document.querySelector('#form-compra');
  if (!f) return;
  f.fecha.value = _fechaLocalDireccion_();
  _renderHistorialComprasDireccion_();

  const lineas = document.querySelector('#lineas-compra');
  const pagos = document.querySelector('#pagos-compra');
  const quitar = e => { if (e.target.classList.contains('quitar')) e.target.closest('li').remove(); };

  document.querySelector('#agregar-linea').onclick = () => lineas.insertAdjacentHTML('beforeend', _filaLineaCompra());
  document.querySelector('#agregar-pago').onclick = () => pagos.insertAdjacentHTML('beforeend', _filaPagoCompra());
  lineas.onclick = quitar;
  pagos.onclick = quitar;

  f.subtotal.oninput = f.iva.oninput = () => {
    f.total.value = (Number(f.subtotal.value || 0) + Number(f.iva.value || 0)).toFixed(2);
  };

  f.onsubmit = e => {
    e.preventDefault();
    try {
      const d = Object.fromEntries(new FormData(f));
      d.lineas = _leerLineasCompra(lineas);
      d.pagos = _leerPagosCompra(pagos);
      nuevaCompraCampo(d);
      document.querySelector('#resultado-compra').textContent =
        'Compra guardada. Se enviará al vincular conexión, o pulsa "Enviar compras pendientes".';
      f.reset();
      f.fecha.value = _fechaLocalDireccion_();
      lineas.innerHTML = '';
      pagos.innerHTML = '';
      _renderHistorialComprasDireccion_();
    } catch (err) {
      document.querySelector('#resultado-compra').textContent = err.message;
    }
  };

  document.querySelector('#enviar-compras').onclick = async () => {
    try {
      const pin = await pedirPinDireccion();
      const n = await enviarComprasCampo(pin);
      document.querySelector('#resultado-compra').textContent = n
        ? `${n} compra(s) siguen pendientes de enviar.`
        : 'Todas las compras en cola se enviaron.';
      _renderHistorialComprasDireccion_();
    } catch (err) {
      document.querySelector('#resultado-compra').textContent = err.message;
    }
  };
}
