// Inventario en Dirección (F4 del plan de diseño, 2026-09-11). Viene de
// 12.- GASTOS/gastos.html -- mismo conteo, mismo
// orden de pantallas y botones, misma lógica (ERI, mermas, ceros repetidos,
// ranking, cola offline, teorico_ref/referencia_ts). Lo que cambia:
//   · Autorización: sesión con PIN de Dirección, no el API_TOKEN compartido
//     de Gastos. El servidor ya acepta catalogo/stock_teorico/
//     conteo_inventario/conteo_inventario_erp con el token del dispositivo
//     (apps_script.js::_TIPOS_DIRECCION_).
//   · Reintentos automáticos (cada 30 s y al volver la señal): SOLO si el PIN
//     sigue vigente en memoria. Nunca abren el diálogo del PIN solos -- un
//     diálogo que salta sin que Miguel toque nada es peor que esperar. Para
//     mandar sin PIN vigente está "Enviar conteos pendientes" (pide el PIN).
//   · Claves de localStorage propias (sumetec_direccion_inv_*): un conteo a
//     medias en la app de Gastos NO se ve aquí ni al revés. F5 del plan
//     drena la cola de Gastos antes de quitarle la pantalla.
//   · La cola de conteos NO entra en COLAS (app.js): _pendientesSinEnviar-
//     Direccion_ (corte.js) bloquea el cierre de caja por lo que haya en
//     COLAS, y un conteo sin enviar no mueve efectivo -- no debe impedir un
//     corte. Sí se suma al chip de pendientes (estado(), app.js).
//   · Toda la lógica de negocio (ERI, diferencias, payload) es copia exacta.

const CLAVE_INV_CATALOGO = 'sumetec_direccion_inv_catalogo';
const CLAVE_INV_STOCK = 'sumetec_direccion_inv_stock_teorico';
const CLAVE_INV_CONTEO_ACTUAL = 'sumetec_direccion_inv_conteo_actual';
const CLAVE_INV_COLA = 'sumetec_direccion_inv_cola_conteo';
const CLAVE_INV_CONTADOR = 'sumetec_direccion_inv_contador';

// Mismo valor de fábrica que Gastos; el ERP lo puede publicar en la sección
// GASTOS de la configuración central (ver _aplicarConfigInventarioPublicada_).
let STOCK_HORAS_ROJO_PUBLICADO = 24 * 7;

function _aplicarConfigInventarioPublicada_(gastos) {
  if (!gastos) return;
  if (typeof gastos.stock_horas_rojo === 'number' && gastos.stock_horas_rojo > 0) {
    STOCK_HORAS_ROJO_PUBLICADO = gastos.stock_horas_rojo;
  }
}

// Escapa texto y valores de atributo HTML: descripciones de tornillería traen
// `"` literal (medidas en pulgadas, ej. TORNILLO 1/4" x 2").
function esc(v) {
  return v == null ? '' : String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escAttrVal(v) { return esc(v); }

function toast(msg, ms) {
  const t = document.getElementById('toast');
  if (!t) { alert(msg); return; }
  t.textContent = msg;
  t.className = 'toast show';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.className = 'toast'; }, ms || 3000);
}

function leerSeguro(clave, porDefecto) {
  try { const v = localStorage.getItem(clave); return v === null ? porDefecto : JSON.parse(v); }
  catch (_) { return porDefecto; }
}
function guardarSeguro(clave, valorObj) {
  try { localStorage.setItem(clave, JSON.stringify(valorObj)); return true; }
  catch (_) { return false; }
}
function _dedupeCola_(cola, id) { return cola.some(e => e.id === id); }

// ── Servidor: token de la sesión de Dirección ───────────────────────────────
// pedir=true -> puede abrir el diálogo del PIN (acción explícita de Miguel).
// pedir=false -> solo si el PIN ya está vigente en memoria (segundo plano).
async function _tokenInventario_(pedir) {
  if (!localStorage.getItem('sumetec_direccion_url') || !localStorage.getItem(SESION_KEY)) return null;
  if (!pedir && !_pinVigente()) return null;
  const pin = await pedirPinDireccion();
  return abrirSesionDireccion(pin);
}

async function _postInventario_(cuerpo, pedir) {
  const url = localStorage.getItem('sumetec_direccion_url');
  const token = await _tokenInventario_(pedir);
  if (!url || !token) throw new Error('Vincula el teléfono y escribe tu PIN para usar el servidor.');
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ ...cuerpo, token })
  });
  return res.json();
}

// Una respuesta que llega tarde (catálogo, historial) no debe pisar otra
// pantalla a medio capturar -- mismo criterio que el Resumen (DIR-02).
function _enInventario_() {
  return typeof vistaActivaDireccion !== 'function' || vistaActivaDireccion() === 'inventario';
}

function _pintarInventario_(html) {
  if (!_enInventario_()) return;
  document.getElementById('app').innerHTML = html;
}

// ── Catálogo: se cachea para poder contar sin señal en bodega ───────────────
let CATALOGO = [];     // [{codigo, descripcion, categoria, costo}]
let CATEGORIAS = [];   // nombres únicos, ordenados
let CATALOGO_FRESCO = true; // false si se usó el respaldo de localStorage

function _guardarCatalogoCache_(catalogo, categorias) {
  guardarSeguro(CLAVE_INV_CATALOGO, { ts: Date.now(), catalogo, categorias });
}

// ── Stock teórico del ERP ───────────────────────────────────────────────────
// Referencia para avisar "difiere de lo que el ERP espera" MIENTRAS se cuenta
// -- nunca cambia lo que se escribe. Viaja con el conteo solo como contexto
// (teorico_ref), el ajuste se calcula en el ERP.
let STOCK_TEORICO = new Map(); // codigo(minúsculas) -> {stock, desc, entradas, salidas, ajuste}

function _construirStockTeoricoMap(filas) {
  const m = new Map();
  if (!Array.isArray(filas)) return m;
  filas.forEach(f => {
    const cod = String(f.CODIGO || '').trim();
    if (!cod) return;
    const stock = Number(f.STOCK_TEORICO);
    if (isNaN(stock)) return;
    const entradas = Number(f.ENTRADAS); const salidas = Number(f.SALIDAS); const ajuste = Number(f.AJUSTES);
    m.set(cod.toLowerCase(), {
      stock, desc: f.DESCRIPCION || '',
      entradas: isNaN(entradas) ? 0 : entradas,
      salidas: isNaN(salidas) ? 0 : salidas,
      ajuste: isNaN(ajuste) ? 0 : ajuste,
    });
  });
  return m;
}

// "45 = 60 comprados − 20 vendidos + 5 de ajustes"
function _textoDesgloseStock_(stock, entradas, salidas, ajuste) {
  const partes = [`${entradas} comprados`];
  if (salidas) partes.push(`− ${salidas} vendidos`);
  if (ajuste) partes.push(`${ajuste >= 0 ? '+' : '−'} ${Math.abs(ajuste)} de ajustes`);
  return `${stock} = ` + partes.join(' ');
}

function _mostrarDesgloseStock_(codigo) {
  const e = STOCK_TEORICO.get(String(codigo || '').toLowerCase());
  if (!e) return;
  // toast() usa textContent -- no hace falta esc() aquí.
  toast(codigo + ': ' + _textoDesgloseStock_(e.stock, e.entradas, e.salidas, e.ajuste), 6000);
}

// Resumen al cerrar: MISMA fórmula que services/ajustes.py::resumen_eri del
// ERP, para que el número del celular no contradiga al del ERP.
function _resumenConteo_(items, stockTeoricoMap) {
  let contados = 0, sinTocar = 0, cuadran = 0, difieren = 0;
  let dineroFalt = 0, dineroSobr = 0, totalTeorico = 0;
  (items || []).forEach(it => {
    if (it.cantidad === null) { sinTocar++; return; }
    contados++;
    const e = stockTeoricoMap.get(String(it.codigo || '').toLowerCase());
    if (!e) return;
    const costo = it.costo || 0;
    const diferencia = it.cantidad - e.stock;
    const valorDif = diferencia * costo;
    if (diferencia === 0) cuadran++;
    else if (diferencia < 0) { difieren++; dineroFalt += Math.abs(valorDif); }
    else { difieren++; dineroSobr += valorDif; }
    totalTeorico += e.stock * costo;
  });
  const variacion = dineroFalt + dineroSobr;
  let eri = totalTeorico > 0 ? (1 - variacion / totalTeorico) * 100 : 100;
  if (eri < 0) eri = 0;
  let nivel = 'CRÍTICO';
  if (eri >= 99) nivel = 'EXCELENTE';
  else if (eri >= 95) nivel = 'ACEPTABLE';
  else if (eri >= 85) nivel = 'REGULAR';
  return { contados, sinTocar, cuadran, difieren, dineroFalt, dineroSobr, eri, nivel };
}

// "ts" es SIEMPRE el que publicó el ERP, nunca cuándo lo bajó este celular.
function _guardarStockTeoricoCache_(filas, ts) {
  guardarSeguro(CLAVE_INV_STOCK, { ts: ts || '', filas });
}

// Best-effort, nunca bloquea: sin señal o sin PIN, se queda con el caché.
async function _cargarStockTeorico_(pedir) {
  const usarCache = () => {
    const cache = leerSeguro(CLAVE_INV_STOCK, null);
    if (cache && cache.filas) STOCK_TEORICO = _construirStockTeoricoMap(cache.filas);
  };
  if (!navigator.onLine) { usarCache(); return; }
  try {
    const d = await _postInventario_({ tipo: 'stock_teorico' }, !!pedir);
    if (!d || !Array.isArray(d.filas)) throw new Error('respuesta inválida');
    STOCK_TEORICO = _construirStockTeoricoMap(d.filas);
    _guardarStockTeoricoCache_(d.filas, d.ts || '');
  } catch (_) {
    usarCache();
  }
}

// Jala el teórico fresco ANTES de entrar a la bodega.
async function _actualizarStockTeoricoAhora_() {
  if (!navigator.onLine) { toast('Sin conexión -- no se puede actualizar ahora.'); return; }
  await _cargarStockTeorico_(true);
  if (_enInventario_() && document.getElementById('chkTodo')) renderSelectorCategoria();
  toast('Stock teórico actualizado.');
}

function _haceCuanto_(ts) {
  const min = Math.round((Date.now() - ts) / 60000);
  if (min < 1) return 'un momento';
  if (min < 60) return min + ' min';
  const h = Math.round(min / 60);
  if (h < 24) return h + ' h';
  return Math.round(h / 24) + ' días';
}

// Bug visto al probar F4 en el navegador (2026-09-11; el mismo existe en la
// app de Gastos, de donde viene este código): el teórico se pide sin esperar
// y el selector se pintaba ANTES de que llegara, así que la primera vez el
// sello decía "nunca se ha sincronizado" aunque el dato ya estuviera en
// camino. Al llegar, se repinta SOLO el sello -- no toda la pantalla, para
// no borrar las casillas que Miguel ya haya marcado.
function _refrescarSelloStock_() {
  const s = document.getElementById('selloStock');
  if (s && _enInventario_()) s.outerHTML = _htmlAntiguedadStockTeorico_();
}

// Entrada desde el menú (app.js::vista). El catálogo se pide a la red solo
// la primera vez; volver a la pestaña reusa lo ya cargado.
function activarInventarioDireccion() {
  if (CATALOGO.length) _arrancarInventario_();
  else cargarCatalogoInventario();
}

async function cargarCatalogoInventario() {
  _pintarInventario_('<h1>Inventario</h1><div class="card card-body text-muted">Cargando catálogo…</div>');
  try {
    if (!navigator.onLine) throw new Error('sin conexión');
    const filas = await _postInventario_({ tipo: 'catalogo' }, true);
    if (filas && filas.error) throw new Error(filas.error);
    CATALOGO = (filas || []).map(p => ({
      codigo: p.CODIGO || '', descripcion: p.DESCRIPCION || '',
      categoria: (p.CATEGORIA || '').trim() || 'Sin categoría',
      costo: Number(p.COSTO_CLIENTE) || 0,
    })).filter(p => p.codigo);
    CATEGORIAS = [...new Set(CATALOGO.map(p => p.categoria))].sort();
    CATALOGO_FRESCO = true;
    _guardarCatalogoCache_(CATALOGO, CATEGORIAS);
    // Sin await a propósito (no frena la pantalla); el PIN ya está vigente,
    // no vuelve a preguntar. Al llegar, repinta el sello -- ver
    // _refrescarSelloStock_.
    _cargarStockTeorico_(false).then(_refrescarSelloStock_);
    _arrancarInventario_();
  } catch (e) {
    const cache = leerSeguro(CLAVE_INV_CATALOGO, null);
    if (cache && cache.catalogo && cache.catalogo.length) {
      CATALOGO = cache.catalogo;
      CATEGORIAS = cache.categorias || [...new Set(CATALOGO.map(p => p.categoria))].sort();
      CATALOGO_FRESCO = false;
      toast('Sin conexión: usando catálogo guardado de hace ' + _haceCuanto_(cache.ts) + '.', 5000);
      _cargarStockTeorico_(false).then(_refrescarSelloStock_);
      _arrancarInventario_();
    } else {
      _pintarInventario_('<h1>Inventario</h1><div class="alert alert-danger">No se pudo cargar el catálogo: ' +
        esc(e.message || e) + '</div>' +
        '<button class="btn btn-outline-secondary btn-bloque" onclick="cargarCatalogoInventario()"><i class="bi bi-arrow-repeat"></i> Reintentar</button>');
    }
  }
}

// Retoma un conteo sin terminar si existe (nunca perder un conteo a medias).
function _arrancarInventario_() {
  if (!_enInventario_()) return;
  const pendiente = leerSeguro(CLAVE_INV_CONTEO_ACTUAL, null);
  if (pendiente && pendiente.items && pendiente.items.length) {
    CONTEO_ACTUAL = pendiente;
    const contados = pendiente.items.filter(it => it.cantidad !== null).length;
    toast('Retomando el conteo de "' + pendiente.categoria + '" (' + contados + '/' + pendiente.items.length + ').', 4000);
    renderListaConteo();
  } else {
    renderSelectorCategoria();
  }
}

// ── Historial de conteos (hoja "Conteo Inventario") ─────────────────────────
let HIST_CONTEOS = null;

async function _cargarHistConteos_(pedir) {
  if (HIST_CONTEOS) return HIST_CONTEOS;
  if (!navigator.onLine) return null;
  try {
    const d = await _postInventario_({ tipo: 'conteo_inventario_erp' }, !!pedir);
    if (!d || !d.ok || !Array.isArray(d.filas)) return null;
    HIST_CONTEOS = d.filas;
    return HIST_CONTEOS;
  } catch (_) { return null; }
}

function _parseFechaMX_(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  return new Date(+m[3], +m[2] - 1, +m[1]);
}

// Aviso junto a CADA categoría: "nunca contada" o "+30 días sin contar".
// Sin conexión (o sin PIN vigente), simplemente no aparecen avisos.
async function _pintarAvisosCategorias_() {
  const filas = await _cargarHistConteos_(false);
  if (!filas) return;
  const ultimaPorCat = {};
  filas.forEach(f => {
    const cat = f['Categoria'] || ''; const f2 = _parseFechaMX_(f['Fecha']);
    if (!cat || !f2) return;
    if (!ultimaPorCat[cat] || f2 > ultimaPorCat[cat]) ultimaPorCat[cat] = f2;
  });
  const hoy = Date.now();
  const avisoDe = (catTxt) => {
    const u = ultimaPorCat[catTxt];
    if (!u) return '<span class="text-rojo" style="font-weight:600"> · nunca contada</span>';
    const dias = Math.round((hoy - u.getTime()) / 86400000);
    if (dias > 30) return `<span class="text-aviso" style="font-weight:600"> · +${dias}d sin contar</span>`;
    return '';
  };
  document.querySelectorAll('[data-cat-aviso]').forEach(el => {
    el.innerHTML = avisoDe(el.getAttribute('data-cat-aviso'));
  });
}

const _BTN_VOLVER_SELECTOR_ = '<button class="btn btn-outline-secondary btn-bloque" style="margin-top:10px" onclick="renderSelectorCategoria()"><i class="bi bi-arrow-left"></i> Volver</button>';
const _SIN_HISTORIAL_ = '<div class="alert alert-warning">No se pudo leer el historial (necesitas conexión y tu PIN).</div>' + _BTN_VOLVER_SELECTOR_;

// Mermas: compara los 2 conteos más recientes de una categoría, por código.
async function verMermas() {
  const cat = CONTEO_ACTUAL ? CONTEO_ACTUAL.categoria : null;
  _pintarInventario_('<div class="card card-body text-muted">Buscando conteos anteriores…</div>');
  const filas = await _cargarHistConteos_(true);
  if (!filas) { _pintarInventario_(_SIN_HISTORIAL_); return; }
  const porSesion = {};
  filas.forEach(f => {
    const id = f['ID Conteo']; if (!id) return;
    if (!porSesion[id]) porSesion[id] = { fecha: f['Fecha'], categoria: f['Categoria'], items: {} };
    porSesion[id].items[f['Código']] = { cantidad: Number(f['Cantidad Física']) || 0, desc: f['Descripción'] };
  });
  let sesiones = Object.values(porSesion);
  if (cat && cat !== 'Todo el catálogo') sesiones = sesiones.filter(s => s.categoria === cat);
  sesiones.sort((a, b) => (_parseFechaMX_(b.fecha) || 0) - (_parseFechaMX_(a.fecha) || 0));
  if (sesiones.length < 2) {
    _pintarInventario_('<div class="card card-body">Todavía no hay 2 conteos de esta categoría para comparar.' + _BTN_VOLVER_SELECTOR_ + '</div>');
    return;
  }
  const [nuevo, viejo] = sesiones;
  const codigos = new Set([...Object.keys(nuevo.items), ...Object.keys(viejo.items)]);
  const cambios = [...codigos].map(cod => {
    const n = nuevo.items[cod] ? nuevo.items[cod].cantidad : null;
    const v = viejo.items[cod] ? viejo.items[cod].cantidad : null;
    const desc = (nuevo.items[cod] || viejo.items[cod] || {}).desc || '';
    return { cod, desc, n, v, delta: (n !== null && v !== null) ? (n - v) : null };
  }).filter(c => c.delta !== null && c.delta !== 0)
    .sort((a, b) => a.delta - b.delta);
  const filasHtml = cambios.length ? cambios.map(c => `
    <div class="fila-producto">
      <div class="info">
        <div>${esc(c.desc)}</div>
        <div class="codigo">${esc(c.cod)} · antes ${c.v} → ahora ${c.n}</div>
      </div>
      <strong class="${c.delta < 0 ? 'text-rojo' : 'text-verde'}">${c.delta > 0 ? '+' : ''}${c.delta}</strong>
    </div>`).join('') : '<p class="text-muted">Sin diferencias entre estos dos conteos.</p>';
  _pintarInventario_(`
    <div class="card card-body">
      <strong>Mermas: ${esc(viejo.fecha)} → ${esc(nuevo.fecha)}</strong>
      <div class="text-muted" style="font-size:12px;margin-bottom:8px">${esc(nuevo.categoria)}</div>
      ${filasHtml}
      ${_BTN_VOLVER_SELECTOR_}
    </div>`);
}

// Un producto en CERO en 3+ conteos SEGUIDOS (los más recientes) suele estar
// descontinuado pero vivo en el catálogo. Función pura.
function _cerosRepetidos(filas, minSeguidos) {
  const min = minSeguidos || 3;
  const porCodigo = {};
  (filas || []).forEach(f => {
    const cod = f['Código']; if (!cod) return;
    const fecha = _parseFechaMX_(f['Fecha']); if (!fecha) return;
    (porCodigo[cod] = porCodigo[cod] || []).push({ fecha, cantidad: Number(f['Cantidad Física']) || 0, desc: f['Descripción'] || '' });
  });
  const resultado = [];
  Object.keys(porCodigo).forEach(cod => {
    const arr = porCodigo[cod].sort((a, b) => b.fecha - a.fecha);
    let seguidos = 0;
    for (const x of arr) { if (x.cantidad === 0) seguidos++; else break; }
    if (seguidos >= min) resultado.push({ codigo: cod, desc: arr[0].desc, veces: seguidos, ultima: arr[0].fecha });
  });
  resultado.sort((a, b) => b.veces - a.veces);
  return resultado;
}

async function verCerosRepetidos() {
  _pintarInventario_('<div class="card card-body text-muted">Buscando conteos anteriores…</div>');
  const filas = await _cargarHistConteos_(true);
  if (!filas) { _pintarInventario_(_SIN_HISTORIAL_); return; }
  const productos = _cerosRepetidos(filas, 3);
  const filasHtml = productos.length ? productos.map(p => `
    <div class="fila-producto">
      <div class="info">
        <div>${esc(p.desc)}</div>
        <div class="codigo">${esc(p.codigo)} · última vez ${p.ultima.toLocaleDateString('es-MX')}</div>
      </div>
      <strong class="text-rojo">${p.veces}×</strong>
    </div>`).join('') : '<p class="text-muted">Ningún producto lleva 3+ conteos seguidos en cero.</p>';
  _pintarInventario_(`
    <div class="card card-body">
      <strong><i class="bi bi-slash-circle"></i> Productos en cero 3+ veces seguidas</strong>
      <div class="text-muted" style="font-size:12px;margin-bottom:8px">Puede significar producto descontinuado o que ya no se vende — revísalo antes de seguir comprándolo.</div>
      ${filasHtml}
      ${_BTN_VOLVER_SELECTOR_}
    </div>`);
}

// Ranking por contador. Conteos sin nombre caen en "(sin nombre)". Pura.
function _rankingContadores(filas) {
  const porContador = {};
  (filas || []).forEach(f => {
    const nombre = String(f['Contador'] || '').trim() || '(sin nombre)';
    const idConteo = f['ID Conteo'] || '';
    const e = porContador[nombre] || (porContador[nombre] = { contador: nombre, items: 0, sesiones: new Set() });
    e.items++;
    if (idConteo) e.sesiones.add(idConteo);
  });
  return Object.values(porContador)
    .map(e => ({ contador: e.contador, items: e.items, sesiones: e.sesiones.size }))
    .sort((a, b) => b.items - a.items);
}

async function verRankingContadores() {
  _pintarInventario_('<div class="card card-body text-muted">Buscando historial de conteos…</div>');
  const filas = await _cargarHistConteos_(true);
  if (!filas) { _pintarInventario_(_SIN_HISTORIAL_); return; }
  const ranking = _rankingContadores(filas);
  const filasHtml = ranking.length ? ranking.map((r, i) => `
    <div class="fila-producto">
      <div class="info">
        <div>${i + 1}. ${esc(r.contador)}</div>
        <div class="codigo">${r.sesiones} conteo${r.sesiones === 1 ? '' : 's'} cerrado${r.sesiones === 1 ? '' : 's'}</div>
      </div>
      <strong>${r.items} productos</strong>
    </div>`).join('') : '<p class="text-muted">Todavía no hay conteos registrados.</p>';
  _pintarInventario_(`
    <div class="card card-body">
      <strong><i class="bi bi-trophy"></i> Ranking por contador</strong>
      <div class="text-muted" style="font-size:12px;margin-bottom:8px">Productos contados en total, según quién capturó cada conteo.</div>
      ${filasHtml}
      ${_BTN_VOLVER_SELECTOR_}
    </div>`);
}

// Varias categorías a la vez; "Todo el catálogo" es excluyente. Pura.
function _productosDeCategorias(catalogo, categorias, todo) {
  if (todo) return catalogo.slice();
  if (!categorias.length) return [];
  const set = new Set(categorias);
  return catalogo.filter(p => set.has(p.categoria));
}

// Sello de frescura del stock teórico (3 umbrales). Pura.
function _estadoFrescuraStock_(tsISO, ahoraMs) {
  ahoraMs = (ahoraMs != null) ? ahoraMs : Date.now();
  const t = tsISO ? new Date(tsISO).getTime() : NaN;
  if (isNaN(t)) {
    return { nivel: 'rojo', bloquea: true,
      texto: '🔴 El stock teórico nunca se ha sincronizado. Sincroniza el ERP antes de contar.' };
  }
  const horas = (ahoraMs - t) / 3600000;
  if (horas > STOCK_HORAS_ROJO_PUBLICADO) {
    const diasRojo = Math.round(STOCK_HORAS_ROJO_PUBLICADO / 24);
    return { nivel: 'rojo', bloquea: true,
      texto: '🔴 Stock teórico de hace más de ' + diasRojo + (diasRojo === 1 ? ' día' : ' días') + '. Sincroniza el ERP antes de contar.' };
  }
  const mismoDiaCal = new Date(t).toDateString() === new Date(ahoraMs).toDateString();
  if (mismoDiaCal) {
    const hora = new Date(t).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
    return { nivel: 'verde', bloquea: false, texto: 'Stock teórico al día — actualizado hoy ' + hora };
  }
  const dias = Math.max(1, Math.round(horas / 24));
  return { nivel: 'ambar', bloquea: false,
    texto: '⚠️ Stock teórico de hace ' + dias + (dias === 1 ? ' día' : ' días') + ' — las diferencias pueden ser falsas.' };
}

// Se muestra ANTES de contar, no al final.
function _htmlAntiguedadStockTeorico_() {
  const cache = leerSeguro(CLAVE_INV_STOCK, null);
  const estado = _estadoFrescuraStock_(cache && cache.ts);
  const clase = estado.nivel === 'verde' ? 'text-verde' : estado.nivel === 'ambar' ? 'text-aviso' : 'text-rojo';
  return `<div id="selloStock" class="card card-body inv-sello ${clase}">
    <span>${estado.texto}</span>
    <button class="btn btn-outline-secondary" onclick="_actualizarStockTeoricoAhora_()"><i class="bi bi-arrow-repeat"></i> Actualizar ahora</button>
  </div>`;
}

function _contarTodoElCatalogo_() {
  const chk = document.getElementById('chkTodo');
  if (chk) { chk.checked = true; _alMarcarTodo_(); }
  iniciarConteo();
}

function renderSelectorCategoria() {
  const avisoCache = CATALOGO_FRESCO ? '' :
    '<div class="alert alert-warning">⚠️ Catálogo sin conexión reciente — puede no reflejar altas/bajas nuevas.</div>';
  const filas = CATEGORIAS.map((c, i) => `
    <label class="inv-cat">
      <input type="checkbox" class="chkCat" id="catchk_${i}" value="${esc(c)}" onchange="_alCambiarCategoria_()">
      <span style="flex:1">${esc(c)}<span data-cat-aviso="${esc(c)}"></span></span>
    </label>`).join('');
  _pintarInventario_(`
    <h1>Inventario</h1>
    ${avisoCache}
    ${_htmlAntiguedadStockTeorico_()}
    <div class="card card-body">
      <button class="btn btn-success btn-bloque" onclick="_contarTodoElCatalogo_()"><i class="bi bi-list-check"></i> Contar TODO el catálogo (${CATALOGO.length} productos)</button>
    </div>
    <div class="card card-body">
      <span class="form-label">…o elige categorías específicas</span>
      <label class="inv-cat inv-cat-todo">
        <input type="checkbox" id="chkTodo" onchange="_alMarcarTodo_()">
        <span style="flex:1">Todo el catálogo (${CATALOGO.length} productos)<span data-cat-aviso="Todo el catálogo"></span></span>
      </label>
      ${filas}
      <button class="btn btn-success btn-bloque" style="margin-top:10px" onclick="iniciarConteo()"><i class="bi bi-check-circle"></i> Empezar conteo</button>
    </div>
    <div class="card card-body inv-acciones">
      <button class="btn btn-primary btn-bloque" onclick="procesarColaConteo(true).then(verColaPendiente)"><i class="bi bi-cloud-arrow-up"></i> Enviar conteos pendientes</button>
      <button class="btn btn-outline-secondary btn-bloque" onclick="verColaPendiente()"><i class="bi bi-list-check"></i> Ver cola pendiente de envío</button>
      <button class="btn btn-outline-secondary btn-bloque" onclick="verMermas()"><i class="bi bi-graph-down"></i> Ver mermas entre conteos</button>
      <button class="btn btn-outline-secondary btn-bloque" onclick="verCerosRepetidos()"><i class="bi bi-slash-circle"></i> Productos en cero 3+ veces</button>
      <button class="btn btn-outline-secondary btn-bloque" onclick="verRankingContadores()"><i class="bi bi-trophy"></i> Ranking por contador</button>
    </div>`);
  _pintarAvisosCategorias_();
}

function _alMarcarTodo_() {
  const todo = document.getElementById('chkTodo').checked;
  document.querySelectorAll('.chkCat').forEach(c => { c.disabled = todo; if (todo) c.checked = false; });
}
function _alCambiarCategoria_() {
  const algunaMarcada = [...document.querySelectorAll('.chkCat')].some(c => c.checked);
  if (algunaMarcada) document.getElementById('chkTodo').checked = false;
}
function _categoriasSeleccionadas_() {
  return [...document.querySelectorAll('.chkCat:checked')].map(c => c.value);
}

let CONTEO_ACTUAL = null; // { categoria, items: [{codigo, descripcion, cantidad|null, costo}], cerrado, queueId, contador }

function _guardarConteoActual_() {
  if (CONTEO_ACTUAL) guardarSeguro(CLAVE_INV_CONTEO_ACTUAL, CONTEO_ACTUAL);
  else localStorage.removeItem(CLAVE_INV_CONTEO_ACTUAL);
}

function iniciarConteo() {
  const todo = document.getElementById('chkTodo').checked;
  const categorias = _categoriasSeleccionadas_();
  if (!todo && !categorias.length) { toast('Marca al menos una categoría (o "Todo el catálogo").'); return; }
  // Contar bien contra un teórico viejo es peor que no contar.
  const cacheST = leerSeguro(CLAVE_INV_STOCK, null);
  const estadoST = _estadoFrescuraStock_(cacheST && cacheST.ts);
  if (estadoST.bloquea && !confirm(estadoST.texto + '\n\n¿Contar de todos modos?')) return;
  const productos = _productosDeCategorias(CATALOGO, categorias, todo);
  CONTEO_ACTUAL = {
    categoria: todo ? 'Todo el catálogo' : categorias.join(', '),
    // costo viaja con cada item solo para el resumen local, nunca al servidor.
    items: productos.map(p => ({ codigo: p.codigo, descripcion: p.descripcion, cantidad: null, costo: p.costo || 0 })),
    cerrado: false,
    queueId: null,
    contador: '',
    filtro: '',
    soloFaltan: false,
  };
  _guardarConteoActual_();
  renderListaConteo();
}

// Contado vs. teórico por renglón: gris sin contar, verde si cuadra,
// ámbar/rojo por severidad si difiere. Nunca bloquea. "teórico N" es tocable.
function _spanTeoricoClic_(codigo, texto) {
  return `<span class="inv-teorico" onclick="event.stopPropagation();_mostrarDesgloseStock_('${escAttrVal(codigo)}')">${texto}</span>`;
}
function _htmlTeorico(codigo, cantidad) {
  const e = STOCK_TEORICO.get(String(codigo || '').toLowerCase());
  if (!e) return '';
  const teoTocable = _spanTeoricoClic_(codigo, 'teórico ' + e.stock);
  if (cantidad === null) return ` · <span class="text-muted">${teoTocable}</span>`;
  const diff = cantidad - e.stock;
  if (diff === 0) return ` · <span class="text-verde">${teoTocable} · contado ${cantidad} ✓</span>`;
  const pct = e.stock !== 0 ? Math.round((diff / e.stock) * 100) : 100;
  const severo = Math.abs(pct) > 10;
  const clase = severo ? 'text-rojo' : 'text-aviso';
  const signo = diff > 0 ? '+' : '';
  return ` · <span class="${clase}" style="font-weight:600">${teoTocable} · contado ${cantidad} · dif ${signo}${diff} (${signo}${pct}%) ⚠️</span>`;
}

function _filaConteoHtml(it, i) {
  return `
    <div class="fila-producto">
      <div class="info">
        <div>${esc(it.descripcion)}${it.nuevo ? ' <span class="inv-nuevo">● NUEVO</span>' : ''}</div>
        <div class="codigo" id="teo_${i}">${esc(it.codigo)}${_htmlTeorico(it.codigo, it.cantidad)}</div>
      </div>
      <input type="number" min="0" step="1" inputmode="numeric" class="form-control inv-cantidad"
             data-idx="${i}" value="${it.cantidad === null ? '' : it.cantidad}"
             placeholder="—" aria-label="Cantidad contada de ${esc(it.codigo)}"
             ${CONTEO_ACTUAL.cerrado
               ? `readonly onclick="editarCampoCerrado(${i})"`
               : `onchange="_actualizarCantidad(${i}, this.value)"`}>
    </div>`;
}

// Texto libre (código o descripción) + "solo los que faltan". Pura.
function _itemsFiltrados_(items, filtroTexto, soloFaltan) {
  const filtro = (filtroTexto || '').toLowerCase();
  return items
    .map((it, i) => ({ it, i }))
    .filter(({ it }) => {
      if (soloFaltan && it.cantidad !== null) return false;
      if (!filtro) return true;
      return it.descripcion.toLowerCase().includes(filtro) || it.codigo.toLowerCase().includes(filtro);
    });
}

function _htmlBarraResumen_(items, stockTeoricoMap) {
  const r = _resumenConteo_(items, stockTeoricoMap);
  const dinero = r.dineroFalt + r.dineroSobr;
  return `Contados ${r.contados} de ${items.length} · ✅ ${r.cuadran} cuadran` +
    (r.difieren ? ` · ⚠️ ${r.difieren} difieren` : '') +
    (dinero > 0 ? ` · $${dinero.toFixed(2)} de diferencia` : '');
}

function renderListaConteo() {
  const itemsFiltrados = _itemsFiltrados_(CONTEO_ACTUAL.items, CONTEO_ACTUAL.filtro, CONTEO_ACTUAL.soloFaltan);
  const filas = itemsFiltrados.map(({ it, i }) => _filaConteoHtml(it, i)).join('');
  const bannerCierre = !CONTEO_ACTUAL.cerrado ? '' :
    (CONTEO_ACTUAL._colaFallo
      ? '<div class="alert alert-danger" style="margin-top:10px">⚠️ El conteo se cerró pero NO se pudo guardar en la cola de envío (memoria llena). Toca "Ver cola pendiente" o repórtalo — este conteo puede perderse.</div>'
      : '<div class="alert alert-success" style="margin-top:10px">✅ Conteo cerrado y en cola de envío.</div>');
  _pintarInventario_(`
    <div id="barraResumenConteo" class="inv-barra">
      ${_htmlBarraResumen_(CONTEO_ACTUAL.items, STOCK_TEORICO)}
    </div>
    <div class="card card-body">
      <strong>${esc(CONTEO_ACTUAL.categoria)}</strong>
      <input id="buscadorConteo" class="form-control" style="margin-top:8px" placeholder="Buscar por código o descripción…" value="${escAttrVal(CONTEO_ACTUAL.filtro || '')}" oninput="_filtrarLista(this.value)">
      <label class="inv-cat">
        <input type="checkbox" id="chkSoloFaltan" ${CONTEO_ACTUAL.soloFaltan ? 'checked' : ''} onchange="_alCambiarSoloFaltan_(this.checked)">
        <span>Ver solo los que faltan</span>
      </label>
      ${CONTEO_ACTUAL.cerrado ? '' : `<button class="btn btn-outline-secondary btn-bloque" onclick="agregarProductoNuevo()"><i class="bi bi-plus-lg"></i> Producto que no está en la lista</button>`}
      <div id="listaItemsConteo">${filas || '<p class="text-muted" style="padding:8px 0">Sin resultados para ese filtro.</p>'}</div>
      ${bannerCierre}
      ${CONTEO_ACTUAL.cerrado
        ? ''
        : `<button class="btn btn-success btn-bloque" style="margin-top:12px" onclick="cerrarConteo()"><i class="bi bi-check-circle"></i> Cerrar conteo</button>`}
      <button class="btn btn-outline-secondary btn-bloque" style="margin-top:8px" onclick="exportarConteoCSV()"><i class="bi bi-download"></i> Exportar (.csv)</button>
      <button class="btn btn-outline-secondary btn-bloque" style="margin-top:8px" onclick="_volverASelector_()"><i class="bi bi-arrow-left"></i> Elegir otra categoría</button>
    </div>`);
}

function _refrescarListaConteo_() {
  const itemsFiltrados = _itemsFiltrados_(CONTEO_ACTUAL.items, CONTEO_ACTUAL.filtro, CONTEO_ACTUAL.soloFaltan);
  const filas = itemsFiltrados.map(({ it, i }) => _filaConteoHtml(it, i)).join('');
  document.getElementById('listaItemsConteo').innerHTML =
    filas || '<p class="text-muted" style="padding:8px 0">Sin resultados para ese filtro.</p>';
}

function _filtrarLista(v) {
  CONTEO_ACTUAL.filtro = v;
  _refrescarListaConteo_();
}

// Producto en el anaquel que no está en el catálogo descargado. El ERP ya
// sabe qué hacer con un código que no reconoce al importar el conteo.
function agregarProductoNuevo() {
  if (CONTEO_ACTUAL.cerrado) { toast('Este conteo ya está cerrado.'); return; }
  const codigoRaw = prompt('Código del producto nuevo (como lo vas a usar de ahora en adelante):');
  if (codigoRaw === null) return;
  const codigo = codigoRaw.trim();
  if (!codigo) { toast('Código vacío -- no se agregó nada.'); return; }

  const yaExiste = CONTEO_ACTUAL.items.findIndex(
    it => it.codigo.toLowerCase() === codigo.toLowerCase());
  if (yaExiste !== -1) {
    toast('Ese código ya está en este conteo -- búscalo arriba y captura la cantidad ahí.', 5000);
    CONTEO_ACTUAL.filtro = codigo;
    _guardarConteoActual_();
    renderListaConteo();
    return;
  }

  const descripcionRaw = prompt('Descripción de ' + codigo + ':');
  if (descripcionRaw === null) return;
  const descripcion = descripcionRaw.trim();
  if (!descripcion) { toast('Descripción vacía -- no se agregó nada.'); return; }

  const cantidadRaw = prompt('¿Cuántas piezas contaste de ' + codigo + '?');
  if (cantidadRaw === null) return;
  const n = Number(cantidadRaw.trim());
  if (isNaN(n) || n < 0 || !Number.isInteger(n)) {
    toast('Cantidad inválida: escribe un número entero de 0 en adelante.'); return;
  }

  CONTEO_ACTUAL.items.push({ codigo, descripcion, cantidad: n, costo: 0, nuevo: true });
  _guardarConteoActual_();
  toast('Agregado: ' + codigo + ' — se creará en el catálogo cuando se importe este conteo.', 5000);
  renderListaConteo();
}
function _alCambiarSoloFaltan_(checked) {
  CONTEO_ACTUAL.soloFaltan = checked;
  _refrescarListaConteo_();
}

function _volverASelector_() {
  const contados = CONTEO_ACTUAL ? CONTEO_ACTUAL.items.filter(it => it.cantidad !== null).length : 0;
  if (!CONTEO_ACTUAL.cerrado && contados > 0 &&
      !confirm('Tienes ' + contados + ' producto(s) contados sin cerrar. Si sales ahora, el conteo queda guardado y puedes retomarlo después. ¿Salir?')) {
    return;
  }
  if (CONTEO_ACTUAL.cerrado) { CONTEO_ACTUAL = null; _guardarConteoActual_(); }
  renderSelectorCategoria();
}

function _descargarCSV_(filas, nombreArchivo) {
  const csv = filas.map(f => f.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nombreArchivo;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function exportarConteoCSV() {
  if (!CONTEO_ACTUAL) return;
  const filas = [['Codigo', 'Descripcion', 'Cantidad']];
  CONTEO_ACTUAL.items.forEach(it => {
    if (it.cantidad !== null) filas.push([it.codigo, it.descripcion, it.cantidad]);
  });
  const nombreCat = CONTEO_ACTUAL.categoria.replace(/[^a-z0-9]+/gi, '_');
  _descargarCSV_(filas, `conteo_${nombreCat}_${_fechaLocalDireccion_()}.csv`);
}

function _actualizarCantidad(idx, valor) {
  const v = valor.trim();
  const input = document.querySelector('[data-idx="' + idx + '"]');
  if (v === '') { CONTEO_ACTUAL.items[idx].cantidad = null; }
  else {
    const n = Number(v);
    const valido = !isNaN(n) && n >= 0 && Number.isInteger(n);
    if (!valido) {
      toast('Cantidad inválida: escribe un número entero de 0 en adelante.');
      if (input) input.value = CONTEO_ACTUAL.items[idx].cantidad === null ? '' : CONTEO_ACTUAL.items[idx].cantidad;
      return;
    }
    CONTEO_ACTUAL.items[idx].cantidad = n;
  }
  _guardarConteoActual_();
  // Solo la barra y el aviso de ESTA fila -- sin re-renderizar la lista, para
  // no perder el foco del campo que se está editando.
  const barra = document.getElementById('barraResumenConteo');
  if (barra) barra.innerHTML = _htmlBarraResumen_(CONTEO_ACTUAL.items, STOCK_TEORICO);
  const teoEl = document.getElementById('teo_' + idx);
  if (teoEl) {
    const it = CONTEO_ACTUAL.items[idx];
    teoEl.innerHTML = esc(it.codigo) + _htmlTeorico(it.codigo, it.cantidad);
  }
}

// ── Candado de cierre/edición: mismo código de seguridad que Gastos ─────────
const CODIGO_BORRADO = '2526'; // respaldo local; localStorage tiene prioridad
function _codigoActivo_() {
  const v = (localStorage.getItem('codigo_borrado_override') || '').trim();
  return v || CODIGO_BORRADO;
}

// Diferencias reales ordenadas de MAYOR a MENOR en pesos. Pura.
function _diferenciasOrdenadas_(items, stockTeoricoMap) {
  const filas = [];
  (items || []).forEach(it => {
    if (it.cantidad === null) return;
    const e = stockTeoricoMap.get(String(it.codigo || '').toLowerCase());
    if (!e) return;
    const diferencia = it.cantidad - e.stock;
    if (diferencia === 0) return;
    filas.push({ codigo: it.codigo, descripcion: it.descripcion, teorico: e.stock,
      contado: it.cantidad, diferencia, valorDif: diferencia * (it.costo || 0) });
  });
  filas.sort((a, b) => Math.abs(b.valorDif) - Math.abs(a.valorDif));
  return filas;
}

function cerrarConteo() {
  // Nunca abierto ≠ contado en 0: Miguel elige qué hacer con los no tocados.
  const sinTocar = CONTEO_ACTUAL.items.filter(it => it.cantidad === null);
  if (sinTocar.length) {
    const marcarComoCero = confirm(
      sinTocar.length + ' producto(s) nunca se abrieron (distinto de contarlos en 0).\n\n' +
      'Aceptar = mandarlos como 0 (no hay existencia).\n' +
      'Cancelar = dejarlos FUERA de este conteo (no se tocan, no se envían).');
    if (marcarComoCero) {
      sinTocar.forEach(it => { it.cantidad = 0; });
      _guardarConteoActual_();
    }
  }
  _renderRevisionDiferencias_();
}

function _renderRevisionDiferencias_() {
  const diffs = _diferenciasOrdenadas_(CONTEO_ACTUAL.items, STOCK_TEORICO);
  if (!diffs.length) { _confirmarCierreConteo_(); return; }
  const filasHtml = diffs.map(f => {
    const clase = f.valorDif < 0 ? 'text-rojo' : 'text-verde';
    const signo = f.diferencia > 0 ? '+' : '';
    const signoPeso = f.valorDif < 0 ? '-' : '+';
    return `
    <div class="fila-producto">
      <div class="info">
        <div>${esc(f.descripcion)}</div>
        <div class="codigo">${esc(f.codigo)} · teórico ${f.teorico} · contado ${f.contado} · dif ${signo}${f.diferencia}</div>
      </div>
      <div class="num ${clase}" style="font-weight:700;white-space:nowrap">${signoPeso}$${Math.abs(f.valorDif).toFixed(2)}</div>
    </div>`;
  }).join('');
  _pintarInventario_(`
    <div class="card card-body">
      <strong><i class="bi bi-search"></i> Revisar diferencias (${diffs.length})</strong>
      <p class="text-muted" style="font-size:12px;margin:4px 0 0">Ordenadas de mayor a menor en pesos -- las que más importan van primero.</p>
    </div>
    <div class="card card-body">${filasHtml}</div>
    <div class="card card-body">
      <button class="btn btn-outline-secondary btn-bloque" onclick="renderListaConteo()"><i class="bi bi-arrow-left"></i> Regresar al conteo</button>
      <button class="btn btn-success btn-bloque" style="margin-top:8px" onclick="_confirmarCierreConteo_()">Continuar cierre <i class="bi bi-chevron-right"></i></button>
    </div>`);
}

// Quién contó: se pregunta la primera vez y se recuerda en este teléfono
// (en Gastos venía del nombre capturado en Remisiones, otro origen).
function _contadorGuardado_() {
  return (localStorage.getItem(CLAVE_INV_CONTADOR) || '').trim();
}

function _confirmarCierreConteo_() {
  const r = _resumenConteo_(CONTEO_ACTUAL.items, STOCK_TEORICO);
  const neto = r.dineroSobr - r.dineroFalt;
  const netoTxt = (neto >= 0 ? '+$' : '-$') + Math.abs(neto).toFixed(2);
  const msg =
    `${r.contados}/${CONTEO_ACTUAL.items.length} contados · ${r.cuadran} cuadran exacto · ${r.difieren} difieren\n` +
    `Diferencia neta en pesos: ${netoTxt}\n` +
    `ERI estimado: ${r.eri.toFixed(1)}% (${r.nivel})\n\n` +
    '¿Cerrar este conteo?';
  if (!confirm(msg)) return;
  const codigo = prompt('Código de seguridad:');
  if (codigo === null) return;
  if (codigo.trim() !== _codigoActivo_()) { toast('Código incorrecto'); return; }
  if (!CONTEO_ACTUAL.contador) {
    const guardado = _contadorGuardado_();
    const quien = (guardado || (prompt('Tus iniciales (para saber quién contó, opcional):') || '')).trim();
    if (quien && !guardado) localStorage.setItem(CLAVE_INV_CONTADOR, quien);
    CONTEO_ACTUAL.contador = quien;
  }
  CONTEO_ACTUAL.cerrado = true;
  _encolarConteo(CONTEO_ACTUAL);
  renderListaConteo();
}

function editarCampoCerrado(idx) {
  const codigo = prompt('Este conteo ya está cerrado. Código de seguridad para editar este producto:');
  if (codigo === null) return;
  if (codigo.trim() !== _codigoActivo_()) { toast('Código incorrecto'); return; }
  const nuevo = prompt('Nueva cantidad para ' + CONTEO_ACTUAL.items[idx].codigo + ':',
                       CONTEO_ACTUAL.items[idx].cantidad);
  if (nuevo === null) return;
  const v = nuevo.trim();
  const n = Number(v);
  const valido = v === '' || (!isNaN(n) && n >= 0 && Number.isInteger(n));
  if (!valido) { toast('Cantidad inválida: escribe un número entero de 0 en adelante.'); return; }
  CONTEO_ACTUAL.items[idx].cantidad = (v === '') ? null : n;
  _guardarConteoActual_();
  _reencolarCorreccion_();
  renderListaConteo();
}

// Si el conteo sigue en la cola, se reescribe con la corrección. Si ya se
// envió, NO se reenvía (podría duplicar el ajuste en el ERP) -- se avisa.
function _reencolarCorreccion_() {
  if (!CONTEO_ACTUAL.queueId) return;
  const cola = leerSeguro(CLAVE_INV_COLA, []);
  const idx = cola.findIndex(e => e.id === CONTEO_ACTUAL.queueId);
  if (idx === -1) {
    toast('Este conteo ya se había enviado al servidor. Para corregirlo, avisa para un ajuste manual en el ERP o cuenta este producto de nuevo en un conteo nuevo.', 7000);
    return;
  }
  const items = CONTEO_ACTUAL.items
    .filter(it => it.cantidad !== null)
    .map(it => ({ codigo: it.codigo, descripcion: it.descripcion, cantidad: it.cantidad }));
  cola[idx].items = items;
  guardarSeguro(CLAVE_INV_COLA, cola);
  toast('Corrección guardada. Se enviará con el resto de la cola.');
}

// Payload: blanco no viaja, 0 explícito sí. teorico_ref/referencia_ts solo
// como contexto para el ERP -- el ajuste se calcula allá.
function _armarPayloadConteo_(conteo, fechaISO, stockMap, referenciaTs) {
  const items = conteo.items
    .filter(it => it.cantidad !== null)
    .map(it => {
      const e = stockMap ? stockMap.get(String(it.codigo || '').toLowerCase()) : null;
      return { codigo: it.codigo, descripcion: it.descripcion, cantidad: it.cantidad,
               teorico_ref: e ? e.stock : null };
    });
  return {
    id: (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID()
        : 'cnt_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9),
    fecha: fechaISO,
    categoria: conteo.categoria,
    contador: conteo.contador || '',
    referencia_ts: referenciaTs || '',
    items: items,
  };
}

let _procConteoEnCurso = false;

function _encolarConteo(conteo) {
  const cacheST = leerSeguro(CLAVE_INV_STOCK, null);
  const payload = _armarPayloadConteo_(conteo, _fechaLocalDireccion_(), STOCK_TEORICO, cacheST && cacheST.ts);
  CONTEO_ACTUAL.queueId = payload.id;
  const cola = leerSeguro(CLAVE_INV_COLA, []);
  if (!_dedupeCola_(cola, payload.id)) cola.push({ ...payload, ts: Date.now(), _try: 0 });
  const guardado = guardarSeguro(CLAVE_INV_COLA, cola);
  _guardarConteoActual_();
  _avisarPendientesInventario_();
  if (!guardado) {
    // Memoria llena: nunca decir "en cola" si no se guardó.
    CONTEO_ACTUAL._colaFallo = true;
    _guardarConteoActual_();
    toast('⚠️ No se pudo guardar en la cola (memoria del teléfono llena). Este conteo puede perderse -- libera espacio o repórtalo.', 8000);
    return;
  }
  // Se intenta enviar solo si el PIN sigue vigente; si no, queda en la cola
  // para "Enviar conteos pendientes" (que sí pide el PIN).
  procesarColaConteo(false);
}

const MAX_INTENTOS_AVISO = 10; // ~5 min a 30s/intento: a partir de aquí se marca "atascado"

async function procesarColaConteo(pedir) {
  if (_procConteoEnCurso || !navigator.onLine) return;
  const url = localStorage.getItem('sumetec_direccion_url');
  if (!url) return;
  const cola = leerSeguro(CLAVE_INV_COLA, []);
  if (!cola.length) return;
  let token = null;
  try { token = await _tokenInventario_(!!pedir); } catch (_) { return; }
  if (!token) return;
  _procConteoEnCurso = true;
  try {
    for (const item of [...cola]) {
      try {
        const res = await fetch(url, {
          method: 'POST', headers: { 'Content-Type': 'text/plain' },
          body: JSON.stringify({ tipo: 'conteo_inventario', token, ...item }),
        });
        const d = await res.json();
        if (d && d.ok) {
          const actual = leerSeguro(CLAVE_INV_COLA, []);
          // Si se corrigió una cantidad MIENTRAS viajaba, llegó la versión
          // vieja: se avisa (el ERP es idempotente por ID, un reenvío con el
          // mismo ID se ignoraría y haría creer que se corrigió).
          const enCola = actual.find(e => e.id === item.id);
          if (enCola && JSON.stringify(enCola.items) !== JSON.stringify(item.items)) {
            toast('⚠️ Corregiste una cantidad mientras el conteo se enviaba: viajó la cantidad anterior. Avisa para un ajuste manual en el ERP o cuenta ese producto en un conteo nuevo.', 9000);
          }
          guardarSeguro(CLAVE_INV_COLA, actual.filter(e => e.id !== item.id));
        } else {
          _bumpIntentoConteo(item.id);
        }
      } catch (_) {
        _bumpIntentoConteo(item.id);
      }
    }
  } finally {
    _procConteoEnCurso = false;
    _avisarPendientesInventario_();
  }
}

function _bumpIntentoConteo(id) {
  const cola = leerSeguro(CLAVE_INV_COLA, []);
  cola.forEach(e => { if (e.id === id) e._try = (e._try || 0) + 1; });
  guardarSeguro(CLAVE_INV_COLA, cola);
}

// Lo suma estado() (app.js) al chip de pendientes de la barra de arriba.
function _pendientesInventario_() {
  return leerSeguro(CLAVE_INV_COLA, []).length;
}
function _avisarPendientesInventario_() {
  if (typeof estado === 'function') estado();
}

function verColaPendiente() {
  const cola = leerSeguro(CLAVE_INV_COLA, []).sort((a, b) => (a.ts || 0) - (b.ts || 0));
  if (!cola.length) {
    toast('No hay conteos pendientes de enviar.');
    if (_enInventario_() && !document.getElementById('chkTodo')) renderSelectorCategoria();
    return;
  }
  const filas = cola.map(e => {
    const atascado = (e._try || 0) >= MAX_INTENTOS_AVISO;
    return `
    <div class="fila-producto">
      <div class="info">
        <div>${esc(e.categoria)} — ${e.items.length} producto(s)</div>
        <div class="codigo">Fecha ${esc(e.fecha)} · intento ${e._try || 0}${atascado ? ' <span class="text-rojo">⚠️ atascado</span>' : ''}</div>
      </div>
      <button class="btn btn-outline-secondary" aria-label="Reenviar" onclick="_reenviarUno_('${e.id}')"><i class="bi bi-arrow-repeat"></i></button>
      <button class="btn btn-danger" aria-label="Descartar" onclick="_descartarUno_('${e.id}')"><i class="bi bi-trash"></i></button>
    </div>`;
  }).join('');
  _pintarInventario_(`
    <div class="card card-body">
      <strong>Conteos pendientes de enviar (${cola.length})</strong>
      <p class="text-muted" style="font-size:12px;margin:4px 0 8px">Se reintentan solos cada 30 s con señal mientras tu PIN siga vigente. "Atascado" = lleva ${MAX_INTENTOS_AVISO}+ intentos fallidos — revisa la conexión o avisa.</p>
      ${filas}
      ${_BTN_VOLVER_SELECTOR_}
    </div>`);
}
function _reenviarUno_(id) {
  const cola = leerSeguro(CLAVE_INV_COLA, []);
  cola.forEach(e => { if (e.id === id) e._try = 0; });
  guardarSeguro(CLAVE_INV_COLA, cola);
  procesarColaConteo(true).then(verColaPendiente);
}
function _descartarUno_(id) {
  if (!confirm('¿Descartar este conteo pendiente? Esos datos NO llegarán al ERP y esta acción no se puede deshacer.')) return;
  guardarSeguro(CLAVE_INV_COLA, leerSeguro(CLAVE_INV_COLA, []).filter(e => e.id !== id));
  _avisarPendientesInventario_();
  verColaPendiente();
}

window.addEventListener('online', function () { procesarColaConteo(false); });
setInterval(function () { procesarColaConteo(false); }, 30000);
