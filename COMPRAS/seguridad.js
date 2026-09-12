// Copia de 14.- SUMETEC DIRECCION/seguridad.js -- MISMO mecanismo (PBKDF2 +
// AES-GCM, PIN nunca en localStorage), solo cambian las claves de guardado
// para no chocar con Dirección si algún día comparten dominio de GitHub
// Pages (plan de diseño §3.A). PIN propio para Compras -- decisión de
// Miguel (2026-09-11): aquí se pagan proveedores, mismo criterio de
// seguridad que el corte de caja.
const SESION_KEY = 'sumetec_compras_sesion';

let PIN_TIMEOUT_MS = 600000;

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
  const key = await _claveDireccion(pin, new Uint8Array(r.salt));
  let plano;
  try {
    plano = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(r.iv) }, key, new Uint8Array(r.c)
    );
  } catch (_) {
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
