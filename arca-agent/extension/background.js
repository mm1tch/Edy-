// background.js
// Cerebro de Edy: coordina la grabacion, aprendizaje via backend y ejecucion.

const ICONOS = {
  idle: "icons/EdyNeutro.png",
  pensando: "icons/EdyPensando.png",
  completado: "icons/EdySonriente.png",
};

const PASOS_EJECUCION = [
  "Abrir SAP / modulo VA01",
  "Capturar cliente_id",
  "Capturar 6 SKUs",
  "Validar inventario...",
  "Confirmar pedido",
];

const DEFAULT_GEMINI_BACKEND_URL = "http://localhost:3000/api/aprender-mapeo";

const STORAGE_KEYS = {
  estado: "estado_agente",
  acciones: "acciones_grabadas",
  mapeo: "mapeo_aprendido",
  geminiBackendUrl: "geminiBackendUrl",
  appsScriptUrl: "appsScriptUrl",
  ultimoPedido: "ultimo_pedido",
  tabGrabandoId: "tab_grabando_id",
};

let estado = "idle";
let tabGrabandoId = null;
let accionesGrabadas = [];

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setIcon({ path: ICONOS.idle });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "complete") return;

  sincronizarTabDespuesDeNavegacion(tabId).catch((error) => {
    console.error("[Edy background] No se pudo sincronizar la pestana", error);
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.tipo) return false;

  manejarMensaje(msg, sender)
    .then((respuesta) => sendResponse(respuesta || { ok: true }))
    .catch((error) => {
      console.error("[Edy background]", error);
      sendResponse({ ok: false, error: error.message });
    });

  return true;
});

async function manejarMensaje(msg, sender) {
  switch (msg.tipo) {
    case "content_script_listo":
      return sincronizarContentScript(sender.tab?.id);

    case "iniciar_grabacion":
      return iniciarGrabacion(sender.tab?.id);

    case "accion_grabada":
      await cargarEstadoPersistido();
      registrarAccion(msg.accion, sender.tab?.id);
      return { ok: true };

    case "acciones_grabadas":
      accionesGrabadas = normalizarAcciones(msg.acciones);
      await guardarLocal({ [STORAGE_KEYS.acciones]: accionesGrabadas });
      await aprenderMapeoConBackend(accionesGrabadas);
      return { ok: true, total: accionesGrabadas.length };

    case "detener_grabacion":
      return detenerGrabacion(sender.tab?.id);

    case "iniciar_ejecucion":
      return iniciarEjecucion(sender.tab?.id);

    case "abrir_dashboard":
      if (msg.url) await chrome.tabs.create({ url: msg.url });
      return { ok: true };

    case "configurar_gemini_backend":
    case "configurar_backend_gemini":
      await guardarLocal({ [STORAGE_KEYS.geminiBackendUrl]: msg.url || "" });
      return { ok: true };

    case "configurar_apps_script":
      await guardarLocal({ [STORAGE_KEYS.appsScriptUrl]: msg.url || "" });
      return { ok: true };

    default:
      return { ok: false, error: "Tipo de mensaje no soportado: " + msg.tipo };
  }
}

async function iniciarGrabacion(tabId) {
  const targetTabId = tabId || (await obtenerTabActiva())?.id;
  if (!targetTabId) throw new Error("No hay una pestana activa para grabar.");

  estado = "observando";
  tabGrabandoId = targetTabId;
  accionesGrabadas = [];

  await chrome.action.setIcon({ path: ICONOS.pensando });
  await guardarLocal({
    [STORAGE_KEYS.estado]: estado,
    [STORAGE_KEYS.acciones]: [],
    [STORAGE_KEYS.mapeo]: null,
    [STORAGE_KEYS.tabGrabandoId]: tabGrabandoId,
  });
  await inyectarGrabador(targetTabId);
  await enviarATodos({ tipo: "estado_agente", estado, totalAcciones: 0 });
  await enviarATodos({ tipo: "grabacion_iniciada" });

  return { ok: true, tabId: targetTabId };
}

async function detenerGrabacion(tabId) {
  await cargarEstadoPersistido();
  const targetTabId = tabGrabandoId || tabId || (await obtenerTabActiva())?.id;

  if (targetTabId) {
    const accionesDePagina = await obtenerAccionesDelGrabador(targetTabId);
    accionesGrabadas = unirAcciones(accionesGrabadas, accionesDePagina);
    await detenerGrabador(targetTabId);
  }

  estado = "idle";
  tabGrabandoId = null;

  await chrome.action.setIcon({ path: ICONOS.idle });
  await guardarLocal({
    [STORAGE_KEYS.estado]: estado,
    [STORAGE_KEYS.tabGrabandoId]: null,
    [STORAGE_KEYS.acciones]: accionesGrabadas,
  });

  let mapeo = null;
  if (accionesGrabadas.length) {
    mapeo = await aprenderMapeoConBackend(accionesGrabadas);
  }

  await enviarATodos({
    tipo: "estado_agente",
    estado,
    totalAcciones: accionesGrabadas.length,
  });
  await enviarATodos({
    tipo: "grabacion_detenida",
    totalAcciones: accionesGrabadas.length,
    mapeo,
  });

  return { ok: true, totalAcciones: accionesGrabadas.length, mapeo };
}

function registrarAccion(accion, tabId) {
  const accionNormalizada = normalizarAccion(accion, tabId);
  if (estado !== "observando") return;

  if (accionesGrabadas.some((item) => firmaAccion(item) === firmaAccion(accionNormalizada))) {
    return;
  }

  accionesGrabadas.push(accionNormalizada);
  guardarLocal({ [STORAGE_KEYS.acciones]: accionesGrabadas });

  if (accionNormalizada.nombreCampo) {
    enviarATodos({
      tipo: "campo_detectado",
      nombre: accionNormalizada.nombreCampo,
      time: formatearHora(accionNormalizada.timestamp),
    });
  }
}

async function aprenderMapeoConBackend(acciones) {
  const { [STORAGE_KEYS.geminiBackendUrl]: storedBackendUrl } = await chrome.storage.local.get(
    STORAGE_KEYS.geminiBackendUrl
  );
  const backendUrl = storedBackendUrl || DEFAULT_GEMINI_BACKEND_URL;

  if (!backendUrl) {
    const mapeoFallback = inferirMapeoLocal(acciones);
    await guardarLocal({ [STORAGE_KEYS.mapeo]: mapeoFallback });
    return mapeoFallback;
  }

  const respuesta = await fetch(backendUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tipo: "aprender_mapeo",
      agente: "edy",
      version: 1,
      acciones,
      formato_esperado: {
        campos: [
          {
            nombre_semantico: "cliente_id",
            selector: "...",
            evidencia: "...",
          },
        ],
        pasos: [
          {
            nombre: "Capturar cliente_id",
            accion: "input",
            selector: "...",
            valor: "...",
          },
        ],
        datos_pedido: {},
      },
    }),
  });

  if (!respuesta.ok) {
    const texto = await respuesta.text();
    throw new Error("Backend Gemini respondio " + respuesta.status + ": " + texto);
  }

  const data = await respuesta.json();
  const mapeo = data.mapeo || data;

  await guardarLocal({ [STORAGE_KEYS.mapeo]: mapeo });
  return mapeo;
}

async function iniciarEjecucion(tabId) {
  await cargarEstadoPersistido();
  const targetTabId = tabId || tabGrabandoId || (await obtenerTabActiva())?.id;
  if (!targetTabId) throw new Error("No hay una pestana activa para ejecutar.");

  const storage = await chrome.storage.local.get([
    STORAGE_KEYS.acciones,
    STORAGE_KEYS.mapeo,
    STORAGE_KEYS.appsScriptUrl,
  ]);

  const acciones = normalizarAcciones(storage[STORAGE_KEYS.acciones] || accionesGrabadas);
  if (!acciones.length) throw new Error("No hay acciones grabadas para ejecutar.");

  estado = "ejecutando";
  await chrome.action.setIcon({ path: ICONOS.pensando });
  await guardarLocal({ [STORAGE_KEYS.estado]: estado, [STORAGE_KEYS.tabGrabandoId]: targetTabId });
  await enviarATodos({ tipo: "estado_agente", estado, totalAcciones: acciones.length });

  const plan = construirPlanEjecucion(acciones, storage[STORAGE_KEYS.mapeo]);

  for (let i = 0; i < plan.length; i += 1) {
    const paso = plan[i];
    await enviarATodos({ tipo: "paso_actual", paso: paso.nombre });
    await ejecutarAccionEnTab(targetTabId, paso.accion);
    await esperar(350);
    await enviarATodos({ tipo: "paso_completado", paso: paso.nombre });
  }

  const payload = {
    fecha: new Date().toISOString(),
    total_acciones: acciones.length,
    mapeo: storage[STORAGE_KEYS.mapeo] || null,
    acciones,
  };

  await guardarLocal({ [STORAGE_KEYS.ultimoPedido]: payload });
  await enviarAAppsScript(payload, storage[STORAGE_KEYS.appsScriptUrl]);

  estado = "idle";
  tabGrabandoId = null;
  await guardarLocal({ [STORAGE_KEYS.estado]: estado, [STORAGE_KEYS.tabGrabandoId]: null });
  await chrome.action.setIcon({ path: ICONOS.completado });
  await enviarATodos({ tipo: "estado_agente", estado, totalAcciones: acciones.length });
  setTimeout(() => chrome.action.setIcon({ path: ICONOS.idle }), 1500);

  return { ok: true, totalPasos: plan.length };
}

function construirPlanEjecucion(acciones, mapeo) {
  if (mapeo?.pasos?.length) {
    return mapeo.pasos
      .map((paso, index) => ({
        nombre: paso.nombre || PASOS_EJECUCION[index] || "Paso " + (index + 1),
        accion: {
          ...(acciones[index] || {}),
          tipo: paso.accion || paso.tipo || acciones[index]?.tipo || "input",
          selector: paso.selector || acciones[index]?.selector || "",
          valor: paso.valor ?? acciones[index]?.valor ?? "",
        },
      }))
      .filter((paso) => paso.accion.selector);
  }

  return acciones.map((accion, index) => ({
    nombre: PASOS_EJECUCION[index] || nombrePasoDesdeAccion(accion, index),
    accion,
  }));
}

async function enviarAAppsScript(payload, appsScriptUrl) {
  if (!appsScriptUrl) return null;

  const respuesta = await fetch(appsScriptUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!respuesta.ok) {
    throw new Error("Apps Script respondio " + respuesta.status);
  }

  return respuesta.text();
}

async function inyectarGrabador(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      if (window.__edyRecorderActivo) return;

      window.__edyRecorderActivo = true;
      window.__edyRecorderAcciones = [];

      const selectorPara = (el) => {
        if (!el || el === document || el === window) return "";
        if (el.id) return "#" + CSS.escape(el.id);
        const name = el.getAttribute("name");
        if (name) return el.tagName.toLowerCase() + '[name="' + CSS.escape(name) + '"]';
        const aria = el.getAttribute("aria-label");
        if (aria) return el.tagName.toLowerCase() + '[aria-label="' + CSS.escape(aria) + '"]';

        const partes = [];
        let actual = el;
        while (actual && actual.nodeType === Node.ELEMENT_NODE && partes.length < 4) {
          let parte = actual.tagName.toLowerCase();
          const parent = actual.parentElement;
          if (parent) {
            const iguales = Array.from(parent.children).filter((hijo) => hijo.tagName === actual.tagName);
            if (iguales.length > 1) parte += ":nth-of-type(" + (iguales.indexOf(actual) + 1) + ")";
          }
          partes.unshift(parte);
          actual = parent;
        }
        return partes.join(" > ");
      };

      const etiquetaPara = (el) => {
        const id = el.id;
        const label =
          (id && document.querySelector('label[for="' + CSS.escape(id) + '"]')?.innerText) ||
          el.closest("label")?.innerText ||
          el.getAttribute("aria-label") ||
          el.getAttribute("placeholder") ||
          el.getAttribute("name") ||
          el.id ||
          el.textContent;

        return String(label || "").trim().replace(/\s+/g, " ").slice(0, 80);
      };

      const guardar = (tipo, el) => {
        if (el.closest?.("#edy-agent-host")) return;

        const accion = {
          id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + "-" + Math.random(),
          tipo,
          selector: selectorPara(el),
          valor: "value" in el ? el.value : "",
          texto: el.innerText || el.textContent || "",
          tag: el.tagName?.toLowerCase(),
          nombreCampo: etiquetaPara(el),
          timestamp: Date.now(),
          url: location.href,
        };

        window.__edyRecorderAcciones.push(accion);
        chrome.runtime.sendMessage({ tipo: "accion_grabada", accion });
      };

      const onClick = (event) => guardar("click", event.target);
      const onInput = (event) => guardar("input", event.target);
      const onChange = (event) => guardar("change", event.target);
      const onSubmit = (event) => guardar("submit", event.target);

      window.__edyRecorderHandlers = { onClick, onInput, onChange, onSubmit };
      document.addEventListener("click", onClick, true);
      document.addEventListener("input", onInput, true);
      document.addEventListener("change", onChange, true);
      document.addEventListener("submit", onSubmit, true);
    },
  });
}

async function obtenerAccionesDelGrabador(tabId) {
  const resultados = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => window.__edyRecorderAcciones || [],
  });

  return normalizarAcciones(resultados?.[0]?.result || []);
}

async function detenerGrabador(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const handlers = window.__edyRecorderHandlers;
      if (handlers) {
        document.removeEventListener("click", handlers.onClick, true);
        document.removeEventListener("input", handlers.onInput, true);
        document.removeEventListener("change", handlers.onChange, true);
        document.removeEventListener("submit", handlers.onSubmit, true);
      }
      window.__edyRecorderActivo = false;
    },
  });
}

async function ejecutarAccionEnTab(tabId, accion) {
  await chrome.scripting.executeScript({
    target: { tabId },
    args: [accion],
    func: (accionAEjecutar) => {
      const el = document.querySelector(accionAEjecutar.selector);
      if (!el) throw new Error("No se encontro selector: " + accionAEjecutar.selector);

      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.focus?.();

      if (accionAEjecutar.tipo === "input" || accionAEjecutar.tipo === "change") {
        el.value = accionAEjecutar.valor || "";
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return;
      }

      if (accionAEjecutar.tipo === "submit") {
        el.closest("form")?.requestSubmit?.();
        return;
      }

      el.click();
    },
  });
}

function inferirMapeoLocal(acciones) {
  const campos = [];
  const vistos = new Set();

  for (const accion of acciones) {
    if (!accion.selector || vistos.has(accion.selector)) continue;
    vistos.add(accion.selector);

    campos.push({
      nombre_semantico: normalizarNombreSemantico(accion.nombreCampo || accion.selector),
      selector: accion.selector,
      evidencia: accion.nombreCampo || accion.texto || accion.tag || "",
    });
  }

  return {
    origen: "fallback_local_sin_backend_gemini",
    campos,
    pasos: acciones.map((accion, index) => ({
      nombre: PASOS_EJECUCION[index] || nombrePasoDesdeAccion(accion, index),
      accion: accion.tipo,
      selector: accion.selector,
      valor: accion.valor,
    })),
    datos_pedido: {},
  };
}

function normalizarNombreSemantico(nombre) {
  const limpio = String(nombre || "campo")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (limpio.includes("cliente")) return "cliente_id";
  if (limpio.includes("sku") || limpio.includes("producto")) return "sku";
  if (limpio.includes("cantidad") || limpio.includes("qty")) return "cantidad";
  if (limpio.includes("fecha")) return "fecha_entrega";
  return limpio || "campo";
}

function normalizarAcciones(acciones) {
  return Array.isArray(acciones) ? acciones.map((accion) => normalizarAccion(accion)) : [];
}

function normalizarAccion(accion, tabId) {
  return {
    id: accion?.id || "",
    tipo: accion?.tipo || "click",
    selector: accion?.selector || "",
    valor: accion?.valor || "",
    texto: String(accion?.texto || "").slice(0, 120),
    tag: accion?.tag || "",
    nombreCampo: accion?.nombreCampo || accion?.campo || "",
    timestamp: accion?.timestamp || Date.now(),
    url: accion?.url || "",
    tabId: accion?.tabId || tabId || null,
  };
}

function unirAcciones(base, nuevas) {
  const resultado = normalizarAcciones(base);
  const firmas = new Set(resultado.map(firmaAccion));

  for (const accion of normalizarAcciones(nuevas)) {
    const firma = firmaAccion(accion);
    if (firmas.has(firma)) continue;
    firmas.add(firma);
    resultado.push(accion);
  }

  return resultado;
}

function firmaAccion(accion) {
  if (accion.id) return accion.id;
  return [
    accion.tipo,
    accion.selector,
    accion.valor,
    accion.timestamp,
    accion.url,
  ].join("|");
}

function nombrePasoDesdeAccion(accion, index) {
  const campo = accion.nombreCampo || accion.selector || "accion";
  if (accion.tipo === "input" || accion.tipo === "change") return "Capturar " + campo;
  if (accion.tipo === "click") return "Click en " + campo;
  return "Paso " + (index + 1);
}

async function obtenerTabActiva() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

async function cargarEstadoPersistido() {
  const storage = await chrome.storage.local.get([
    STORAGE_KEYS.estado,
    STORAGE_KEYS.tabGrabandoId,
    STORAGE_KEYS.acciones,
  ]);

  estado = storage[STORAGE_KEYS.estado] || estado || "idle";
  tabGrabandoId = storage[STORAGE_KEYS.tabGrabandoId] || tabGrabandoId || null;
  accionesGrabadas = normalizarAcciones(storage[STORAGE_KEYS.acciones] || accionesGrabadas);

  return { estado, tabGrabandoId, accionesGrabadas };
}

async function sincronizarTabDespuesDeNavegacion(tabId) {
  await cargarEstadoPersistido();
  if (estado === "idle" || tabId !== tabGrabandoId) return;

  if (estado === "observando") {
    await inyectarGrabador(tabId);
  }

  await chrome.tabs.sendMessage(tabId, {
    tipo: "estado_agente",
    estado,
    totalAcciones: accionesGrabadas.length,
  }).catch(() => {});
}

async function sincronizarContentScript(tabId) {
  await cargarEstadoPersistido();

  const tabEsDelAgente = !tabGrabandoId || tabId === tabGrabandoId;
  if (estado === "observando" && tabEsDelAgente && tabId) {
    await inyectarGrabador(tabId);
  }

  return {
    ok: true,
    estado: tabEsDelAgente ? estado : "idle",
    totalAcciones: accionesGrabadas.length,
  };
}

async function enviarATodos(mensaje) {
  await chrome.runtime.sendMessage(mensaje).catch(() => {});

  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs.map((tab) => {
      if (!tab.id) return Promise.resolve();
      return chrome.tabs.sendMessage(tab.id, mensaje).catch(() => {});
    })
  );
}

function guardarLocal(datos) {
  return chrome.storage.local.set(datos);
}

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatearHora(timestamp) {
  return new Date(timestamp).toLocaleTimeString("es-MX", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
