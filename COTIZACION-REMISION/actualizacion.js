/* Actualización segura: conserva una captura serializable antes de activar
   un Service Worker ya descargado. No guarda token, contraseña ni archivos. */
(function(){
  const CLAVE = 'sumetec_remisiones_actualizacion';
  const OMITIR = new Set(['api_token_input', '_pinInp']);
  const selectorCampos = 'input:not([type="file"]):not([type="password"]),textarea,select,[contenteditable="true"]';

  function capa(mostrar){
    const el = document.getElementById('sumetecActualizacion');
    if(el) el.classList.toggle('activo', !!mostrar);
  }

  function serializarCampo(el){
    return {
      tag: el.tagName, type: el.type || '',
      valor: el.isContentEditable ? el.textContent : el.value,
      marcado: el.type === 'checkbox' || el.type === 'radio' ? el.checked : undefined
    };
  }

  function guardarContexto(buildDestino){
    if([...document.querySelectorAll('input[type="file"]')].some(el => el.files && el.files.length)) {
      throw new Error('hay un archivo que el navegador no puede restaurar de forma segura');
    }
    const campos = [...document.querySelectorAll(selectorCampos)]
      .filter(el => !OMITIR.has(el.id))
      .map(serializarCampo);
    return { schema: 1, buildDestino, campos, guardadoEn: Date.now() };
  }

  function restaurarContexto(){
    const raw = sessionStorage.getItem(CLAVE);
    if(!raw) return false;
    let contexto;
    try { contexto = JSON.parse(raw); } catch(_) { sessionStorage.removeItem(CLAVE); return false; }
    if(contexto.schema !== 1 || contexto.buildDestino !== VERSION_CODIGO || !Array.isArray(contexto.campos)) return false;
    const campos = [...document.querySelectorAll(selectorCampos)].filter(el => !OMITIR.has(el.id));
    contexto.campos.forEach((dato, i) => {
      const el = campos[i];
      if(!el || el.tagName !== dato.tag || (el.type || '') !== dato.type) return;
      if(el.isContentEditable) el.textContent = dato.valor;
      else if(el.type === 'checkbox' || el.type === 'radio') el.checked = !!dato.marcado;
      else el.value = dato.valor;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    sessionStorage.removeItem(CLAVE);
    navigator.serviceWorker.controller?.postMessage({ type: 'CONFIRMAR_ARRANQUE' });
    return true;
  }

  async function releaseDisponible(){
    const respuesta = await fetch('./release.json', { cache: 'no-store' });
    if(!respuesta.ok) throw new Error('release.json HTTP ' + respuesta.status);
    return respuesta.json();
  }

  function esperarWorkerListo(registro){
    if(registro.waiting) return Promise.resolve(registro.waiting);
    return new Promise(resolve => {
      const observar = worker => {
        if(!worker) return;
        worker.addEventListener('statechange', () => {
          if(worker.state === 'installed' && registro.waiting) resolve(registro.waiting);
        });
      };
      observar(registro.installing);
      registro.addEventListener('updatefound', () => observar(registro.installing), { once: true });
    });
  }

  async function revisar(registro){
    if(!navigator.onLine || sessionStorage.getItem(CLAVE)) return;
    let release;
    try { release = await releaseDisponible(); } catch(_) { return; }
    if(!release.build || release.build === VERSION_CODIGO) return;
    await registro.update();
    const worker = await esperarWorkerListo(registro);
    if(!worker || sessionStorage.getItem(CLAVE)) return;
    let contexto;
    try { contexto = guardarContexto(release.build); } catch(error) {
      console.warn('Actualización aplazada:', error.message);
      return;
    }
    sessionStorage.setItem(CLAVE, JSON.stringify(contexto));
    capa(true);
    worker.postMessage({ type: 'ACTIVAR_ACTUALIZACION' });
  }

  window.iniciarActualizaciones = async function iniciarActualizaciones(){
    if(!('serviceWorker' in navigator)) return;
    if(restaurarContexto()) {
      capa(true);
      requestAnimationFrame(() => setTimeout(() => capa(false), 250));
    }
    const registro = await navigator.serviceWorker.register('./sw.js');
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if(sessionStorage.getItem(CLAVE)) location.reload();
    }, { once: true });
    const ejecutar = () => revisar(registro).catch(error => console.warn('Actualización:', error));
    ejecutar();
    setInterval(ejecutar, 5 * 60 * 1000);
    document.addEventListener('visibilitychange', () => { if(document.visibilityState === 'visible') ejecutar(); });
    window.addEventListener('online', ejecutar);
  };
})();
