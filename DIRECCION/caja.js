const CLASES_CAJA_DIRECCION = [
  'APORTE_SOCIO', 'RETIRO_SOCIO', 'DEPOSITO_BANCO',
  'DEVOLUCION_CLIENTE', 'ENTRADA_AJUSTE', 'SALIDA_AJUSTE'
];

function validarMovimientoDireccion(d) {
  const clase = String(d.clase || '').trim().toUpperCase();
  const monto = Number(d.monto);
  const concepto = String(d.concepto || '').trim();
  const cuentaSocio = String(d.cuentaSocio || '').trim();

  if (!CLASES_CAJA_DIRECCION.includes(clase)) throw Error('Clase de movimiento no permitida');
  if (!d.fecha || !Number.isFinite(monto) || monto <= 0 || !d.metodo || !concepto) {
    throw Error('Completa fecha, monto, método y concepto');
  }
  if (['APORTE_SOCIO', 'RETIRO_SOCIO'].includes(clase) && !cuentaSocio) {
    throw Error('Selecciona el socio responsable');
  }
  if (['ENTRADA_AJUSTE', 'SALIDA_AJUSTE'].includes(clase) && concepto.length < 10) {
    throw Error('El ajuste requiere explicación de al menos 10 caracteres');
  }
  return {
    id: d.id || crypto.randomUUID(), fecha: d.fecha, hora: d.hora || new Date().toISOString(),
    tipoMovimiento: clase, monto, metodo: String(d.metodo).toUpperCase(),
    referencia: String(d.referencia || ''), notas: concepto, cuentaSocio
  };
}

function formularioCajaDireccion() {
  return `<h1>Caja</h1>
<p>Movimientos físicos del cajón. No son ventas ni gastos.</p>
<form id="form-caja">
  <label>Movimiento
    <select name="clase">${CLASES_CAJA_DIRECCION.map(x => `<option>${x}</option>`).join('')}</select>
  </label>
  <label>Fecha<input name="fecha" type="date" required></label>
  <label>Monto<input name="monto" type="number" min="0.01" step="0.01" required></label>
  <label>Método
    <select name="metodo"><option>EFECTIVO</option><option>TRANSFERENCIA</option><option>TARJETA</option></select>
  </label>
  <label>Socio (aporte/retiro)<input name="cuentaSocio" value="JOSE MIGUEL"></label>
  <label>Referencia (si aplica)<input name="referencia"></label>
  <label>Concepto / explicación<textarea name="concepto" required></textarea></label>
  <button>Guardar movimiento</button>
</form>
<p id="resultado-caja" role="status"></p>
<button id="enviar-movimientos" type="button">Enviar movimientos pendientes</button>
<section id="lista-caja">
  <h2>Movimientos de hoy</h2>
  <p>Toca "Ver movimientos" para consultarlos.</p>
  <button id="ver-movimientos" type="button">Ver movimientos</button>
</section>`;
}

// Hallazgo DIR-K01 (auditoría de ecosistema 2026-09-09): un movimiento
// guardado offline (COLAS.movimientos, arriba) no tenía NINGUNA función que
// lo enviara -- ni un botón manual como el de Compras, ni el evento
// `online`. Se quedaba atorado para siempre, y `_pendientesSinEnviarDireccion_`
// (corte.js) bloqueaba el cierre del corte por una cola que nadie podía
// vaciar desde la app. Mismo patrón que compras.js::enviarComprasCampo: se
// vuelve a leer la cola VIGENTE antes de guardar, por si se capturó algo
// nuevo mientras el envío (uno por uno) estaba en curso.
async function enviarMovimientosDireccion(pin) {
  const url = localStorage.getItem('sumetec_direccion_url');
  if (!url) throw Error('Vincula el teléfono primero');
  const token = await abrirSesionDireccion(pin);
  const cola = leer(COLAS.movimientos);
  const idsEnviados = [];

  for (const mov of cola) {
    const r = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ ...mov, tipo: 'movimiento_caja', token, origen: 'direccion' })
    }).then(x => x.json());
    // El servidor dedupe por id (registrarMovimientoCaja_): CREADO o
    // YA_EXISTIA son los dos resultados en los que el movimiento YA está
    // registrado y puede salir de la cola.
    if (r.ok && (r.estado === 'CREADO' || r.estado === 'YA_EXISTIA')) idsEnviados.push(mov.id);
  }

  const colaVigente = leer(COLAS.movimientos);
  const pendientes = colaVigente.filter(m => idsEnviados.indexOf(m.id) === -1);
  localStorage.setItem(COLAS.movimientos, JSON.stringify(pendientes));
  estado();
  return pendientes.length;
}

// Identidad estable de UNA captura de caja (hallazgo DIR-01, 2026-09-09).
//
// El servidor deduplica movimientos por `id` (apps_script.js::
// registrarMovimientoCaja_). Pero el id se generaba dentro de
// validarMovimientoDireccion en CADA envío, y en el camino con conexión no
// quedaba rastro local de nada: si la respuesta se perdía (conexión
// intermitente) y Miguel volvía a dar Guardar con los mismos datos, salía un
// UUID distinto y la caja registraba el aporte DOS veces. $200 por uno de $100.
//
// Ahora el id se ata a la CAPTURA, no al envío: se conserva mientras ese
// movimiento no se haya confirmado, así el reintento es el mismo movimiento
// para el servidor. Se suelta al confirmar, y también cuando el servidor
// respondió explícitamente que NO se guardó (ahí sí sabemos que no quedó
// nada, y una corrección debe salir como movimiento nuevo).
let _idCapturaCaja = null;
function idCapturaCaja() {
  if (!_idCapturaCaja) _idCapturaCaja = crypto.randomUUID();
  return _idCapturaCaja;
}
function soltarCapturaCaja() { _idCapturaCaja = null; }

async function guardarMovimientoDireccion(pin, datos) {
  const movimiento = validarMovimientoDireccion(datos);
  const url = localStorage.getItem('sumetec_direccion_url');

  if (!navigator.onLine) {
    const cola = leer(COLAS.movimientos);
    cola.push(movimiento);
    localStorage.setItem(COLAS.movimientos, JSON.stringify(cola));
    estado();
    return { ok: true, estado: 'EN_COLA' };
  }

  const token = await abrirSesionDireccion(pin);
  const r = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ ...movimiento, tipo: 'movimiento_caja', token, origen: 'direccion' })
  }).then(x => x.json());
  if (!r.ok) {
    // El servidor SÍ contestó, y contestó que no. Se marca para que quien
    // llama pueda soltar el id: no hay nada guardado que reintentar.
    const e = Error(r.error || 'No se pudo guardar el movimiento');
    e.respondioServidor = true;
    throw e;
  }
  return r;
}

// Tarea 16: corregir sin editar/borrar la fila original -- validación pura,
// probada sin red igual que validarMovimientoDireccion.
function validarAnulacionDireccion(d) {
  const anulaA = String(d.anulaA || '').trim();
  const motivo = String(d.motivo || '').trim();
  if (!anulaA) throw Error('Falta el movimiento a corregir');
  if (motivo.length < 10) throw Error('La corrección requiere explicación de al menos 10 caracteres');
  return { anulaA, motivo };
}

async function cargarMovimientosCajaDireccion(pin, fecha) {
  const url = localStorage.getItem('sumetec_direccion_url');
  if (!url) throw Error('Vincula el teléfono primero');
  const token = await abrirSesionDireccion(pin);
  const r = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ tipo: 'movimientos_del_dia', fecha, token })
  }).then(x => x.json());
  if (!r.ok) throw Error(r.error || 'No se pudieron consultar los movimientos');
  return r.movimientos;
}

async function anularMovimientoDireccion(pin, anulaA, motivo) {
  const { anulaA: id, motivo: m } = validarAnulacionDireccion({ anulaA, motivo });
  const url = localStorage.getItem('sumetec_direccion_url');
  if (!navigator.onLine) throw Error('Se necesita conexión para corregir un movimiento ya enviado');
  const token = await abrirSesionDireccion(pin);
  const r = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ tipo: 'anular_movimiento_caja', anulaA: id, motivo: m, token, origen: 'direccion' })
  }).then(x => x.json());
  if (!r.ok) throw Error(r.error || 'No se pudo corregir el movimiento');
  return r;
}

function _dineroCaja(v) { return '$' + Number(v || 0).toFixed(2); }

function renderMovimientosCaja(movs) {
  if (!movs.length) return '<p>Sin movimientos capturados hoy.</p>';
  const filas = movs.map(m => {
    const corregible = !m.anulado && m.tipo !== 'ANULACION';
    const ref = m.tipo === 'ANULACION' ? `corrige ${m.anulaA}` : (m.referencia || '—');
    const boton = corregible ? `<button type="button" class="anular" data-id="${m.id}">Corregir</button>` : '';
    return `<li data-id="${m.id}"><span>${m.signo}${_dineroCaja(m.monto)}</span> ` +
      `<strong>${m.tipo}</strong> · ${m.metodo} · ${m.origen} · ${ref}` +
      `${m.anulado ? ' · <em>anulado</em>' : ''} ${boton}</li>`;
  }).join('');
  return `<ul>${filas}</ul>`;
}

function activarCajaDireccion() {
  const f = document.querySelector('#form-caja');
  if (!f) return;
  f.fecha.value = _fechaLocalDireccion_();

  f.onsubmit = async e => {
    e.preventDefault();
    const boton = f.querySelector('button');
    if (boton) boton.disabled = true; // sin esto, dos toques = dos peticiones
    try {
      const d = Object.fromEntries(new FormData(f));
      d.id = idCapturaCaja(); // el reintento debe ser el MISMO movimiento
      const pin = await pedirPinDireccion();
      const r = await guardarMovimientoDireccion(pin, d);
      soltarCapturaCaja();
      f.reset();
      f.fecha.value = _fechaLocalDireccion_();
      document.querySelector('#resultado-caja').textContent = r.estado === 'EN_COLA'
        ? 'Guardado para enviar cuando vuelva la conexión.'
        : 'Movimiento registrado.';
      estado();
    } catch (err) {
      // Solo se suelta el id si el servidor dijo que NO se guardó. Ante un
      // fallo de red no sabemos si llegó, así que se conserva para que el
      // reintento no cuente como un movimiento distinto.
      if (err && err.respondioServidor) soltarCapturaCaja();
      document.querySelector('#resultado-caja').textContent = err.message;
    } finally {
      if (boton) boton.disabled = false;
    }
  };

  const enviarBtn = document.querySelector('#enviar-movimientos');
  if (enviarBtn) enviarBtn.onclick = async () => {
    try {
      const pin = await pedirPinDireccion();
      const n = await enviarMovimientosDireccion(pin);
      document.querySelector('#resultado-caja').textContent = n
        ? `${n} movimiento(s) siguen pendientes de enviar.`
        : 'Todos los movimientos en cola se enviaron.';
    } catch (err) {
      document.querySelector('#resultado-caja').textContent = err.message;
    }
  };

  const lista = document.querySelector('#lista-caja');

  async function refrescarLista(pin) {
    try {
      const movs = await cargarMovimientosCajaDireccion(pin, f.fecha.value || _fechaLocalDireccion_());
      lista.innerHTML = `<h2>Movimientos de hoy</h2>${renderMovimientosCaja(movs)}`;
      lista.querySelectorAll('button.anular').forEach(b => b.onclick = async () => {
        const motivo = prompt('Explica la corrección (mínimo 10 caracteres)');
        if (motivo === null) return;
        try {
          await anularMovimientoDireccion(pin, b.dataset.id, motivo);
          await refrescarLista(pin);
        } catch (err) {
          alert(err.message);
        }
      });
    } catch (err) {
      lista.innerHTML = `<h2>Movimientos de hoy</h2><p>${err.message}</p>`;
    }
  }

  const verBtn = document.querySelector('#ver-movimientos');
  if (verBtn) verBtn.onclick = async () => {
    try {
      const pin = await pedirPinDireccion();
      refrescarLista(pin);
    } catch (err) {
      // PIN cancelado -- no hacer nada.
    }
  };
}
