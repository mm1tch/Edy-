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
  datosNuevos:  "datos_nuevos",
  datosSugeridos:"datos_sugeridos",
  ultimoPerfil: "ultimo_perfil_ejecucion",
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
    [STORAGE_KEYS.datosNuevos]:    {},
    [STORAGE_KEYS.datosSugeridos]: {},
    [STORAGE_KEYS.ultimoPerfil]:   null,
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

  await guardarLocal({
    [STORAGE_KEYS.mapeo]:          mapeo,
    [STORAGE_KEYS.datosSugeridos]: (mapeo?.datos_sugeridos && typeof mapeo.datos_sugeridos === "object")
      ? mapeo.datos_sugeridos
      : {},
  });
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
    STORAGE_KEYS.datosSugeridos,
  ]);

  const mapeo   = storage[STORAGE_KEYS.mapeo];
  const acciones = normalizarAcciones(storage[STORAGE_KEYS.acciones] || accionesGrabadas);
  const numeroOrden = obtenerNumeroOrden(mapeo, acciones);

  if (!mapeo && !acciones.length) {
    throw new Error("Sin mapeo ni acciones. Observa el proceso primero.");
  }

  estado = "ejecutando";
  await chrome.action.setIcon({ path: ICONOS.pensando });
  await guardarLocal({ [STORAGE_KEYS.estado]: estado });

  const datosSugeridos = (mapeo?.datos_sugeridos && typeof mapeo.datos_sugeridos === "object")
    ? mapeo.datos_sugeridos
    : (storage[STORAGE_KEYS.datosSugeridos] || {});

  const perfilEjecucion = await generarPerfilEjecucion(acciones);
  const datosNuevos = generarDatosNuevosAutomaticos(acciones, perfilEjecucion, datosSugeridos);
  await guardarLocal({
    [STORAGE_KEYS.datosNuevos]: datosNuevos,
    [STORAGE_KEYS.ultimoPerfil]: perfilEjecucion,
  });

  const plan = aplicarVariacionesAutonomasAlPlan(
    construirPlanEjecucion(mapeo, acciones),
    datosNuevos,
    perfilEjecucion
  );
  if (!plan.length) {
    throw new Error("No hay pasos ejecutables. Graba el flujo otra vez desde el inicio.");
  }
  await enviarATodos({ tipo: "estado_agente", estado, totalAcciones: plan.length });
  await enviarATodos({ tipo: "orden_actual", orden: numeroOrden });

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
  const accionesEjecutadas = plan.flatMap((paso) => paso.acciones || []);
  const camposTranscritos = construirCamposTranscritos(accionesEjecutadas);
  const camposSeleccionados = construirCamposSeleccionados(accionesEjecutadas);
  const datosPedidoAprendidos = normalizarDatosPedido(mapeo?.datos_pedido);
  const preciosAprendidos = construirPreciosDesdeDatosPedido(datosPedidoAprendidos);
  datosRecopilados = {
    ...datosPedidoAprendidos,
    ...camposSeleccionados,
    ...preciosAprendidos,
    ...camposTranscritos,
    ...datosRecopilados,
  };
  const importeTotal = obtenerImporteTotal(datosRecopilados, camposSeleccionados, preciosAprendidos, datosPedidoAprendidos);

  const payload = {
    timestamp:          new Date().toISOString(),
    portal:             portalHostname,
    ejecutado_por:      "Edy",
    orden:              numeroOrden,
    cliente:            datosRecopilados.cliente  || portalHostname,
    skus:               datosRecopilados.productos_ordenados || datosRecopilados.productos || datosRecopilados.sku || "—",
    estado:             "Completada",
    tiempo_ahorrado:    3.5,
    importe_total:      importeTotal || "",
    ...camposSeleccionados,
    ...camposTranscritos,
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
          .map((accionMapeada) => prepararAccionMapeadaParaEjecucion(
            accionMapeada,
            obtenerAccionGrabadaCorrespondiente(accionMapeada, accionesGrabadas)
          ))
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
        accionGrabada: prepararAccionMapeadaParaEjecucion(
          paso,
          obtenerAccionGrabadaCorrespondiente(paso, accionesGrabadas)
        ),
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

async function generarPerfilEjecucion(acciones) {
  const storage = await chrome.storage.local.get(STORAGE_KEYS.ultimoPerfil);
  const anterior = storage[STORAGE_KEYS.ultimoPerfil] || {};
  const seed = Date.now() + Math.floor(Math.random() * 100000);
  const firstNames = ["Maria", "Ana", "Lucia", "Sofia", "Valeria", "Camila", "Elena", "Paola"];
  const lastNames = ["Lopez", "Garcia", "Martinez", "Torres", "Ramirez", "Santos", "Vega", "Morales"];
  const cities = ["Monterrey", "Guadalupe", "San Pedro", "Apodaca", "Santa Catarina", "Escobedo"];
  const streets = ["Av Nueva", "Calle Roble", "Paseo Norte", "Av Central", "Calle Lago", "Privada Sol"];
  const states = ["Nuevo Leon", "Jalisco", "Queretaro", "Coahuila", "Puebla", "Yucatan"];
  const countries = ["Mexico", "Canada", "Estados Unidos"];
  const zipCodes = ["64000", "66220", "67180", "66600", "64830", "44100", "76000", "97000"];

  const firstName = elegirDistintoPorSeed(firstNames, seed, anterior.firstName);
  const lastName = elegirDistintoPorSeed(lastNames, seed + 3, anterior.lastName);
  const slug = (firstName + "." + lastName + "." + String(seed).slice(-4)).toLowerCase();

  const productos = elegirProductosNuevos(acciones, seed, anterior.productos || [anterior.producto].filter(Boolean));

  return {
    seed,
    firstName,
    lastName,
    fullName: firstName + " " + lastName,
    email: slug + "@edy-demo.test",
    password: "EdyDemo" + String(seed).slice(-4) + "!",
    zipCode: elegirDistintoPorSeed(zipCodes, seed + 7, anterior.zipCode),
    phone: "81" + String(80000000 + (seed % 9999999)).padStart(8, "0").slice(0, 8),
    address: elegirPorSeed(streets, seed + 11) + " " + (100 + (seed % 899)),
    city: elegirDistintoPorSeed(cities, seed + 13, anterior.city),
    state: elegirDistintoPorSeed(states, seed + 17, anterior.state),
    country: elegirDistintoPorSeed(countries, seed + 19, anterior.country),
    producto: productos[0] || null,
    productos,
  };
}

function generarDatosNuevosAutomaticos(acciones, perfil, datosSugeridos) {
  const datos = {};
  const sugeridos = (datosSugeridos && typeof datosSugeridos === "object") ? datosSugeridos : {};
  let desdeGemini = 0;
  let desdeFallbackLocal = 0;

  normalizarAcciones(acciones).forEach((accion, index) => {
    const tipo = normalizarTipoAccion(accion.tipo);
    if (tipo !== "input" && tipo !== "change") return;
    if (!accion.selector) return;

    const sugerido = obtenerValorSugerido(accion, sugeridos);
    const valor = sugerido ?? generarValorNuevoParaAccion(accion, index, perfil);
    if (valor === undefined || valor === null) return;

    if (sugerido === null) desdeFallbackLocal++; else desdeGemini++;
    datos[accion.selector] = valor;
  });

  console.log(
    "[Edy] datos_nuevos generados:", Object.keys(datos).length,
    "(gemini:", desdeGemini, "· fallback local:", desdeFallbackLocal, ")",
    datos
  );
  if (!Object.keys(sugeridos).length) {
    console.warn("[Edy] datos_sugeridos vino vacío del mapeo aprendido — usando generador local como respaldo. " +
      "Vuelve a grabar el flujo para que Gemini genere sugerencias (requiere el backend actualizado).");
  }
  return datos;
}

// Looks up a Gemini-suggested value for this action's selector.
// Gemini learned the field semantics during mapping, so its suggestion
// (datos_sugeridos) takes priority over the local heuristic generator.
function obtenerValorSugerido(accion, sugeridos) {
  const valor = [accion.selectorGrabado, accion.selector]
    .filter(Boolean)
    .map((selector) => sugeridos[selector])
    .find((candidato) => candidato !== undefined && candidato !== null && String(candidato).trim() !== "");

  return valor === undefined ? null : valor;
}

function generarValorNuevoParaAccion(accion, index, perfil) {
  const original = String(accion.valor ?? "");
  const textoCampo = normalizarNombreCampoSheets([
    accion.nombreCampo,
    accion.texto,
    selectorANombreCampo(accion.selector),
  ].filter(Boolean).join(" "));
  const semantico = normalizarCampoSemantico(textoCampo);
  const texto = [textoCampo, semantico].filter(Boolean).join("_");

  if (contieneCampo(texto, ["first_name", "firstname", "nombre", "name"]) &&
      !contieneCampo(texto, ["last_name", "lastname", "apellido", "email", "username", "user_name"])) {
    return asegurarValorDistinto(perfil.firstName, original, perfil.firstName + " " + String(perfil.seed).slice(-2));
  }

  if (contieneCampo(texto, ["last_name", "lastname", "apellido", "surname"])) {
    return asegurarValorDistinto(perfil.lastName, original, perfil.lastName + " " + String(perfil.seed).slice(-2));
  }

  if (contieneCampo(texto, ["full_name", "customer", "cliente", "client", "nombre_cliente"])) {
    return asegurarValorDistinto(perfil.fullName, original, perfil.fullName + " " + String(perfil.seed).slice(-2));
  }

  if (contieneCampo(texto, ["email", "correo", "mail"])) {
    return asegurarValorDistinto(perfil.email, original, "edy." + perfil.seed + "@edy-demo.test");
  }

  if (contieneCampo(texto, ["password", "contrasena", "pass"])) {
    return asegurarValorDistinto(perfil.password, original, perfil.password.replace("!", "#"));
  }

  if (contieneCampo(texto, ["zip_code", "postal_code", "zipcode", "codigo_postal", "cp", "zip", "postal"])) {
    return asegurarValorDistinto(perfil.zipCode, original, String(Number(perfil.zipCode) + 1));
  }

  if (contieneCampo(texto, ["phone", "telefono", "tel", "mobile", "celular"])) {
    return asegurarValorDistinto(perfil.phone, original, "81" + String(70000000 + (perfil.seed % 9999999)).padStart(8, "0").slice(0, 8));
  }

  if (contieneCampo(texto, ["address", "direccion", "street", "calle"])) {
    return asegurarValorDistinto(perfil.address, original, perfil.address + " Int " + ((perfil.seed % 20) + 1));
  }

  if (contieneCampo(texto, ["city", "ciudad", "municipio"])) {
    return asegurarValorDistinto(perfil.city, original, perfil.city + " Centro");
  }

  if (contieneCampo(texto, ["state", "estado", "province", "provincia"])) {
    return asegurarValorDistinto(perfil.state, original, perfil.state + " Norte");
  }

  if (contieneCampo(texto, ["country", "pais"])) {
    return asegurarValorDistinto(perfil.country, original, perfil.country + " Demo");
  }

  if (contieneCampo(texto, ["quantity", "qty", "cantidad", "unidades"])) {
    return asegurarValorDistinto(incrementarNumeroTexto(original, 1, "2"), original, "3");
  }

  if (normalizarTipoAccion(accion.tipo) === "change") {
    return undefined;
  }

  if (pareceNumero(original)) {
    return asegurarValorDistinto(incrementarNumeroTexto(original, 1, "2"), original, "3");
  }

  if (original.includes("@")) {
    return asegurarValorDistinto(perfil.email, original, "edy." + perfil.seed + "@edy-demo.test");
  }

  if (original.trim()) {
    return asegurarValorDistinto(original.trim() + " nuevo", original, "Dato nuevo " + (index + 1));
  }

  return "Dato nuevo " + (index + 1);
}

function aplicarVariacionesAutonomasAlPlan(plan, datosNuevos, perfil) {
  if (!Array.isArray(plan) || !datosNuevos || typeof datosNuevos !== "object") return plan;

  let overridesAplicados = 0;
  let productosCambiados = 0;
  let indiceProducto = 0;
  const planConDatosNuevos = plan.map((paso) => ({
    ...paso,
    acciones: (paso.acciones || []).map((accion) => {
      const tipo = normalizarTipoAccion(accion.tipo);
      if (tipo === "click") {
        const producto = construirAccionProductoAlternativo(accion, perfil, indiceProducto);
        if (!producto) return accion;
        indiceProducto++;
        productosCambiados++;
        return producto;
      }

      if (tipo !== "input" && tipo !== "change") return accion;

      const selectorConOverride = [accion.selectorGrabado, accion.selector]
        .filter(Boolean)
        .find((selector) => Object.prototype.hasOwnProperty.call(datosNuevos, selector));

      if (!selectorConOverride) return accion;

      overridesAplicados++;
      return {
        ...accion,
        valor: datosNuevos[selectorConOverride],
      };
    }),
  }));

  console.log("[Edy] datos_nuevos aplicados:", overridesAplicados);
  console.log("[Edy] productos cambiados:", productosCambiados);
  return planConDatosNuevos;
}

function construirAccionProductoAlternativo(accion, perfil, indiceProducto = 0) {
  const texto = normalizarTextoComparacion([
    accion.selector,
    accion.texto,
    accion.nombreCampo,
    accion.contexto,
    accion.detalle?.id,
    accion.detalle?.nombre,
  ].filter(Boolean).join(" "));

  const producto = perfil?.productos?.[indiceProducto] || perfil?.producto;
  if (!esClickDeProducto(texto) || !producto) return null;

  return {
    ...accion,
    selectorOriginal: accion.selector,
    contextoOriginal: accion.contexto,
    selector: producto.selector,
    texto: accion.texto || "Add to cart",
    contexto: producto.nombre,
    detalle: {
      id: producto.id,
      nombre: producto.nombre,
      precio: producto.precio,
    },
    productoAlternativo: producto,
    preferirProductoDistinto: true,
  };
}

function esClickDeProducto(texto) {
  if (!texto) return false;
  const esAgregarOSeleccionar = ["add", "cart", "agregar", "seleccionar", "comprar"].some((p) => texto.includes(p));
  const pareceProducto = texto.includes("sauce-labs") || texto.includes("producto") || texto.includes("product") || texto.includes("item");
  return esAgregarOSeleccionar && pareceProducto;
}

function elegirProductosNuevos(acciones, seed, productosAnteriores = []) {
  const productos = productosConocidos();
  const accionesProducto = normalizarAcciones(acciones).filter((accion) =>
    normalizarTipoAccion(accion.tipo) === "click" &&
    esClickDeProducto(normalizarTextoComparacion([
      accion.selector,
      accion.texto,
      accion.nombreCampo,
      accion.contexto,
      accion.detalle?.id,
      accion.detalle?.nombre,
    ].filter(Boolean).join(" ")))
  );

  const esCatalogoConocido = accionesProducto.some((accion) => normalizarProductoId([
    accion.selector,
    accion.contexto,
    accion.detalle?.id,
    accion.detalle?.nombre,
  ].filter(Boolean).join(" ")));
  if (!esCatalogoConocido) return [];

  const idsGrabados = new Set(accionesProducto
    .map((accion) => normalizarProductoId(accion.detalle?.id || accion.selector || accion.contexto || accion.texto))
    .filter(Boolean));
  const idsAnteriores = new Set((productosAnteriores || []).map((producto) => producto?.id).filter(Boolean));

  const candidatosSinGrabados = productos.filter((producto) => !idsGrabados.has(producto.id));
  const candidatosSinAnterior = candidatosSinGrabados.filter((producto) => !idsAnteriores.has(producto.id));
  const candidatos = candidatosSinAnterior.length ? candidatosSinAnterior : candidatosSinGrabados;
  const fuente = candidatos.length ? candidatos : productos;
  const inicio = Math.abs(seed + 23) % fuente.length;
  const rotados = fuente.slice(inicio).concat(fuente.slice(0, inicio));
  return rotados.slice(0, Math.max(1, accionesProducto.length));
}

function productosConocidos() {
  return [
    { id: "sauce-labs-backpack", nombre: "Sauce Labs Backpack", precio: "29.99" },
    { id: "sauce-labs-bike-light", nombre: "Sauce Labs Bike Light", precio: "9.99" },
    { id: "sauce-labs-bolt-t-shirt", nombre: "Sauce Labs Bolt T-Shirt", precio: "15.99" },
    { id: "sauce-labs-fleece-jacket", nombre: "Sauce Labs Fleece Jacket", precio: "49.99" },
    { id: "sauce-labs-onesie", nombre: "Sauce Labs Onesie", precio: "7.99" },
    { id: "test.allthethings-t-shirt-red", nombre: "Test.allTheThings() T-Shirt (Red)", precio: "15.99" },
  ].map((producto) => ({
    ...producto,
    selector: `[data-test="add-to-cart-${producto.id}"]`,
  }));
}

function normalizarProductoId(valor) {
  const texto = normalizarTextoComparacion(valor)
    .replace(/^#/, "")
    .replace(/_/g, "-")
    .replace(/\s+/g, "-");

  const match = texto.match(/(?:add-to-cart-)?((?:sauce-labs|test\.allthethings|test-allthethings)[a-z0-9.-]*)/);
  return match ? match[1].replace(/^add-to-cart-/, "") : "";
}

function elegirPorSeed(lista, seed) {
  if (!Array.isArray(lista) || !lista.length) return null;
  return lista[Math.abs(seed) % lista.length];
}

function elegirDistintoPorSeed(lista, seed, anterior) {
  if (!Array.isArray(lista) || !lista.length) return null;
  const candidatos = lista.filter((item) => String(item) !== String(anterior || ""));
  return elegirPorSeed(candidatos.length ? candidatos : lista, seed);
}

function contieneCampo(texto, opciones) {
  return opciones.some((opcion) => texto.includes(opcion));
}

function asegurarValorDistinto(candidato, original, alternativo) {
  const valor = String(candidato ?? "");
  const previo = String(original ?? "");
  if (valor.trim() !== previo.trim()) return valor;

  const alt = String(alternativo ?? "");
  if (alt.trim() && alt.trim() !== previo.trim()) return alt;

  return valor ? valor + " 2" : "Dato nuevo";
}

function pareceNumero(valor) {
  return /^-?\d+(?:[.,]\d+)?$/.test(String(valor || "").trim());
}

function incrementarNumeroTexto(valor, incremento, fallback) {
  const numero = Number(String(valor || "").replace(",", "."));
  if (!Number.isFinite(numero)) return fallback;
  return String(numero + incremento);
}

function filtrarAccionesNoGrabadas(accionesMapeadas, accionesGrabadas) {
  if (!Array.isArray(accionesMapeadas)) return [];
  if (!Array.isArray(accionesGrabadas) || accionesGrabadas.length === 0) return accionesMapeadas;
  return accionesMapeadas.filter((accion) => accionMapeadaFueGrabada(accion, accionesGrabadas));
}

function accionMapeadaFueGrabada(accionMapeada, accionesGrabadas) {
  return Boolean(obtenerAccionGrabadaCorrespondiente(accionMapeada, accionesGrabadas));
}

function prepararAccionMapeadaParaEjecucion(accionMapeada, accionGrabada) {
  if (!accionGrabada) return null;

  const tipoMapeado = normalizarTipoAccion(accionMapeada.accion || accionMapeada.tipo || accionGrabada.tipo);
  if (tipoMapeado !== "input" && tipoMapeado !== "change") return accionGrabada;

  return {
    ...accionGrabada,
    tipo: tipoMapeado,
    selector: accionMapeada.selector || accionGrabada.selector,
    selectorGrabado: accionGrabada.selector,
    nombreCampo:
      accionMapeada.nombre_destino ||
      accionMapeada.campo ||
      accionMapeada.nombreCampo ||
      accionMapeada.nombre ||
      accionGrabada.nombreCampo,
    etiqueta:
      accionMapeada.nombre_destino ||
      accionMapeada.nombre_origen ||
      accionMapeada.nombre_semantico ||
      accionGrabada.nombreCampo,
    aliases: [
      accionMapeada.nombre_origen,
      accionMapeada.nombre_destino,
      accionMapeada.nombre_semantico,
      ...(Array.isArray(accionMapeada.aliases) ? accionMapeada.aliases : []),
    ].filter(Boolean),
  };
}

function obtenerAccionGrabadaCorrespondiente(accionMapeada, accionesGrabadas) {
  if (!accionMapeada?.selector) return false;
  const tipoMapeado = normalizarTipoAccion(accionMapeada.accion || accionMapeada.tipo || "click");
  const selectorMapeado = normalizarTextoComparacion(accionMapeada.selector);
  const campoMapeado = normalizarCampoSemantico(
    accionMapeada.nombre_semantico ||
    accionMapeada.nombre_destino ||
    accionMapeada.nombre_origen ||
    accionMapeada.campo ||
    accionMapeada.nombreCampo ||
    accionMapeada.nombre ||
    ""
  );

  return normalizarAcciones(accionesGrabadas).find((accionGrabada) => {
    if (!accionGrabadaEsEjecutableSegura(accionGrabada)) return false;

    const tipoGrabado = normalizarTipoAccion(accionGrabada.tipo);
    if (!tiposCompatibles(tipoMapeado, tipoGrabado)) return false;

    const mismoSelector = normalizarTextoComparacion(accionGrabada.selector) === selectorMapeado;
    if (mismoSelector) return true;

    if (tipoMapeado !== "input" && tipoMapeado !== "change") return false;

    const campoGrabado = normalizarCampoSemantico(
      accionGrabada.nombreCampo || accionGrabada.texto || selectorANombreCampo(accionGrabada.selector)
    );

    return Boolean(campoMapeado && campoGrabado && campoMapeado === campoGrabado);
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

function normalizarCampoSemantico(valor) {
  const base = normalizarNombreCampoSheets(valor);
  if (!base) return "";

  const aliases = {
    product_name: [
      "product_name", "product", "producto", "nombre_producto", "nombre_del_producto",
      "nombre_articulo", "nombre_del_articulo", "articulo", "item", "item_name",
      "inventory_item_name",
    ],
    unit_price: [
      "price", "precio", "costo", "unit_price", "precio_unitario", "costo_unitario",
      "monto_unitario", "valor_unitario",
    ],
    quantity: [
      "quantity", "qty", "cantidad", "unidades", "numero_de_unidades",
    ],
    zip_code: [
      "zip", "zip_code", "zipcode", "postal_code", "codigo_postal", "cp",
    ],
    customer: [
      "customer", "cliente", "client", "nombre_cliente", "customer_name",
    ],
    sku: [
      "sku", "codigo_sku", "codigo_producto", "product_code", "item_code",
    ],
  };

  for (const [canonico, opciones] of Object.entries(aliases)) {
    if (opciones.includes(base)) return canonico;
  }

  return base;
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

function construirCamposTranscritos(acciones) {
  const campos = {};
  const usadosPorSelector = new Map();

  for (const accion of normalizarAcciones(acciones)) {
    const tipo = normalizarTipoAccion(accion.tipo);
    if (tipo !== "input" && tipo !== "change") continue;
    if (accion.valor === undefined || accion.valor === null || String(accion.valor).trim() === "") continue;

    const nombreBase = normalizarNombreCampoSheets(
      accion.nombreCampo || accion.texto || selectorANombreCampo(accion.selector)
    );
    if (!nombreBase) continue;

    const selectorKey = normalizarTextoComparacion(accion.selector);
    const nombre = usadosPorSelector.get(selectorKey) || siguienteNombreDisponible(nombreBase, campos);
    usadosPorSelector.set(selectorKey, nombre);
    campos[nombre] = accion.valor;
  }

  return campos;
}

function normalizarDatosPedido(datosPedido) {
  if (!datosPedido || typeof datosPedido !== "object") return {};

  const normalizados = {};
  for (const [key, value] of Object.entries(datosPedido)) {
    const nombre = normalizarNombreCampoSheets(key);
    if (!nombre) continue;
    normalizados[nombre] = Array.isArray(value) ? value.join(", ") : value;
  }

  return normalizados;
}

function obtenerNumeroOrden(mapeo, acciones) {
  const datosPedido = normalizarDatosPedido(mapeo?.datos_pedido);
  const candidatos = [
    datosPedido.orden_id,
    datosPedido.order_id,
    datosPedido.numero_orden,
    datosPedido.order_number,
    datosPedido.pedido_id,
    datosPedido.id_pedido,
  ];

  for (const candidato of candidatos) {
    if (candidato !== undefined && candidato !== null && String(candidato).trim()) {
      return String(candidato).trim();
    }
  }

  const primeraAccionId = normalizarAcciones(acciones)[0]?.id || "";
  const seed = primeraAccionId ? primeraAccionId.replace(/[^a-z0-9]/gi, "").slice(-6) : Date.now().toString().slice(-6);
  return "EDY-" + seed.toUpperCase();
}

function obtenerImporteTotal(...fuentes) {
  const posiblesNombres = [
    "total",
    "importe_total",
    "subtotal",
    "precio_total",
    "total_compra",
    "order_total",
    "cart_total",
    "checkout_total",
    "producto_precio",
  ];

  for (const fuente of fuentes) {
    if (!fuente || typeof fuente !== "object") continue;
    for (const nombre of posiblesNombres) {
      const valor = fuente[nombre];
      if (valor !== undefined && valor !== null && String(valor).trim() !== "" && String(valor).trim() !== "—") {
        return formatearImporte(valor);
      }
    }
  }

  return "";
}

function construirPreciosDesdeDatosPedido(datosPedido) {
  const skus = extraerLista(datosPedido?.sku || datosPedido?.skus || datosPedido?.productos || datosPedido?.productos_ordenados);
  if (!skus.length) return {};

  const precios = skus
    .map((sku) => precioConocidoProducto(sku))
    .filter(Boolean);

  if (!precios.length) return {};

  const campos = {};
  precios.forEach((precio, index) => {
    const sufijo = precios.length > 1 ? "_" + (index + 1) : "";
    campos["producto_precio" + sufijo] = precio;
  });

  campos.productos_precios = precios.join(", ");
  campos.importe_total = sumarPrecios(precios);

  return campos;
}

function extraerLista(valor) {
  if (Array.isArray(valor)) return valor.map(String).filter(Boolean);
  if (valor === undefined || valor === null) return [];
  return String(valor)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function precioConocidoProducto(nombreOsku) {
  const key = normalizarTextoComparacion(nombreOsku)
    .replace(/_/g, "-")
    .replace(/\s+/g, "-");

  const precios = {
    "sauce-labs-backpack": "29.99",
    "sauce-labs-bike-light": "9.99",
    "sauce-labs-bolt-t-shirt": "15.99",
    "sauce-labs-fleece-jacket": "49.99",
    "sauce-labs-onesie": "7.99",
    "test.allthethings-t-shirt-red": "15.99",
    "test-allthethings-t-shirt-red": "15.99",
  };

  return precios[key] || "";
}

function formatearImporte(valor) {
  if (Array.isArray(valor)) return formatearImporte(valor[0]);

  const texto = String(valor).trim();
  const numero = Number(texto.replace(/[^0-9.,-]/g, "").replace(",", "."));
  if (!Number.isFinite(numero)) return texto;

  return numero.toFixed(2);
}

function construirCamposSeleccionados(acciones) {
  const seleccionados = normalizarAcciones(acciones)
    .filter((accion) => normalizarTipoAccion(accion.tipo) === "click")
    .filter((accion) => accion.contexto || accion.detalle?.nombre || accion.detalle?.id || accion.detalle?.precio)
    .filter((accion) => {
      const texto = normalizarTextoComparacion([accion.texto, accion.nombreCampo].filter(Boolean).join(" "));
      return texto.includes("add") ||
        texto.includes("cart") ||
        texto.includes("select") ||
        texto.includes("seleccionar") ||
        texto.includes("agregar") ||
        texto.includes("comprar") ||
        texto.includes("view") ||
        texto.includes("product");
    });

  const campos = {};

  seleccionados.forEach((accion, index) => {
    const sufijo = seleccionados.length > 1 ? "_" + (index + 1) : "";
    const detalle = accion.detalle || {};
    const nombre = detalle.nombre || accion.contexto || accion.texto || "";
    const id = detalle.id || extraerIdProductoTexto(accion.selector) || extraerIdProductoTexto(nombre);
    const precio = detalle.precio || extraerPrecioTexto(accion.contexto || accion.texto || "");

    if (nombre) campos["producto_seleccionado" + sufijo] = nombre;
    if (id) campos["producto_id" + sufijo] = id;
    if (precio) campos["producto_precio" + sufijo] = precio;
  });

  if (seleccionados.length > 1) {
    const nombres = seleccionados
      .map((accion) => accion.detalle?.nombre || accion.contexto || "")
      .filter(Boolean);
    const ids = seleccionados
      .map((accion) => accion.detalle?.id || extraerIdProductoTexto(accion.selector) || extraerIdProductoTexto(accion.contexto))
      .filter(Boolean);

    if (nombres.length) campos.productos_seleccionados = nombres.join(", ");
    if (ids.length) campos.productos_ids = ids.join(", ");
  }

  const precios = seleccionados
    .map((accion) => accion.detalle?.precio || extraerPrecioTexto(accion.contexto || accion.texto || ""))
    .filter(Boolean);
  const total = sumarPrecios(precios);

  if (precios.length) campos.productos_precios = precios.join(", ");
  if (total) campos.importe_total = total;

  return campos;
}

function sumarPrecios(precios) {
  const numeros = precios
    .map((precio) => Number(String(precio).replace(/[^0-9.,-]/g, "").replace(",", ".")))
    .filter((n) => Number.isFinite(n));

  if (!numeros.length) return "";

  const total = numeros.reduce((acc, n) => acc + n, 0);
  return total.toFixed(2);
}

function extraerPrecioTexto(texto) {
  const match = String(texto || "").match(/(?:\$|USD|MXN|Rs\.?)\s*\d+(?:[.,]\d{1,2})?/i);
  return match ? match[0].trim() : "";
}

function extraerIdProductoTexto(texto) {
  const match = String(texto || "").match(/\b(?:SKU|ID|Item|Producto|Product|sauce-labs)[\s:#_-]*([A-Z0-9_-]{2,})\b/i);
  return match ? match[1].trim() : "";
}

function selectorANombreCampo(selector) {
  const limpio = String(selector || "")
    .replace(/^#/, "")
    .replace(/^\w+\[name=["']?([^"'\]]+)["']?\]$/, "$1")
    .replace(/^\w+\[aria-label=["']?([^"'\]]+)["']?\]$/, "$1")
    .replace(/^\[data-test=["']?([^"'\]]+)["']?\]$/, "$1");
  return limpio;
}

function normalizarNombreCampoSheets(nombre) {
  return String(nombre || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

function siguienteNombreDisponible(nombreBase, objeto) {
  if (!Object.prototype.hasOwnProperty.call(objeto, nombreBase)) return nombreBase;

  let i = 2;
  while (Object.prototype.hasOwnProperty.call(objeto, nombreBase + "_" + i)) i++;
  return nombreBase + "_" + i;
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
          aliases:     a.aliases,
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
    detalle:      a?.detalle && typeof a.detalle === "object" ? {
      id:     String(a.detalle.id || "").slice(0, 80),
      nombre: String(a.detalle.nombre || "").slice(0, 120),
      precio: String(a.detalle.precio || "").slice(0, 80),
    } : {},
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
