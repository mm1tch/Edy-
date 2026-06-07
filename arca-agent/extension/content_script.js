// content_script.js
// "Ojos y manos" de Edy: graba lo que el usuario hace en la página y
// reproduce las acciones grabadas. NO dibuja nada — controla al widget visual
// (definido en widget_ui.js, expuesto en window.EdyWidget) a través de su API
// pública, sin conocer su marcado ni su CSS internos.
//
// Importante: widget_ui.js debe cargarse ANTES que este archivo
// (ver el orden del array "js" en manifest.json) para que window.EdyWidget
// ya exista cuando este script corre.

(function () {
  if (window.__edyAgenteInyectado) return;
  window.__edyAgenteInyectado = true;

  const widget = window.EdyWidget;
  if (!widget) {
    console.error("Edy: widget_ui.js no se cargó antes que content_script.js");
    return;
  }

  // ---------- Config ----------
  const DASHBOARD_URL = "http://127.0.0.1:5500/arca-agent/dashboard/index.html";
  const PASOS_EJECUCION = [
    "Abrir SAP / módulo VA01",
    "Capturar cliente_id",
    "Capturar 6 SKUs",
    "Validar inventario...",
    "Confirmar pedido",
  ];

  // Cuántos campos se han capturado en la grabación actual (para el resumen).
  let camposCapturados = 0;

  // ---------- Grabación ----------
  function iniciarGrabacion() {
    // TODO: poner listeners globales en la página (click, input/change, submit).
    // Por cada evento, generar un selector único del elemento (id → name → CSS path)
    // y guardar una acción: {accion:'fill', selector, valor, label, t} o {accion:'click', selector, t}.
    // Mientras se graba, avisar al widget en vivo: widget.agregarCampoDetectado(nombre, time).
  }

  function detenerGrabacion() {
    // TODO: quitar los listeners y mandar la lista completa a background:
    // chrome.runtime.sendMessage({ tipo: 'acciones_grabadas', acciones: [...] });
  }

  // ---------- Ejecución ----------
  function iniciarEjecucion() {
    // TODO: al recibir { tipo:'ejecutar_accion', accion } de background,
    // ubicar el elemento por su selector, llenar el valor o hacer click
    // (disparando eventos input/change para que el sitio lo registre),
    // y avisar al widget: widget.marcarPasoActual(paso) / widget.marcarPasoCompletado(paso).
  }

  // ---------- Conectar la UI con la lógica ----------
  widget.onObservar(() => {
    camposCapturados = 0;
    widget.resetObservando();
    widget.mostrarEstado("observando");
    chrome.runtime.sendMessage({ tipo: "iniciar_grabacion" });
    iniciarGrabacion();
  });

  widget.onDetener(() => {
    chrome.runtime.sendMessage({ tipo: "detener_grabacion" });
    detenerGrabacion();
    // Pasa al estado "aprendido": Edy ya sabe el proceso.
    widget.setResumenAprendido(
      camposCapturados + " campos · " + PASOS_EJECUCION.length + " pasos"
    );
    widget.mostrarEstado("aprendido");
    widget.habilitarEjecutar(true);
  });

  widget.onEjecutar(() => {
    widget.renderPasos(PASOS_EJECUCION);
    widget.mostrarEstado("ejecutando");
    chrome.runtime.sendMessage({ tipo: "iniciar_ejecucion" });
    iniciarEjecucion();
  });

  widget.onDashboard(() => {
    if (DASHBOARD_URL) {
      chrome.runtime.sendMessage({ tipo: "abrir_dashboard", url: DASHBOARD_URL });
    }
  });

  widget.onPausar(() => {
    // Detener ejecución → vuelve al estado "aprendido" (Edy sigue sabiendo el proceso).
    chrome.runtime.sendMessage({ tipo: "detener_ejecucion" });
    widget.mostrarEstado("aprendido");
  });

  widget.onNuevo(() => {
    // Nuevo proceso → reinicia todo desde cero.
    chrome.runtime.sendMessage({ tipo: "nuevo_proceso" });
  });

  // ---------- Mensajes entrantes del background ----------
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.tipo) return;
    switch (msg.tipo) {
      case "campo_detectado":
        camposCapturados++;
        widget.agregarCampoDetectado(msg.nombre, msg.time);
        break;
      case "paso_actual":
        widget.marcarPasoActual(msg.paso);
        break;
      case "paso_completado":
        widget.marcarPasoCompletado(msg.paso);
        break;
      case "flujo_completado":
        widget.mostrarEstado("completado");
        break;
    }
  });
})();