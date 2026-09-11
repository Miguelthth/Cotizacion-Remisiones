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
// gastos-inventario.html). Vive aquí porque el Corte es quien más duele.
function _fechaLocalDireccion_(d) {
  d = d || new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// El corte se compara contra lo que el SERVIDOR tiene de ese día. Si el
// teléfono todavía trae capturas en cola (una compra hecha sin señal, un
// movimiento de caja), el arqueo se hace contra una foto incompleta y la
// diferencia que salga es falsa. Plan §9, línea 732.
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

function _filaDenominacion(valor) {
  const etiqueta = valor >= 1 ? `$${valor}` : `${valor * 100}¢`;
  return `<label class="denominacion" data-valor="${valor}">${etiqueta}
    <input type="number" min="0" step="1" value="0" class="cant-denominacion">
  </label>`;
}

function formularioCorteDireccion() {
  return `<h1>Corte</h1>
<p>Compara únicamente el efectivo contado contra los movimientos de efectivo del día.</p>
<form id="form-corte">
  <label>Fecha<input name="fecha" type="date" required></label>
  <label>Fondo inicial<input name="fondo" type="number" min="0" step="0.01" value="0"></label>
  <fieldset id="denominaciones-corte">
    <legend>Efectivo contado -- billete por billete</legend>
    ${DENOMINACIONES_MXN.map(_filaDenominacion).join('')}
  </fieldset>
  <label>Efectivo contado (suma de arriba)
    <input name="contado" type="number" min="0" step="0.01" required readonly>
  </label>
  <button type="button" id="ver-previa">Ver previa</button>
  <button>Cerrar corte</button>
</form>
<pre id="resultado-corte" role="status"></pre>`;
}

// Separada de la lectura del DOM para poder probarla sin navegador: dado
// [{valor, cantidad}, ...] regresa el total en efectivo -- exactamente lo
// que exige el plan (denominaciones y "efectivo contado" deben coincidir al
// centavo, línea 730).
function _sumaDenominaciones(pares) {
  return pares.reduce((suma, p) => suma + Number(p.valor) * (Number(p.cantidad) || 0), 0);
}

function _recalcularContadoDesdeDenominaciones(f) {
  const pares = [...f.querySelectorAll('#denominaciones-corte .denominacion')].map(label => ({
    valor: label.dataset.valor,
    cantidad: label.querySelector('.cant-denominacion').value
  }));
  f.contado.value = _sumaDenominaciones(pares).toFixed(2);
}

function activarCorteDireccion() {
  const f = document.querySelector('#form-corte');
  const out = document.querySelector('#resultado-corte');
  if (!f) return;
  f.fecha.value = _fechaLocalDireccion_();

  f.querySelectorAll('.cant-denominacion').forEach(input => {
    input.oninput = () => _recalcularContadoDesdeDenominaciones(f);
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
    out.textContent = `Esperado: $${c.esperado.toFixed(2)}\n` +
      `Diferencia: $${c.diferencia.toFixed(2)}\n` +
      `Movimientos incluidos: ${p.n || 0}`;
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
        throw Error(`No se puede cerrar: hay ${pendientes} captura(s) sin enviar en este ` +
          `teléfono. El arqueo se compara contra el servidor, así que la diferencia ` +
          `saldría falsa. Envíalas primero (Compras → "Enviar compras pendientes", o ` +
          `Caja → "Enviar movimientos pendientes").`);
      }
      const pin = await pedirPinDireccion();
      const p = await previa(pin);
      const r = await cerrarCorteDireccion(pin, {
        fecha: f.fecha.value, fondo: f.fondo.value, contado: f.contado.value,
        hashResumen: p.hashResumen || ''
      });
      out.textContent = `Corte guardado. Esperado: $${Number(r.esperado).toFixed(2)} · ` +
        `Diferencia: $${Number(r.diferencia).toFixed(2)}`;
      estado();
    } catch (err) {
      out.textContent = err.message;
    }
  };
}
