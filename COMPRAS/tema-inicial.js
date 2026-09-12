// tema-inicial.js -- lo copia generar_tema.py a cada app; no editar las copias.
// Va en el <head>, ANTES del CSS, para que la app no parpadee en blanco
// antes de ponerse en modo noche. Mismo interruptor que el ERP:
// data-tema="oscuro" en <html>. La primera vez sigue al teléfono
// (prefers-color-scheme); si Miguel lo cambia con el botón, se recuerda.
(function () {
  var CLAVE = 'sumetec_tema';

  function preferido() {
    try {
      var guardado = localStorage.getItem(CLAVE);
      if (guardado === 'oscuro' || guardado === 'claro') return guardado;
    } catch (_) {}
    var oscuro = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    return oscuro ? 'oscuro' : 'claro';
  }

  function aplicar(tema) {
    if (tema === 'oscuro') document.documentElement.setAttribute('data-tema', 'oscuro');
    else document.documentElement.removeAttribute('data-tema');
  }

  aplicar(preferido());

  window.alternarTemaSumetec = function () {
    var nuevo = document.documentElement.getAttribute('data-tema') === 'oscuro' ? 'claro' : 'oscuro';
    aplicar(nuevo);
    try { localStorage.setItem(CLAVE, nuevo); } catch (_) {}
    return nuevo;
  };
})();
