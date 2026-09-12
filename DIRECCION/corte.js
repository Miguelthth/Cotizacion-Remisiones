// Billetes y monedas de circulación en México. El "Efectivo contado" del
// formulario se calcula SOLO a partir de estas cantidades -- así la suma de
// denominaciones y el efectivo contado coinciden al centavo por
// construcción, en vez de depender de que Miguel sume bien a mano (plan
// §9, línea 730).
// Ecosistema centralizado (2026-09): mismo valor de fábrica de siempre --
// ver _aplicarConfigDireccionPublicada_ en dashboard.js, que lo puede
// reemplazar con lo que publique el ERP.
let DENOMINACIONES_MXN = [1000, 500, 200, 100, 50, 20, 10, 5, 2, 1, 0.5];

// Fecha LOCAL, nunca UTC. toISOString() da la fecha en UTC: en Tijuana
// (UTC-7/-8) a partir de las ~17:00 ya devuelve la de MAÑANA. Un corte
// cerrado a la hora de cerrar la tienda pedía por eso los movimientos de un
// día que todavía no existe -- esperado = solo el fondo inicial, así que el
// efectivo del día entero salía como "sobrante" -- y la fila quedaba
// archivada en CortesCaja con la fecha equivocada. Caja y Compras tenían el
// mismo defecto. Mismo arreglo que Gastos ya traía (_fechaLocal_ en
// gastos.html). Vive aquí porque el Corte es quien más duele.
function _fechaLocalDireccion_(d) {
  d = d || new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// El corte se compara contra lo que el SERVIDOR tiene de ese día. Si el
// teléfono todavía trae capturas en cola (un movimiento de caja, un corte
// previo sin subir), el arqueo se hace contra una foto incompleta y la
// diferencia que salga es falsa. Plan §9, línea 732.
//
// Desde que Compras salió como app propia (F3 del plan de diseño,
// 2026-09-11), su cola vive en OTRA app -- este teléfono puede tener
// compras sin enviar ahí que Dirección ya NO puede ver (localStorage por
// origen). El chip de "N pendientes" de Compras es ahora la única señal:
// revísalo ahí antes de cerrar un corte aquí.
function _pendientesSinEnviarDireccion_() {
  if (typeof COLAS === 'undefined' || typeof leer !== 'function') return 0;
  return Object.values(COLAS).reduce((total, k) => total + leer(k).length, 0);
}

function calcularCorte(m) {
  const esperado = Number(m.fondo || 0) + Number(m.entradasEfectivo || 0) - Number(m.salidasEfectivo || 0);
  const contado = Number(m.contado || 0);
  return { ...m, esperado, diferencia: contado - esperado };
}

async function previaCorteDireccion(pin, fecha) {
  const url = localStorage.getItem('sumetec_direccion_url');
  const token = await abrirSesionDireccion(pin);
  return fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ tipo: 'corte_previo_cloud', fecha, token })
  }).then(r => r.json());
}

async function cerrarCorteDireccion(pin, datos) {
  const url = localStorage.getItem('sumetec_direccion_url');
  const token = await abrirSesionDireccion(pin);
  const corte = { ...datos, id: datos.id || crypto.randomUUID(), tipo: 'cerrar_corte_cloud', token, origen: 'direccion' };
  const r = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(corte)
  }).then(x => x.json());
  if (!r.ok) throw Error(r.error || 'No se pudo cerrar');
  return r;
}

// "El cajón" (F2 del plan de diseño, 2026-09-11): cada denominación tiene el
// color real del billete/moneda -- lo único de las apps que NO sale del tema
// del ERP (decisión explícita de Miguel, ver PLAN_DISENO_TEMA_ERP §1).
// Token CSS por denominación (definidos en estilos.css); un valor que el ERP
// llegara a publicar sin color propio (billete que no existe hoy) cae en
// --sm-muted -- nunca se rompe, solo se ve neutro.
const _COLOR_DENOMINACION_MXN = {
  1000: '--billete-1000', 500: '--billete-500', 200: '--billete-200',
  100: '--billete-100', 50: '--billete-50', 20: '--billete-20',
  10: '--billete-10', 5: '--billete-5', 2: '--billete-2', 0.5: '--billete-0-5'
};
function _colorDenominacion(valor) {
  return `var(${_COLOR_DENOMINACION_MXN[valor] || '--sm-muted'})`;
}

function _filaDenominacion(valor) {
  const etiqueta = valor >= 1 ? `$${valor}` : `${valor * 100}¢`;
  const color = _colorDenominacion(valor);
  // La cantidad SIGUE siendo un <input type=number> real (no solo +/-):
  // Miguel puede escribir "37" directamente para cantidades grandes en vez
  // de tocar 37 veces (plan: "tocar = +1; botón − para restar; teclado para
  // cantidades grandes"). data-valor es lo que lee _recalcularContadoDesde-
  // Denominaciones -- sin cambios ahí.
  return `<div class="denominacion" data-valor="${valor}" style="--color-billete:${color}">
    <button type="button" class="billete-boton billete-menos" aria-label="Quitar un ${etiqueta}">−</button>
    <div class="billete-cuerpo">
      <span class="billete-etiqueta">${etiqueta}</span>
      <input type="number" min="0" step="1" value="0" class="cant-denominacion" aria-label="Cantidad de ${etiqueta}">
    </div>
    <button type="button" class="billete-boton billete-mas" aria-label="Agregar un ${etiqueta}">+</button>
  </div>`;
}

function formularioCorteDireccion() {
  return `<h1>Corte</h1>
<p class="text-muted">Compara únicamente el efectivo contado contra los movimientos de efectivo del día.</p>
<p class="text-aviso">Revisa también Compras: sus pendientes sin enviar ya no se ven desde aquí.</p>
<form id="form-corte" class="card"><div class="card-body" style="display:grid;gap:10px">
  <label class="form-label" for="corte-fecha">Fecha<input id="corte-fecha" class="form-control" name="fecha" type="date" required></label>
  <label class="form-label" for="corte-fondo">Fondo inicial<input id="corte-fondo" class="form-control" name="fondo" type="number" min="0" step="0.01" value="0"></label>
  <fieldset id="denominaciones-corte" class="billetero">
    <legend class="form-label">Efectivo contado -- billete por billete</legend>
    ${DENOMINACIONES_MXN.map(_filaDenominacion).join('')}
  </fieldset>
  <div id="barra-efectivo" class="barra-efectivo" role="img" aria-label="Composición del efectivo contado, por denominación"></div>
  <label class="form-label" for="corte-contado">Efectivo contado (suma de arriba)
    <input id="corte-contado" class="form-control num" name="contado" type="number" min="0" step="0.01" required readonly>
  </label>
  <div class="fila">
    <button type="button" id="ver-previa" class="btn btn-outline-secondary"><i class="bi bi-search"></i> Ver previa</button>
    <button class="btn btn-success"><i class="bi bi-check-circle"></i> Cerrar corte</button>
  </div>
</div></form>
<div id="resultado-corte" class="card" style="padding:12px 14px" role="status"></div>`;
}

// Separada de la lectura del DOM para poder probarla sin navegador: dado
// [{valor, cantidad}, ...] regresa el total en efectivo -- exactamente lo
// que exige el plan (denominaciones y "efectivo contado" deben coincidir al
// centavo, línea 730).
function _sumaDenominaciones(pares) {
  return pares.reduce((suma, p) => suma + Number(p.valor) * (Number(p.cantidad) || 0), 0);
}

// Pura y testable, igual que _sumaDenominaciones: dado el mismo [{valor,
// cantidad}] y el total ya calculado, regresa los segmentos de la barra
// (uno por denominación con cantidad > 0), como % del total. El color nunca
// es la única señal -- la denominación sigue escrita en cada ficha de
// arriba (plan §3), esta barra es solo composición visual.
function _segmentosEfectivo(pares, total) {
  if (!(total > 0)) return [];
  return pares
    .map(p => ({ valor: Number(p.valor), monto: Number(p.valor) * (Number(p.cantidad) || 0) }))
    .filter(s => s.monto > 0)
    .map(s => ({ valor: s.valor, pct: (s.monto / total) * 100 }));
}

function _htmlBarraEfectivo(segmentos) {
  if (!segmentos.length) return '';
  return segmentos.map(s =>
    `<span style="width:${s.pct.toFixed(3)}%;background:${_colorDenominacion(s.valor)}"></span>`
  ).join('');
}

function _recalcularContadoDesdeDenominaciones(f) {
  const pares = [...f.querySelectorAll('#denominaciones-corte .denominacion')].map(label => ({
    valor: label.dataset.valor,
    cantidad: label.querySelector('.cant-denominacion').value
  }));
  const total = _sumaDenominaciones(pares);
  f.contado.value = total.toFixed(2);
  const barra = f.querySelector('#barra-efectivo');
  if (barra) barra.innerHTML = _htmlBarraEfectivo(_segmentosEfectivo(pares, total));
}

// Tocar +/- suma o resta un billete a la vez (plan §3); dispatchEvent
// 'input' reusa el mismo oninput que ya escucha cada campo más abajo -- no
// hay dos caminos distintos para el mismo recálculo.
function _ajustarDenominacion(boton, delta) {
  const chip = boton.closest('.denominacion');
  const input = chip && chip.querySelector('.cant-denominacion');
  if (!input) return;
  input.value = Math.max(0, (Number(input.value) || 0) + delta);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

// Verde (cuadra), latón/aviso (sobra) u óxido/rojo (falta) -- mismos tres
// tokens del tema que usa el resto de las apps para "diferencia" (plan §1).
function _claseDiferencia(diferencia) {
  if (Math.abs(diferencia) < 0.005) return 'text-verde';
  return diferencia > 0 ? 'text-aviso' : 'text-rojo';
}
function _etiquetaDiferencia(diferencia) {
  if (Math.abs(diferencia) < 0.005) return '✓ Cuadra';
  return diferencia > 0 ? 'Sobra' : 'Falta';
}

// Todo lo interpolado aquí es numérico (Number()/toFixed ya lo garantiza) --
// nunca texto libre del servidor, así que innerHTML es seguro. Los mensajes
// de error (texto libre: r.error, e.message) se siguen mostrando con
// textContent más abajo, nunca con innerHTML.
function _htmlResumenCorte(c, n) {
  return `<p>Esperado: <strong class="num">$${c.esperado.toFixed(2)}</strong></p>
<p>Diferencia: <strong class="num ${_claseDiferencia(c.diferencia)}">${_etiquetaDiferencia(c.diferencia)} $${Math.abs(c.diferencia).toFixed(2)}</strong></p>
<p class="text-muted">Movimientos incluidos: ${Number(n) || 0}</p>`;
}

function activarCorteDireccion() {
  const f = document.querySelector('#form-corte');
  const out = document.querySelector('#resultado-corte');
  if (!f) return;
  f.fecha.value = _fechaLocalDireccion_();

  f.querySelectorAll('.cant-denominacion').forEach(input => {
    input.oninput = () => _recalcularContadoDesdeDenominaciones(f);
  });
  document.querySelector('#denominaciones-corte').addEventListener('click', e => {
    const menos = e.target.closest('.billete-menos');
    const mas = e.target.closest('.billete-mas');
    if (menos) _ajustarDenominacion(menos, -1);
    else if (mas) _ajustarDenominacion(mas, 1);
  });

  // Un solo PIN por sesión (cacheado en memoria hasta por 10 min): antes se
  // pedía hasta 3 veces para cerrar un mismo corte (previa, submit, y una
  // "confirmación" repetida que no agregaba seguridad real).
  const previa = async pin => {
    const p = await previaCorteDireccion(pin, f.fecha.value);
    if (!p.ok) throw Error(p.error || 'No se pudo consultar la previa');
    const c = calcularCorte({
      fondo: f.fondo.value, entradasEfectivo: p.entradasEfectivo,
      salidasEfectivo: p.salidasEfectivo, contado: f.contado.value
    });
    out.innerHTML = _htmlResumenCorte(c, p.n);
    return p;
  };

  document.querySelector('#ver-previa').onclick = async () => {
    try {
      const pin = await pedirPinDireccion();
      await previa(pin);
    } catch (e) {
      out.textContent = e.message;
    }
  };

  f.onsubmit = async e => {
    e.preventDefault();
    try {
      const pendientes = _pendientesSinEnviarDireccion_();
      if (pendientes) {
        // 2026-09-09 (DIR-K01): el mensaje solo mandaba a Compras, pero la
        // cola sin enviar puede ser de un movimiento de Caja -- que hasta
        // hoy no tenía a dónde enviarse. Ahora Caja también tiene su botón.
        // 2026-09-11 (F3): esto ya NO incluye Compras -- su cola vive en su
        // propia app desde que se separó, invisible aquí. El texto ya no la
        // menciona como si Dirección la pudiera detectar (sería mentira);
        // el aviso fijo de arriba en el formulario cubre ese recordatorio.
        throw Error(`No se puede cerrar: hay ${pendientes} captura(s) sin enviar en este ` +
          `teléfono. El arqueo se compara contra el servidor, así que la diferencia ` +
          `saldría falsa. Envíalas primero (Caja → "Enviar movimientos pendientes").`);
      }
      const pin = await pedirPinDireccion();
      const p = await previa(pin);
      const r = await cerrarCorteDireccion(pin, {
        fecha: f.fecha.value, fondo: f.fondo.value, contado: f.contado.value,
        hashResumen: p.hashResumen || ''
      });
      const dif = Number(r.diferencia);
      out.innerHTML = `<p><strong class="text-verde">Corte guardado.</strong></p>` +
        `<p>Esperado: <strong class="num">$${Number(r.esperado).toFixed(2)}</strong></p>` +
        `<p>Diferencia: <strong class="num ${_claseDiferencia(dif)}">${_etiquetaDiferencia(dif)} $${Math.abs(dif).toFixed(2)}</strong></p>`;
      estado();
    } catch (err) {
      out.textContent = err.message;
    }
  };
}
