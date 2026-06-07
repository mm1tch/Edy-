// popup.js — Edy popup controller
// Mirrors the 3 states (idle / observando / ejecutando) of the floating widget.
// Reads initial state from chrome.storage so it stays in sync after page navigations.

const DASHBOARD_URL = 'http://localhost:8000/dashboard';

// ─── Section references ──────────────────────────────────────────────────────
const secIdle       = document.getElementById('estado-idle');
const secObservando = document.getElementById('estado-observando');
const secEjecutando = document.getElementById('estado-ejecutando');

// ─── Button references ───────────────────────────────────────────────────────
const btnObservar  = document.getElementById('btn-observar');
const btnEjecutar  = document.getElementById('btn-ejecutar');
const btnDetener   = document.getElementById('btn-detener');
const btnDashboard = document.getElementById('btn-dashboard');

// ─── Observando UI ───────────────────────────────────────────────────────────
const listaCampos    = document.getElementById('lista-campos');
const contadorCampos = document.getElementById('contador-campos');
const barraObs       = document.getElementById('barra-obs');
let camposCount = 0;

// ─── Ejecutando UI ───────────────────────────────────────────────────────────
const listaPasos = document.getElementById('lista-pasos');
const barraEje   = document.getElementById('barra-eje');

// ─────────────────────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────────────────────
function mostrarEstado(estado) {
  secIdle.classList.toggle('hidden',       estado !== 'idle');
  secObservando.classList.toggle('hidden', estado !== 'observando');
  secEjecutando.classList.toggle('hidden', estado !== 'ejecutando');
}

function _habilitarEjecutar(si) {
  btnEjecutar.disabled = !si;
  btnEjecutar.classList.toggle('btn-disabled', !si);
  btnEjecutar.classList.toggle('btn-rojo',     si);
}

// ─────────────────────────────────────────────────────────────────────────────
// OBSERVANDO — campos detectados
// ─────────────────────────────────────────────────────────────────────────────
function resetObservando() {
  camposCount = 0;
  listaCampos.innerHTML = '';
  contadorCampos.textContent = '0';
  barraObs.style.width = '0%';
}

function agregarCampo(nombre, time) {
  camposCount++;
  contadorCampos.textContent = camposCount;
  const div = document.createElement('div');
  div.className = 'campo';
  div.innerHTML =
    '<span class="punto"></span>' +
    '<span class="nombre">' + nombre + '</span>' +
    '<span class="time">' + (time || '') + '</span>';
  listaCampos.appendChild(div);
  barraObs.style.width = Math.min(100, (camposCount / 4) * 100) + '%';
}

// ─────────────────────────────────────────────────────────────────────────────
// EJECUTANDO — pasos dinámicos del workflow aprendido
// ─────────────────────────────────────────────────────────────────────────────
function renderPasos(pasos) {
  listaPasos.innerHTML = '';
  pasos.forEach((texto) => {
    const div = document.createElement('div');
    div.className = 'paso pendiente';
    div.dataset.texto = texto;
    div.innerHTML =
      '<span class="icono">○</span>' +
      '<span class="texto">' + texto + '</span>';
    listaPasos.appendChild(div);
  });
  barraEje.style.width = '0%';
}

function _buscarPaso(texto) {
  return listaPasos.querySelector('.paso[data-texto="' + texto + '"]');
}

function marcarPasoActual(texto) {
  const p = _buscarPaso(texto);
  if (!p) return;
  p.className = 'paso actual';
  p.querySelector('.icono').textContent = '◉';
}

function marcarPasoCompletado(texto) {
  const p = _buscarPaso(texto);
  if (!p) return;
  p.className = 'paso done';
  p.querySelector('.icono').textContent = '✔';
  _actualizarBarra();
}

function _actualizarBarra() {
  const total  = listaPasos.querySelectorAll('.paso').length;
  const hechos = listaPasos.querySelectorAll('.paso.done').length;
  barraEje.style.width = (total ? Math.round((hechos / total) * 100) : 0) + '%';
}

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGING
// ─────────────────────────────────────────────────────────────────────────────
function enviarAContentScript(msg) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, msg);
  });
}

function enviarABackground(msg) {
  chrome.runtime.sendMessage(msg);
}

// ─────────────────────────────────────────────────────────────────────────────
// BUTTON EVENTS
// ─────────────────────────────────────────────────────────────────────────────
btnObservar.addEventListener('click', () => {
  resetObservando();
  mostrarEstado('observando');
  enviarABackground({ tipo: 'iniciar_grabacion' });
});

btnDetener.addEventListener('click', () => {
  enviarABackground({ tipo: 'detener_grabacion' });
  mostrarEstado('idle');
  _habilitarEjecutar(false);
});

btnEjecutar.addEventListener('click', () => {
  if (btnEjecutar.disabled) return;
  chrome.storage.local.get(['mapeo_aprendido'], (data) => {
    const mapeo = data['mapeo_aprendido'];
    const pasos = (mapeo?.pasos_destino || mapeo?.pasos || [])
      .map((p) => p.nombre)
      .filter(Boolean);
    renderPasos(pasos.length ? pasos : ['Iniciando automatización…']);
    mostrarEstado('ejecutando');
    enviarABackground({ tipo: 'iniciar_ejecucion' });
  });
});

btnDashboard.addEventListener('click', () => {
  chrome.tabs.create({ url: DASHBOARD_URL });
});

// ─────────────────────────────────────────────────────────────────────────────
// INCOMING MESSAGES from content_script / background
// ─────────────────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg?.tipo) return;
  switch (msg.tipo) {
    case 'campo_detectado':  agregarCampo(msg.nombre, msg.time); break;
    case 'paso_actual':      marcarPasoActual(msg.paso);         break;
    case 'paso_completado':  marcarPasoCompletado(msg.paso);     break;
    case 'aprendizaje_ok':   _habilitarEjecutar(true);           break;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// INIT — sync state from storage when popup opens
// ─────────────────────────────────────────────────────────────────────────────
chrome.storage.local.get(['estado_agente', 'mapeo_aprendido', 'acciones_grabadas'], (data) => {
  const estado = data['estado_agente'] || 'idle';
  const mapeo  = data['mapeo_aprendido'];
  const acciones = data['acciones_grabadas'] || [];

  if (estado === 'observando') {
    mostrarEstado('observando');
  } else if (estado === 'ejecutando') {
    const pasos = (mapeo?.pasos_destino || mapeo?.pasos || [])
      .map((p) => p.nombre).filter(Boolean);
    renderPasos(pasos.length ? pasos : ['Procesando…']);
    mostrarEstado('ejecutando');
  } else {
    mostrarEstado('idle');
    // Re-enable Execute if a mapping was already learned
    if (mapeo || acciones.length > 0) {
      _habilitarEjecutar(true);
    }
  }
});
