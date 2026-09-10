// ============================================================
// BITÁCORA DE SINCRONIZACIÓN (cliente) — Mejoras priorizadas 2026-08
// ------------------------------------------------------------
// Cola local de los últimos 100 eventos de sync (remisión/pago/PDF/
// cancelación/cotización/reintento ERP guardados u con error), para que el
// modal de Trazabilidad y el tablero de Excepciones tengan evidencia aunque
// no haya conexión. NUNCA guarda token ni PDF en base64.
// ============================================================

function agregarEvento(eventos, e) {
  e = e || {};
  var limpio = {
    fechaHora: new Date().toISOString(),
    folio: e.folio || '',
    operacion: e.operacion || '',
    resultado: e.resultado || 'OK',
    detalle: e.detalle || ''
  };
  return [limpio].concat(eventos || []).slice(0, 100);
}

function guardarEventoSync(e) {
  try {
    var prev = JSON.parse(localStorage.getItem('sync_eventos') || '[]');
    localStorage.setItem('sync_eventos', JSON.stringify(agregarEvento(prev, e)));
  } catch (_) { /* localStorage lleno o inaccesible: no bloquear la operación por esto */ }
}

function obtenerEventosSync(folio) {
  var todos = [];
  try { todos = JSON.parse(localStorage.getItem('sync_eventos') || '[]'); } catch (_) { todos = []; }
  if (!folio) return todos;
  return todos.filter(function(ev) { return String(ev.folio) === String(folio); });
}

// Exporta a Node para tests (node --test no tiene `window`).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { agregarEvento: agregarEvento, guardarEventoSync: guardarEventoSync, obtenerEventosSync: obtenerEventosSync };
}
