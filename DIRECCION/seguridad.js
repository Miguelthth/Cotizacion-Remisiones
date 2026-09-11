const SESION_KEY = 'sumetec_direccion_sesion';

// Ecosistema centralizado (2026-09): mismo valor de fábrica que ya estaba
// horneado aquí (10 min) -- ver _aplicarConfigDireccionPublicada_ en
// dashboard.js, que lo puede ajustar con lo que publique el ERP.
let PIN_TIMEOUT_MS = 600000;

// El token vinculado vive cifrado en localStorage (AES-GCM, clave derivada
// del PIN con PBKDF2). abrirSesionDireccion() lo descifra y renueva el
// timestamp de vigencia (10 min) cada vez que se usa.
async function _claveDireccion(pin, salt) {
  const material = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 210000, hash: 'SHA-256' },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}

async function guardarSesionDireccion(pin, token) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await _claveDireccion(pin, salt);
  const cifrado = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(token)
  );
  localStorage.setItem(SESION_KEY, JSON.stringify({
    salt: [...salt], iv: [...iv], c: [...new Uint8Array(cifrado)], ts: Date.now()
  }));
}

async function abrirSesionDireccion(pin) {
  const r = JSON.parse(localStorage.getItem(SESION_KEY) || 'null');
  if (!r) throw Error('Sin dispositivo vinculado');
  // Ya NO se rechaza aquí por "sesión vencida" antes de intentar descifrar:
  // ese rechazo previo dejaba el token inservible para siempre, porque
  // r.ts solo se renovaba DESPUÉS de un descifrado exitoso, y con el
  // rechazo puesto antes nunca se llegaba a intentarlo. El "vuelve a pedir
  // PIN cada 10 min" ya lo hace pedirPinDireccion()/_pinVigente() (el
  // caché del PIN vive en memoria, se pierde solo con reabrir la app) --
  // este token cifrado sigue siendo válido mientras el PIN sea correcto.
  const key = await _claveDireccion(pin, new Uint8Array(r.salt));
  let plano;
  try {
    plano = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(r.iv) }, key, new Uint8Array(r.c)
    );
  } catch (_) {
    // AES-GCM falla su verificación de integridad si la clave derivada del
    // PIN no es la correcta -- eso es un PIN mal tecleado, no un error del
    // navegador. Se borra también el PIN cacheado en memoria: sin esto,
    // pedirPinDireccion() seguía devolviendo el MISMO PIN incorrecto
    // durante los próximos 10 minutos en vez de volver a preguntar.
    _pinCache = null;
    _pinCacheTs = 0;
    throw Error('PIN incorrecto');
  }
  r.ts = Date.now();
  localStorage.setItem(SESION_KEY, JSON.stringify(r));
  return new TextDecoder().decode(plano);
}

function bloquearDireccion() {
  localStorage.removeItem(SESION_KEY);
  _pinCache = null;
  _pinCacheTs = 0;
}

// El PIN en sí NUNCA se guarda en localStorage -- solo vive en esta variable
// de memoria, y solo mientras el token siga vigente (mismos 10 minutos que
// abrirSesionDireccion). Antes cada pantalla pedía el PIN con prompt() (sin
// máscara, hasta 3 veces por corte); ahora se pide una sola vez por sesión
// con un campo type="password" de verdad.
let _pinCache = null;
let _pinCacheTs = 0;

function _pinVigente() {
  return _pinCache !== null && (Date.now() - _pinCacheTs) < PIN_TIMEOUT_MS;
}

function pedirPinDireccion() {
  if (_pinVigente()) return Promise.resolve(_pinCache);

  return new Promise((resolve, reject) => {
    const dialogo = document.querySelector('#pin-modal');
    const input = document.querySelector('#pin-modal-input');
    const error = document.querySelector('#pin-modal-error');
    error.textContent = '';
    input.value = '';

    const cerrar = () => {
      dialogo.removeEventListener('close', alCerrar);
      dialogo.removeEventListener('cancel', alCancelar);
    };
    const alCerrar = () => {
      cerrar();
      if (dialogo.returnValue !== 'ok') { reject(Error('PIN cancelado')); return; }
      const pin = input.value;
      if (pin.length < 4) { reject(Error('PIN inválido')); return; }
      _pinCache = pin;
      _pinCacheTs = Date.now();
      resolve(pin);
    };
    const alCancelar = () => { cerrar(); reject(Error('PIN cancelado')); };

    dialogo.addEventListener('close', alCerrar);
    dialogo.addEventListener('cancel', alCancelar);
    dialogo.showModal();
    input.focus();
  });
}
