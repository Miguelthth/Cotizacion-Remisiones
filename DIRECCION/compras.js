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
    <input placeholder="Código" class="codigo form-control mono">
    <input placeholder="Descripción" class="descripcion form-control">
    <input placeholder="Cantidad" type="number" min="0" step="0.01" class="cantidad form-control">
    <input placeholder="Costo unitario" type="number" min="0" step="0.01" class="costo form-control">
    <button type="button" class="quitar btn btn-outline-secondary"><i class="bi bi-x-lg"></i></button>
  </li>`;
}

function _filaPagoCompra() {
  return `<li class="pago">
    <input placeholder="Fecha" type="date" class="fecha form-control">
    <input placeholder="Monto" type="number" min="0.01" step="0.01" class="monto form-control">
    <select class="metodo form-select"><option>EFECTIVO</option><option>TRANSFERENCIA</option><option>TARJETA</option><option>CHEQUE</option></select>
    <button type="button" class="quitar btn btn-outline-secondary"><i class="bi bi-x-lg"></i></button>
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
<p class="text-muted">Queda "Pendiente de ERP" hasta que se revise e importe -- no mueve el stock teórico.</p>
<form id="form-compra" class="card"><div class="card-body" style="display:grid;gap:10px">
  <label class="form-label" for="compra-proveedor">Proveedor<input id="compra-proveedor" class="form-control" name="proveedor" required></label>
  <label class="form-label" for="compra-fecha">Fecha<input id="compra-fecha" class="form-control" name="fecha" type="date" required></label>
  <label class="form-label" for="compra-folio">Folio del proveedor<input id="compra-folio" class="form-control mono" name="folio"></label>

  <label class="form-label" for="compra_foto"><i class="bi bi-camera"></i> Foto del ticket (opcional)<input type="file" id="compra_foto" class="form-control" accept="image/*" capture="environment" onchange="_onFotoCompraElegida_()"></label>
  <img id="compraFotoPreview" style="display:none;max-height:160px;border-radius:var(--sm-r-sm);margin-top:8px;object-fit:contain">
  <!-- Sin ícono: _onFotoCompraElegida_/_leerTicketCompraConIA_ (abajo) fijan
       el texto completo del botón con .textContent -- un ícono aquí
       desaparecería en cuanto cualquiera de esas dos lo tocara. -->
  <button id="compraBtnOcr" type="button" class="btn btn-primary" style="width:100%;margin-top:8px;display:none" onclick="_leerTicketCompraConIA_()">🔍 Leer ticket</button>
  <div id="compraOcrEstado" class="text-muted" style="font-size:12px;margin-top:4px"></div>

  <label class="form-label" for="compra-evidencia">Evidencia
    <select id="compra-evidencia" name="evidencia" class="form-select">${EVIDENCIAS_COMPRA_DIRECCION.map(x => `<option>${x}</option>`).join('')}</select>
  </label>
  <label class="form-label" for="compra-situacion">Situación de factura
    <select id="compra-situacion" name="situacionFactura" class="form-select">${SITUACIONES_FACTURA_DIRECCION.map(x => `<option>${x}</option>`).join('')}</select>
  </label>
  <label class="form-label" for="compra-uuid">UUID CFDI (si ya está facturado)<input id="compra-uuid" class="form-control mono" name="uuidCfdi"></label>
  <label class="form-label" for="compra-subtotal">Subtotal<input id="compra-subtotal" class="form-control" name="subtotal" type="number" min="0" step="0.01" required></label>
  <label class="form-label" for="compra-iva">IVA<input id="compra-iva" class="form-control" name="iva" type="number" min="0" step="0.01" value="0"></label>
  <label class="form-label" for="compra-total">Total<input id="compra-total" class="form-control" name="total" type="number" min="0.01" step="0.01" required></label>
  <label class="form-label" for="compra-condicion">Condición<select id="compra-condicion" name="condicion" class="form-select"><option>CREDITO</option><option>CONTADO</option></select></label>
  <fieldset>
    <legend class="form-label">Líneas (opcional, se revisan en el ERP)</legend>
    <ul id="lineas-compra"></ul>
    <button type="button" id="agregar-linea" class="btn btn-outline-secondary"><i class="bi bi-plus-lg"></i> Agregar línea</button>
  </fieldset>
  <fieldset>
    <legend class="form-label">Pagos (si ya se pagó algo desde el cajón)</legend>
    <ul id="pagos-compra"></ul>
    <button type="button" id="agregar-pago" class="btn btn-outline-secondary"><i class="bi bi-plus-lg"></i> Agregar pago</button>
  </fieldset>
  <button class="btn btn-success btn-bloque"><i class="bi bi-check-circle"></i> Guardar compra</button>
</div></form>
<p id="resultado-compra" class="text-muted" role="status"></p>
<button id="enviar-compras" type="button" class="btn btn-primary btn-bloque"><i class="bi bi-cloud-arrow-up"></i> Enviar compras pendientes</button>
<section aria-label="Historial reciente de compras" class="card"><div class="card-body">
  <h2>Historial reciente</h2>
  <div id="historial-compras"></div>
</div></section>`;
}

function activarComprasDireccion() {
  const f = document.querySelector('#form-compra');
  if (!f) return;
  f.fecha.value = _fechaLocalDireccion_();
  _renderHistorialComprasDireccion_();

  const lineas = document.querySelector('#lineas-compra');
  const pagos = document.querySelector('#pagos-compra');
  // closest('.quitar'), no e.target.classList: el botón ahora lleva un ícono
  // adentro (<i class="bi ...">) -- un toque justo sobre el ícono pone el
  // ícono como e.target, no el botón, y classList.contains('quitar') fallaba.
  const quitar = e => { const b = e.target.closest('.quitar'); if (b) b.closest('li').remove(); };

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
      // La foto ya viaja comprimida (_comprimirImagenCompra_, cacheada al
      // elegirla o al leerla con IA) -- nunca se manda el File crudo del
      // input, que FormData habría ignorado de todos modos por no tener
      // atributo `name`.
      if (_compraFotoComprimidaB64) d.foto = _compraFotoComprimidaB64;
      nuevaCompraCampo(d);
      document.querySelector('#resultado-compra').textContent =
        'Compra guardada. Se enviará al vincular conexión, o pulsa "Enviar compras pendientes".';
      f.reset();
      f.fecha.value = _fechaLocalDireccion_();
      lineas.innerHTML = '';
      pagos.innerHTML = '';
      _resetFotoCompra_();
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

// ── OCR de tickets en Dirección (2026-09-10, estandarizado con Gastos) ───────
// Mismo patrón exacto que gastos-inventario.html: botón EXPLÍCITO, nunca
// automático ni dentro del guardado/reintento -- cada reintento offline
// volvería a cobrar la lectura de la imagen. El handler del lado del Apps
// Script (tipo:'ocr_ticket') ya existía y ya estaba en _LECTURAS (no pesa
// sobre el lock de escritura de remisiones/pagos); solo faltaba el permiso
// del token de Dirección (_TIPOS_DIRECCION_, apps_script.js) y este frente.
const FOTO_TOPE_KB_COMPRA = 250;
let _compraTocadaPorOcr = false;
let _compraFotoComprimidaB64 = ''; // cache: evita comprimir 2 veces (preview + OCR)

function _leerArchivoComoB64Compra_(file) {
  return new Promise((resolve) => {
    if (!file) { resolve(''); return; }
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
    reader.onerror = () => resolve('');
    reader.readAsDataURL(file);
  });
}

function _escalarLadoCompra_(ancho, alto, maxLado) {
  const mayor = Math.max(ancho, alto);
  if (mayor <= maxLado) return { w: ancho, h: alto }; // nunca agrandar
  const factor = maxLado / mayor;
  return { w: Math.round(ancho * factor), h: Math.round(alto * factor) };
}

function _exportarConCalidadDecrecienteCompra_(canvas, calidadInicial) {
  const TOPE_BYTES = FOTO_TOPE_KB_COMPRA * 1024;
  const PISO_CALIDAD = 0.45;
  return new Promise((resolve, reject) => {
    const intentar = (q) => {
      canvas.toBlob((blob) => {
        if (!blob) { reject(new Error('toBlob vacío')); return; }
        if (blob.size > TOPE_BYTES && q > PISO_CALIDAD) {
          intentar(Math.max(PISO_CALIDAD, +(q - 0.1).toFixed(2)));
          return;
        }
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
        reader.onerror = () => reject(new Error('FileReader falló'));
        reader.readAsDataURL(blob);
      }, 'image/jpeg', q);
    };
    intentar(calidadInicial);
  });
}

function _comprimirImagenCompra_(file, maxLado, calidad) {
  maxLado = maxLado || 1600;
  calidad = calidad || 0.72;
  return new Promise((resolve) => {
    if (!file) { resolve(''); return; }
    const fallback = () => _leerArchivoComoB64Compra_(file).then(resolve);
    try {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        try {
          const { w, h } = _escalarLadoCompra_(img.naturalWidth || img.width, img.naturalHeight || img.height, maxLado);
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          URL.revokeObjectURL(url);
          _exportarConCalidadDecrecienteCompra_(canvas, calidad).then(resolve).catch(fallback);
        } catch (e) { URL.revokeObjectURL(url); fallback(); }
      };
      img.onerror = () => { URL.revokeObjectURL(url); fallback(); };
      img.src = url;
    } catch (e) { fallback(); }
  });
}

function _parsearFechaOcrCompra_(str) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(str || '').trim());
  if (!m) return null;
  const dd = +m[1], mm = +m[2], yyyy = +m[3];
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const p = n => String(n).padStart(2, '0');
  return `${yyyy}-${p(mm)}-${p(dd)}`;
}

// Traduce la respuesta del OCR a qué llenar en el formulario -- función pura
// (sin tocar el DOM), mismo criterio que _aplicarOcrAGasto_ de Gastos. Nunca
// lanza; ante cualquier duda, { aplicado:false } y el formulario se queda
// como estaba (captura manual).
function _aplicarOcrACompra_(resp) {
  const NADA = { aplicado: false };
  if (!resp || resp.ok !== true || !resp.campos) return NADA;
  if (resp.confianza == null || resp.confianza < 50) return NADA;
  const c = resp.campos;
  const total = Number(c.total);
  if (!(total > 0)) return NADA;
  const out = { aplicado: true, proveedor: String(c.proveedor || '').trim(), fecha: null, total };
  const fechaOk = _parsearFechaOcrCompra_(c.fecha);
  if (fechaOk && fechaOk <= _fechaLocalDireccion_()) out.fecha = fechaOk;
  const iva = Number(c.iva);
  const subtotal = Number(c.subtotal);
  if (iva >= 0 && subtotal > 0) {
    // Subtotal + IVA exactos del papel -- nunca se recalculan (regla del
    // espejo: el total se toma tal cual, no se vuelve a sumar).
    out.subtotal = subtotal;
    out.iva = iva;
  } else if (iva >= 0) {
    // Solo vino IVA + total -> el subtotal se deriva una sola vez aquí.
    out.subtotal = total - iva;
    out.iva = iva;
  }
  return out;
}

function _onFotoCompraElegida_() {
  _compraTocadaPorOcr = false;
  _compraFotoComprimidaB64 = '';
  const fotoInput = document.getElementById('compra_foto');
  const file = fotoInput && fotoInput.files ? fotoInput.files[0] : null;
  const preview = document.getElementById('compraFotoPreview');
  const btnOcr = document.getElementById('compraBtnOcr');
  const estado = document.getElementById('compraOcrEstado');
  if (estado) estado.textContent = '';
  if (!file) {
    if (preview) { preview.style.display = 'none'; preview.src = ''; }
    if (btnOcr) btnOcr.style.display = 'none';
    return;
  }
  if (preview) {
    preview.src = URL.createObjectURL(file);
    preview.style.display = 'block';
  }
  if (btnOcr) {
    btnOcr.style.display = 'block';
    const online = navigator.onLine;
    btnOcr.disabled = !online;
    btnOcr.textContent = online ? '🔍 Leer ticket' : '🔍 Leer ticket (sin señal)';
  }
}

function _resetFotoCompra_() {
  _compraTocadaPorOcr = false;
  _compraFotoComprimidaB64 = '';
  const preview = document.getElementById('compraFotoPreview');
  const btnOcr = document.getElementById('compraBtnOcr');
  const estado = document.getElementById('compraOcrEstado');
  if (preview) { preview.style.display = 'none'; preview.src = ''; }
  if (btnOcr) btnOcr.style.display = 'none';
  if (estado) estado.textContent = '';
}

function _marcarTocadoPorIACompra_(el) {
  if (!el) return;
  el.classList.add('ia-tocado');
  const quitar = () => el.classList.remove('ia-tocado');
  el.addEventListener('input', quitar, { once: true });
  el.addEventListener('change', quitar, { once: true });
}

async function _leerTicketCompraConIA_() {
  const btnOcr = document.getElementById('compraBtnOcr');
  const estado = document.getElementById('compraOcrEstado');
  const fotoInput = document.getElementById('compra_foto');
  const file = fotoInput && fotoInput.files ? fotoInput.files[0] : null;
  if (!file || !navigator.onLine) return;
  const url = localStorage.getItem('sumetec_direccion_url');
  if (!url) { if (estado) estado.textContent = 'Vincula el teléfono primero.'; return; }
  if (btnOcr) { btnOcr.disabled = true; btnOcr.textContent = 'Leyendo…'; }
  if (estado) estado.textContent = '';
  try {
    const pin = await pedirPinDireccion();
    const token = await abrirSesionDireccion(pin);
    // Comprime UNA vez y la reusa para el guardado -- así el ticket no se
    // comprime dos veces ni se lee dos veces por accidente.
    if (!_compraFotoComprimidaB64) _compraFotoComprimidaB64 = await _comprimirImagenCompra_(file);
    const res = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ tipo: 'ocr_ticket', token, foto: _compraFotoComprimidaB64 }),
    });
    const resp = await res.json();
    const r = _aplicarOcrACompra_(resp);
    if (!r.aplicado) {
      _compraTocadaPorOcr = false;
      if (estado) estado.textContent = '⚠️ No se pudo leer, captura a mano.';
      return;
    }
    _compraTocadaPorOcr = true;
    const f = document.querySelector('#form-compra');
    if (r.proveedor && f.proveedor) { f.proveedor.value = r.proveedor; _marcarTocadoPorIACompra_(f.proveedor); }
    if (r.fecha && f.fecha) { f.fecha.value = r.fecha; _marcarTocadoPorIACompra_(f.fecha); }
    if (r.subtotal != null && f.subtotal) { f.subtotal.value = r.subtotal.toFixed(2); _marcarTocadoPorIACompra_(f.subtotal); }
    if (r.iva != null && f.iva) { f.iva.value = r.iva.toFixed(2); _marcarTocadoPorIACompra_(f.iva); }
    // El total se toma tal cual lo dice el papel -- NUNCA se recalcula de
    // subtotal+iva aunque el listener de arriba (f.subtotal.oninput) exista
    // para la captura manual. Es la regla del espejo de la remisión.
    if (f.total) { f.total.value = r.total.toFixed(2); _marcarTocadoPorIACompra_(f.total); }
    if (estado) estado.textContent = '✅ IA — revísalo antes de guardar.';
  } catch (e) {
    _compraTocadaPorOcr = false;
    if (estado) estado.textContent = '⚠️ Error de lectura, captura a mano.';
  } finally {
    if (btnOcr) { btnOcr.disabled = !navigator.onLine; btnOcr.textContent = navigator.onLine ? '🔍 Leer ticket' : '🔍 Leer ticket (sin señal)'; }
  }
}
