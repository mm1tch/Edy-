// background.js — Edy v3
// Flow: observe user placing an order on any supplier portal (System A)
//       → Gemini learns the navigation playbook
//       → Edy replicates the full order autonomously
//       → Order data is posted to Google Sheets (System B) → dashboard

const ICONOS = {
  idle:      "icons/EdyNeutro.png",
  pensando:  "icons/EdyPensando.png",
  completado:"icons/EdySonriente.png",
};

const DEFAULT_BACKEND_URL = "http://localhost:3000/api/aprender-mapeo";

const STORAGE_KEYS = {
  estado:       "estado_agente",
  acciones:     "acciones_grabadas",
  mapeo:        "mapeo_aprendido",
  backendUrl:   "geminiBackendUrl",
  appsScriptUrl:"appsScriptUrl",
  ultimoPedido: "ultimo_pedido",
  ultimoEnvioSheets: "ultimo_envio_sheets",
  originTabId:  "origin_tab_id",
  originUrl:    "origin_url",
  originSnapshot:"origin_snapshot",
};

let estado          = "idle";
let originTabId     = null;
let originUrl       = null;
let accionesGrabadas = [];
let originSnapshot  = [];

// ─── Lifecycle ────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setIcon({ path: ICONOS.idle });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "complete") return;
  sincronizarTabDespuesDeNavegacion(tabId).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg?.tipo) return false;
  manejarMensaje(msg, sender)
    .then((resp) => sendResponse(resp || { ok: true }))
    .catch((err) => {
      console.error("[Edy]", err);
      sendResponse({ ok: false, error: err.message });
    });
  return true;
});

// ─── Message router ───────────────────────────────────────────────────────────

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
    case "detener_grabacion":
      return detenerGrabacion(sender.tab?.id);
    case "iniciar_ejecucion":
      return iniciarEjecucion(sender.tab?.id);
    case "volver_a_ejecutar":
      return iniciarEjecucion(sender.tab?.id);
    case "abrir_dashboard":
      if (msg.url) await chrome.tabs.create({ url: msg.url });
      return { ok: true };
    case "configurar_gemini_backend":
    case "configurar_backend_gemini":
      await guardarLocal({ [STORAGE_KEYS.backendUrl]: msg.url || "" });
      return { ok: true };
    case "configurar_apps_script":
      await guardarLocal({ [STORAGE_KEYS.appsScriptUrl]: msg.url || "" });
      return { ok: true };
    default:
      return { ok: false, error: "Tipo desconocido: " + msg.tipo };
  }
}

// ─── Recording ────────────────────────────────────────────────────────────────

async function iniciarGrabacion(tabId) {
  const targetTabId = tabId || (await obtenerTabActiva())?.id;
  if (!targetTabId) throw new Error("No hay pestaña activa.");

  estado           = "observando";
  originTabId      = targetTabId;
  accionesGrabadas = [];
  originSnapshot   = [];

  const tab = await chrome.tabs.get(targetTabId).catch(() => null);
  originUrl = tab?.url || null;

  await chrome.action.setIcon({ path: ICONOS.pensando });
  await guardarLocal({
    [STORAGE_KEYS.estado]:         estado,
    [STORAGE_KEYS.acciones]:       [],
    [STORAGE_KEYS.mapeo]:          null,
    [STORAGE_KEYS.originTabId]:    originTabId,
    [STORAGE_KEYS.originUrl]:      originUrl,
    [STORAGE_KEYS.originSnapshot]: [],
  });

  // Tell the content script on that tab to start recording.
  // content_script.js owns the event listeners — no executeScript injection needed.
  await chrome.tabs.sendMessage(targetTabId, { tipo: "iniciar_grabacion_tab" }).catch(() => {});

  originSnapshot = await capturarSnapshotPagina(targetTabId).catch(() => []);
  await guardarLocal({ [STORAGE_KEYS.originSnapshot]: originSnapshot });

  await enviarATodos({ tipo: "estado_agente", estado, totalAcciones: 0 });
  await enviarATodos({ tipo: "grabacion_iniciada" });

  return { ok: true, tabId: targetTabId };
}

async function detenerGrabacion(tabId) {
  await cargarEstadoPersistido();

  const targetTabId = originTabId || tabId || (await obtenerTabActiva())?.id;
  if (targetTabId) {
    // Ask content script for any locally-buffered actions (catches edge cases)
    const resp = await chrome.tabs.sendMessage(targetTabId, { tipo: "detener_grabacion_tab" }).catch(() => null);
    if (resp?.acciones?.length) {
      accionesGrabadas = unirAcciones(accionesGrabadas, resp.acciones);
    }
  }

  estado = "idle";
  await chrome.action.setIcon({ path: ICONOS.idle });
  await guardarLocal({
    [STORAGE_KEYS.estado]:   estado,
    [STORAGE_KEYS.acciones]: accionesGrabadas,
  });

  let mapeo = null;
  if (accionesGrabadas.length) {
    mapeo = await aprenderMapeoConBackend(accionesGrabadas).catch((err) => {
      console.warn("[Edy] Backend falló, usando inferencia local:", err.message);
      return inferirMapeoLocal(accionesGrabadas);
    });
  }

  await enviarATodos({ tipo: "estado_agente", estado, totalAcciones: accionesGrabadas.length });
  await enviarATodos({ tipo: "grabacion_detenida", totalAcciones: accionesGrabadas.length, mapeo });

  return { ok: true, totalAcciones: accionesGrabadas.length, mapeo };
}

function registrarAccion(accion, tabId) {
  if (estado !== "observando") return;

  const normalizada = normalizarAccion(accion, tabId);
  const indexExistente = accionesGrabadas.findIndex((a) => accionesSonMismoCampoEditable(a, normalizada));

  if (indexExistente !== -1) {
    accionesGrabadas[indexExistente] = {
      ...accionesGrabadas[indexExistente],
      ...normalizada,
      id: accionesGrabadas[indexExistente].id || normalizada.id,
    };
    guardarLocal({ [STORAGE_KEYS.acciones]: accionesGrabadas });
    return;
  }

  if (accionesGrabadas.some((a) => firmaAccion(a) === firmaAccion(normalizada))) return;

  accionesGrabadas.push(normalizada);
  guardarLocal({ [STORAGE_KEYS.acciones]: accionesGrabadas });

  if (normalizada.nombreCampo) {
    enviarATodos({
      tipo: "campo_detectado",
      nombre: normalizada.nombreCampo,
      time: formatearHora(normalizada.timestamp),
    });
  }
}

// ─── AI learning ──────────────────────────────────────────────────────────────

async function aprenderMapeoConBackend(acciones) {
  const storage = await chrome.storage.local.get([
    STORAGE_KEYS.backendUrl,
    STORAGE_KEYS.originUrl,
    STORAGE_KEYS.originSnapshot,
  ]);

  const backendUrl = storage[STORAGE_KEYS.backendUrl] || DEFAULT_BACKEND_URL;

  const payload = {
    tipo:            "aprender_mapeo",
    agente:          "edy",
    version:         3,
    url_origen:      storage[STORAGE_KEYS.originUrl] || originUrl || "",
    snapshot_origen: storage[STORAGE_KEYS.originSnapshot] || originSnapshot || [],
    acciones,
  };

  const resp = await fetch(backendUrl, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(payload),
  });

  if (!resp.ok) throw new Error("Backend respondió " + resp.status + ": " + await resp.text());

  const data  = await resp.json();
  const mapeo = data.mapeo || data;

  await guardarLocal({ [STORAGE_KEYS.mapeo]: mapeo });
  return mapeo;
}

// ─── Execution ────────────────────────────────────────────────────────────────

async function iniciarEjecucion(callerTabId) {
  await cargarEstadoPersistido();

  const storage = await chrome.storage.local.get([
    STORAGE_KEYS.acciones,
    STORAGE_KEYS.mapeo,
    STORAGE_KEYS.appsScriptUrl,
    STORAGE_KEYS.originUrl,
  ]);

  const mapeo   = storage[STORAGE_KEYS.mapeo];
  const acciones = normalizarAcciones(storage[STORAGE_KEYS.acciones] || accionesGrabadas);

  if (!mapeo && !acciones.length) {
    throw new Error("Sin mapeo ni acciones. Observa el proceso primero.");
  }

  estado = "ejecutando";
  await chrome.action.setIcon({ path: ICONOS.pensando });
  await guardarLocal({ [STORAGE_KEYS.estado]: estado });

  const plan = construirPlanEjecucion(mapeo, acciones);
  if (!plan.length) {
    throw new Error("No hay pasos ejecutables. Graba el flujo otra vez desde el inicio.");
  }
  await enviarATodos({ tipo: "estado_agente", estado, totalAcciones: plan.length });

  // Navigate to the supplier portal and start fresh
  const portalUrl = mapeo?.portal_url || storage[STORAGE_KEYS.originUrl];
  let tabId;

  if (portalUrl) {
    tabId = await encontrarOAbrirTab(portalUrl);
    await esperar(1000);
  } else {
    tabId = callerTabId || (await obtenerTabActiva())?.id;
  }

  if (!tabId) throw new Error("No se encontró el portal proveedor.");

  // Execute each step, accumulating order data along the way
  let datosRecopilados = {};
  const camposConfirmacion = mapeo?.campos_confirmacion || [];

  for (const paso of plan) {
    await enviarATodos({ tipo: "paso_actual", paso: paso.nombre });

    await ejecutarPasoConNavegacion(tabId, paso.acciones);

    // Scrape after each step — captures data wherever it appears
    if (camposConfirmacion.length) {
      const datosPaso = await scrapeConfirmacion(tabId, camposConfirmacion);
      for (const [key, val] of Object.entries(datosPaso)) {
        if (val && !datosRecopilados[key]) datosRecopilados[key] = val;
      }
    }

    await enviarATodos({ tipo: "paso_completado", paso: paso.nombre });
    await esperar(200);
  }

  // Build and send order record to Google Sheets
  const portalHostname = portalUrl ? new URL(portalUrl).hostname : "desconocido";
  const payload = {
    timestamp:          new Date().toISOString(),
    portal:             portalHostname,
    ejecutado_por:      "Edy",
    orden:              datosRecopilados.orden_id || "EDY-" + Date.now().toString().slice(-6),
    cliente:            datosRecopilados.cliente  || portalHostname,
    skus:               datosRecopilados.productos_ordenados || datosRecopilados.productos || "—",
    importe:            datosRecopilados.total    || datosRecopilados.subtotal || "—",
    estado:             "Completada",
    tiempo_ahorrado:    3.5,
    datos_completos:    JSON.stringify(datosRecopilados),
  };

  await guardarLocal({ [STORAGE_KEYS.ultimoPedido]: payload });
  await enviarAAppsScript(payload, storage[STORAGE_KEYS.appsScriptUrl]).catch(async (err) => {
    console.warn("[Edy] Apps Script:", err.message);
    await guardarLocal({
      [STORAGE_KEYS.ultimoEnvioSheets]: {
        ok: false,
        error: err.message,
        fecha: new Date().toISOString(),
      },
    });
  });

  estado = "idle";
  await guardarLocal({ [STORAGE_KEYS.estado]: estado });
  await chrome.action.setIcon({ path: ICONOS.completado });
  await enviarATodos({ tipo: "estado_agente", estado, totalAcciones: plan.length });
  await enviarATodos({ tipo: "ejecucion_completada", totalPasos: plan.length });
  setTimeout(() => chrome.action.setIcon({ path: ICONOS.idle }), 1500);

  return { ok: true, totalPasos: plan.length };
}

// Execute one step's actions, waiting for page navigation between clicks
async function ejecutarPasoConNavegacion(tabId, acciones) {
  for (const accion of acciones) {
    await ejecutarAccionEnTab(tabId, accion);

    if (accion.tipo === "click" || accion.tipo === "submit") {
      await esperar(400);
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (tab?.status === "loading") {
        await esperarTabCargada(tabId);
        await esperar(500); // settle after page load
      }
    } else {
      await esperar(200);
    }
  }
}

// Scrape order data from whatever page is currently visible
async function scrapeConfirmacion(tabId, campos) {
  if (!campos?.length) return {};
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    args:   [campos],
    func:   (campos) => {
      const datos = {};
      for (const campo of campos) {
        try {
          if (campo.multiple) {
            const els = document.querySelectorAll(campo.selector);
            const textos = Array.from(els).map((el) => el.innerText?.trim()).filter(Boolean);
            if (textos.length) datos[campo.nombre] = textos.join(", ");
          } else {
            const el = document.querySelector(campo.selector);
            if (el) {
              const val = el.innerText?.trim() || el.value || "";
              if (val) datos[campo.nombre] = val;
            }
          }
        } catch (_) {}
      }
      return datos;
    },
  });
  return result?.[0]?.result || {};
}

// Build execution plan — handles both new (nested acciones) and legacy (flat) formats
function construirPlanEjecucion(mapeo, acciones) {
  const accionesGrabadas = normalizarAcciones(acciones).filter(accionGrabadaEsEjecutableSegura);

  // New format: pasos[].acciones[] (nested)
  if (mapeo?.pasos?.length && Array.isArray(mapeo.pasos[0]?.acciones)) {
    return mapeo.pasos
      .filter((paso) => paso.acciones?.length)
      .map((paso) => ({
        nombre:  paso.nombre || "Paso",
        acciones: paso.acciones
          .map((accionMapeada) => obtenerAccionGrabadaCorrespondiente(accionMapeada, accionesGrabadas))
          .filter(Boolean),
      }))
      .filter((paso) => paso.acciones.length > 0);
  }

  // Legacy flat format: pasos[].selector
  if (mapeo?.pasos?.length && mapeo.pasos[0]?.selector) {
    return mapeo.pasos
      .filter((paso) => paso.selector)
      .map((paso) => ({
        paso,
        accionGrabada: obtenerAccionGrabadaCorrespondiente(paso, accionesGrabadas),
      }))
      .filter(({ accionGrabada }) => accionGrabada)
      .map((paso, i) => ({
        nombre:  paso.paso.nombre || `Paso ${i + 1}`,
        acciones: [paso.accionGrabada],
      }));
  }

  // Fallback: replay raw recorded actions grouped by URL (each URL = one step)
  const grupos = [];
  let grupoActual = null;

  for (const accion of accionesGrabadas) {
    if (!grupoActual || grupoActual.url !== accion.url) {
      grupoActual = { url: accion.url, nombre: "Página " + (grupos.length + 1), acciones: [] };
      grupos.push(grupoActual);
    }
    grupoActual.acciones.push(accion);
  }

  return grupos.map((g) => ({ nombre: g.nombre, acciones: g.acciones }));
}

function filtrarAccionesNoGrabadas(accionesMapeadas, accionesGrabadas) {
  if (!Array.isArray(accionesMapeadas)) return [];
  if (!Array.isArray(accionesGrabadas) || accionesGrabadas.length === 0) return accionesMapeadas;
  return accionesMapeadas.filter((accion) => accionMapeadaFueGrabada(accion, accionesGrabadas));
}

function accionMapeadaFueGrabada(accionMapeada, accionesGrabadas) {
  return Boolean(obtenerAccionGrabadaCorrespondiente(accionMapeada, accionesGrabadas));
}

function obtenerAccionGrabadaCorrespondiente(accionMapeada, accionesGrabadas) {
  if (!accionMapeada?.selector) return false;
  const tipoMapeado = normalizarTipoAccion(accionMapeada.accion || accionMapeada.tipo || "click");
  const selectorMapeado = normalizarTextoComparacion(accionMapeada.selector);

  return normalizarAcciones(accionesGrabadas).find((accionGrabada) => {
    if (!accionGrabadaEsEjecutableSegura(accionGrabada)) return false;
    const mismoSelector = normalizarTextoComparacion(accionGrabada.selector) === selectorMapeado;
    if (!mismoSelector) return false;

    const tipoGrabado = normalizarTipoAccion(accionGrabada.tipo);
    return tiposCompatibles(tipoMapeado, tipoGrabado);
  }) || null;
}

function normalizarTipoAccion(tipo) {
  const t = String(tipo || "click").toLowerCase();
  if (t === "fill") return "input";
  return t;
}

function tiposCompatibles(tipoMapeado, tipoGrabado) {
  if (tipoMapeado === tipoGrabado) return true;
  if (tipoMapeado === "click" && tipoGrabado === "submit") return true;
  if (tipoMapeado === "submit" && tipoGrabado === "click") return true;
  return false;
}

function normalizarTextoComparacion(valor) {
  return String(valor || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function accionGrabadaEsEjecutableSegura(accion) {
  if (!accion?.selector) return false;
  const tipo = normalizarTipoAccion(accion.tipo);
  if (tipo !== "click" && tipo !== "submit" && tipo !== "input" && tipo !== "change") return false;

  if (tipo === "click" || tipo === "submit") {
    const texto = normalizarTextoComparacion([
      accion.texto,
      accion.nombreCampo,
      accion.contexto,
    ].filter(Boolean).join(" "));

    if (textoContieneComandosContradictorios(texto)) {
      console.warn("[Edy] Accion ambigua descartada:", texto);
      return false;
    }
  }

  return true;
}

function textoContieneComandosContradictorios(texto) {
  if (!texto) return false;
  const positivos = [
    "continuar", "continue", "siguiente", "next", "guardar", "save",
    "confirmar", "confirm", "submit", "checkout", "place order",
  ];
  const negativos = [
    "cancelar", "cancel", "regresar", "back", "eliminar", "delete", "remove",
  ];

  return positivos.some((palabra) => texto.includes(palabra)) &&
    negativos.some((palabra) => texto.includes(palabra));
}

// ─── DOM helpers ──────────────────────────────────────────────────────────────

async function capturarSnapshotPagina(tabId) {
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const items = [];
      document.querySelectorAll(
        "h1,h2,h3,p,span,label,td,[class*='price'],[class*='name'],[class*='title'],[class*='product'],[data-testid]"
      ).forEach((el) => {
        const text = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
        if (!text || text.length > 200 || text.length < 2) return;
        if (el.closest("#edy-agent-host")) return;
        let selector = el.id ? "#" + CSS.escape(el.id) : el.tagName.toLowerCase();
        items.push({ selector, text, tag: el.tagName.toLowerCase() });
      });
      return items.slice(0, 60);
    },
  });
  return result?.[0]?.result || [];
}

async function encontrarOAbrirTab(url) {
  let urlObj;
  try { urlObj = new URL(url); } catch { throw new Error("URL inválida: " + url); }

  const tabs = await chrome.tabs.query({});
  const sameUrl = tabs.find((t) => {
    try { return urlsEquivalentes(t.url, url); } catch { return false; }
  });

  if (sameUrl) {
    await chrome.tabs.update(sameUrl.id, { active: true });
    await esperarTabLista(sameUrl.id);
    return sameUrl.id;
  }

  const existing = tabs.find((t) => {
    try { return new URL(t.url).origin === urlObj.origin; } catch { return false; }
  });

  if (existing) {
    await chrome.tabs.update(existing.id, { active: true, url });
    await esperarTabLista(existing.id);
    return existing.id;
  }

  const newTab = await chrome.tabs.create({ url });
  await esperarTabLista(newTab.id);
  return newTab.id;
}

function urlsEquivalentes(actual, esperado) {
  const a = new URL(actual);
  const b = new URL(esperado);
  a.hash = "";
  b.hash = "";
  return a.href === b.href;
}

async function esperarTabLista(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab?.status === "loading") {
    await esperarTabCargada(tabId);
  } else {
    await esperar(300);
  }
}

function esperarTabCargada(tabId, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timeout cargando pestaña")), timeout);
    const listener = (id, changeInfo) => {
      if (id !== tabId || changeInfo.status !== "complete") return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      setTimeout(resolve, 400);
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// ─── Recorder injection / retrieval ──────────────────────────────────────────
async function enviarAAppsScript(payload, appsScriptUrl) {
  const urls = [
    await obtenerPedidosBackendUrl(),
    appsScriptUrl,
  ].filter(Boolean);

  if (!urls.length) return null;

  const errores = [];

  for (const url of urls) {
    try {
      const respuesta = await enviarPedidoAUrl(payload, url);

      await guardarLocal({
        [STORAGE_KEYS.ultimoEnvioSheets]: {
          ok: true,
          url,
          respuesta,
          fecha: new Date().toISOString(),
        },
      });

      return respuesta;
    } catch (error) {
      errores.push({ url, error: error.message });
      console.warn("[Edy] Fallo enviando pedido:", url, error.message);
    }
  }

  throw new Error("No se pudo guardar el pedido: " + errores.map((e) => e.error).join(" | "));
}

async function enviarPedidoAUrl(payload, url) {
  const respuesta = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!respuesta.ok) {
    throw new Error("Apps Script respondio " + respuesta.status);
  }

  const texto = await respuesta.text();
  let json = null;

  try {
    json = JSON.parse(texto);
  } catch {
    json = { ok: true, raw: texto };
  }

  if (json && json.ok === false) {
    throw new Error(json.error || "Apps Script respondio ok=false.");
  }

  return json;
}

async function obtenerPedidosBackendUrl() {
  const { [STORAGE_KEYS.backendUrl]: storedBackendUrl } = await chrome.storage.local.get(
    STORAGE_KEYS.backendUrl
  );
  const backendUrl = storedBackendUrl || DEFAULT_BACKEND_URL;

  try {
    return new URL("/api/pedidos", backendUrl).toString();
  } catch {
    return "";
  }
}

async function inyectarGrabador(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      if (window.__edyRecorderActivo) return;
      window.__edyRecorderActivo  = true;
      window.__edyRecorderAcciones = [];

      const selectorPara = (el) => {
        if (!el || el === document || el === window) return "";
        if (el.id) return "#" + CSS.escape(el.id);
        const name = el.getAttribute("name");
        if (name) return el.tagName.toLowerCase() + '[name="' + CSS.escape(name) + '"]';
        const aria = el.getAttribute("aria-label");
        if (aria) return el.tagName.toLowerCase() + '[aria-label="' + CSS.escape(aria) + '"]';
        const testId = el.getAttribute("data-test") || el.getAttribute("data-testid");
        if (testId) return '[data-test="' + testId + '"]';
        const partes = [];
        let actual = el;
        while (actual && actual.nodeType === Node.ELEMENT_NODE && partes.length < 4) {
          let parte = actual.tagName.toLowerCase();
          const parent = actual.parentElement;
          if (parent) {
            const iguales = Array.from(parent.children).filter((h) => h.tagName === actual.tagName);
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
          el.getAttribute("data-test") ||
          el.getAttribute("name") ||
          el.id ||
          el.textContent;
        return String(label || "").trim().replace(/\s+/g, " ").slice(0, 80);
      };

      const guardar = (tipo, el) => {
        if (!el || el.closest?.("#edy-agent-host")) return;
        const sel = selectorPara(el);
        if (!sel) return; // skip unidentifiable elements
        const accion = {
          id:          crypto.randomUUID?.() || String(Date.now()) + "-" + Math.random(),
          tipo,
          selector:    sel,
          valor:       "value" in el ? el.value : "",
          texto:       (el.innerText || el.textContent || "").trim().slice(0, 100),
          tag:         el.tagName?.toLowerCase(),
          nombreCampo: etiquetaPara(el),
          timestamp:   Date.now(),
          url:         location.href,
        };
        window.__edyRecorderAcciones.push(accion);
        chrome.runtime.sendMessage({ tipo: "accion_grabada", accion });
      };

      // Bubble up to the real interactive element so we don't record inner <span> children.
      // Also skip clicks on text inputs — those are handled by the input/change listeners.
      const INTERACTIVE = 'button, a[href], [role="button"], [role="link"], [role="menuitem"], ' +
        '[role="option"], [role="tab"], input[type="submit"], input[type="button"], ' +
        'input[type="checkbox"], input[type="radio"], select, label, ' +
        '[data-test], [data-testid], [data-cy]';

      const TEXT_INPUT_TYPES = new Set(['text','password','email','number','search','tel','url','date','time','']);

      let lastClickRecordedAt = 0;

      const onClick = (e) => {
        const tag  = e.target.tagName?.toLowerCase();
        const type = (e.target.type || "").toLowerCase();
        // Skip clicks on text inputs — input events cover those
        if ((tag === 'input' && TEXT_INPUT_TYPES.has(type)) || tag === 'textarea') return;
        // Bubble up to nearest real interactive ancestor
        const el = e.target.closest(INTERACTIVE);
        if (!el) return;
        lastClickRecordedAt = Date.now();
        guardar("click", el);
      };

      const onInput  = (e) => guardar("input",  e.target);
      const onChange = (e) => {
        // Capture selects and checkboxes via change
        const tag = e.target.tagName?.toLowerCase();
        const type = (e.target.type || "").toLowerCase();
        if (tag === 'select' || type === 'checkbox' || type === 'radio') {
          guardar("change", e.target);
        }
      };
      const onSubmit = (e) => {
        if (Date.now() - lastClickRecordedAt < 800) return;
        guardar("submit", e.target);
      };

      window.__edyRecorderHandlers = { onClick, onInput, onChange, onSubmit };
      document.addEventListener("click",  onClick,  true);
      document.addEventListener("input",  onInput,  true);
      document.addEventListener("change", onChange, true);
      document.addEventListener("submit", onSubmit, true);
    },
  });
}

async function obtenerAccionesDelGrabador(tabId) {
  const res = await chrome.scripting.executeScript({
    target: { tabId },
    func:   () => window.__edyRecorderAcciones || [],
  });
  return normalizarAcciones(res?.[0]?.result || []);
}

async function detenerGrabador(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const h = window.__edyRecorderHandlers;
      if (h) {
        document.removeEventListener("click",  h.onClick,  true);
        document.removeEventListener("input",  h.onInput,  true);
        document.removeEventListener("change", h.onChange, true);
        document.removeEventListener("submit", h.onSubmit, true);
      }
      window.__edyRecorderActivo = false;
    },
  });
}

async function ejecutarAccionEnTab(tabId, accion) {
  // Delegate to content_script.js's edyEjecutarAccion which has full semantic fallback
  // including contexto (product name) for finding "Add to cart" buttons reliably.
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    args:   [accion],
    func:   async (a) => {
      if (window.edyEjecutarAccion) {
        return window.edyEjecutarAccion({
          tipo:        a.tipo,
          selector:    a.selector,
          valor:       a.valor,
          nombreCampo: a.nombreCampo,
          etiqueta:    a.nombreCampo,
          texto:       a.texto,
          contexto:    a.contexto,
        });
      }
      // Minimal fallback if content script is not ready
      const el = a.selector ? document.querySelector(a.selector) : null;
      if (!el) return false;
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      if (a.tipo === "input") {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        if (setter) setter.call(el, a.valor || ""); else el.value = a.valor || "";
        el.dispatchEvent(new Event("input",  { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        el.click();
      }
      return true;
    },
  });
  return results?.[0]?.result;
}

// ─── Local fallback inference ─────────────────────────────────────────────────

function inferirMapeoLocal(acciones) {
  // Group actions by URL into logical steps
  const mapaUrl = new Map();
  for (const accion of acciones) {
    if (!mapaUrl.has(accion.url)) mapaUrl.set(accion.url, []);
    mapaUrl.get(accion.url).push(accion);
  }

  const pasos = [];
  let stepNum = 1;
  for (const [, acts] of mapaUrl) {
    pasos.push({
      nombre:  "Paso " + stepNum++,
      acciones: acts.map((a) => ({
        tipo:     a.tipo,
        selector: a.selector,
        valor:    a.valor,
        campo:    a.nombreCampo,
      })).filter((a) => a.selector),
    });
  }

  return {
    portal_url:          acciones[0]?.url || "",
    tipo_flujo:          "orden_proveedor",
    origen:              "fallback_local",
    pasos,
    campos_confirmacion: [],
  };
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function normalizarAcciones(acc) {
  return Array.isArray(acc) ? acc.map((a) => normalizarAccion(a)) : [];
}

function normalizarAccion(a, tabId) {
  return {
    id:          a?.id || "",
    tipo:        a?.tipo || "click",
    selector:    a?.selector || "",
    valor:       a?.valor || "",
    texto:       String(a?.texto || "").slice(0, 120),
    contexto:    String(a?.contexto || "").slice(0, 120), // nearby product name
    tag:         a?.tag || "",
    nombreCampo: a?.nombreCampo || a?.campo || "",
    timestamp:   a?.timestamp || Date.now(),
    url:         a?.url || "",
    tabId:       a?.tabId || tabId || null,
  };
}

function unirAcciones(base, nuevas) {
  const resultado = normalizarAcciones(base);
  const firmas = new Set(resultado.map(firmaAccion));
  for (const a of normalizarAcciones(nuevas)) {
    const indexExistente = resultado.findIndex((existente) => accionesSonMismoCampoEditable(existente, a));
    if (indexExistente !== -1) {
      resultado[indexExistente] = {
        ...resultado[indexExistente],
        ...a,
        id: resultado[indexExistente].id || a.id,
      };
      continue;
    }

    const f = firmaAccion(a);
    if (firmas.has(f)) continue;
    firmas.add(f);
    resultado.push(a);
  }
  return resultado;
}

function accionesSonMismoCampoEditable(a, b) {
  const tipoA = normalizarTipoAccion(a?.tipo);
  const tipoB = normalizarTipoAccion(b?.tipo);
  const editableA = tipoA === "input" || tipoA === "change";
  const editableB = tipoB === "input" || tipoB === "change";
  if (!editableA || !editableB) return false;

  return normalizarTextoComparacion(a?.selector) === normalizarTextoComparacion(b?.selector) &&
    normalizarTextoComparacion(a?.url) === normalizarTextoComparacion(b?.url);
}

function firmaAccion(a) {
  return a.id || [a.tipo, a.selector, a.valor, a.timestamp, a.url].join("|");
}

function nombrePasoDesdeAccion(a, i) {
  const campo = a.nombreCampo || a.selector || "accion";
  if (a.tipo === "input" || a.tipo === "change") return "Capturar " + campo;
  if (a.tipo === "click") return "Click en " + campo;
  return "Paso " + (i + 1);
}

async function obtenerTabActiva() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

async function cargarEstadoPersistido() {
  const s = await chrome.storage.local.get([
    STORAGE_KEYS.estado,
    STORAGE_KEYS.originTabId,
    STORAGE_KEYS.originUrl,
    STORAGE_KEYS.acciones,
    STORAGE_KEYS.originSnapshot,
  ]);
  estado           = s[STORAGE_KEYS.estado]        || estado        || "idle";
  originTabId      = s[STORAGE_KEYS.originTabId]   || originTabId   || null;
  originUrl        = s[STORAGE_KEYS.originUrl]      || originUrl     || null;
  accionesGrabadas = normalizarAcciones(s[STORAGE_KEYS.acciones] || accionesGrabadas);
  originSnapshot   = s[STORAGE_KEYS.originSnapshot] || originSnapshot || [];
}

async function sincronizarTabDespuesDeNavegacion(tabId) {
  await cargarEstadoPersistido();
  if (estado !== "observando" || tabId !== originTabId) return;
  // Tell the content script on the new page to start recording immediately
  await chrome.tabs.sendMessage(tabId, { tipo: "iniciar_grabacion_tab" }).catch(() => {});
  await chrome.tabs.sendMessage(tabId, { tipo: "estado_agente", estado, totalAcciones: accionesGrabadas.length }).catch(() => {});
}

async function sincronizarContentScript(tabId) {
  await cargarEstadoPersistido();
  const esOrigen = !originTabId || tabId === originTabId;
  // content_script.js starts recording on its own when it receives estado_agente="observando"
  return { ok: true, estado: esOrigen ? estado : "idle", totalAcciones: accionesGrabadas.length };
}

async function enviarATodos(mensaje) {
  await chrome.runtime.sendMessage(mensaje).catch(() => {});
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map((t) => t.id
    ? chrome.tabs.sendMessage(t.id, mensaje).catch(() => {})
    : Promise.resolve()
  ));
}

function guardarLocal(datos) { return chrome.storage.local.set(datos); }
function esperar(ms) { return new Promise((r) => setTimeout(r, ms)); }
function formatearHora(ts) {
  return new Date(ts).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
