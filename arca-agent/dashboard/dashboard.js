// dashboard.js
// Consume el doGet() del Apps Script y pinta el dashboard.
// Pegar aquí la URL del Web App después de desplegarlo en Google Apps Script.

const WEB_APP_URL =
  "https://script.google.com/macros/s/AKfycbwZIds6wFjyqLf33nPOvS5SJ86YR0Z932lSS-iz80-ll8p3lgVydJQpjbamSfC1N1uM7w/exec";

// ─────────────────────────────────────────────
//  Estado global
// ─────────────────────────────────────────────
let todosLosRegistros = [];
let cantidadAnterior = 0;

// ─────────────────────────────────────────────
//  Carga de datos desde Apps Script
// ─────────────────────────────────────────────
async function cargarDatos() {
  try {
    const res = await fetch(WEB_APP_URL);
    const json = await res.json();
    if (!json.ok) throw new Error(json.error);

    const hayNuevos = json.data.length > todosLosRegistros.length;
    todosLosRegistros = json.data;

    actualizarSubtitulo();
    actualizarStats();
    renderTabla(hayNuevos);
  } catch (err) {
    console.error("Edy dashboard:", err);
  } finally {
    document.getElementById("spinner").classList.add("hidden");
  }
}

// ─────────────────────────────────────────────
//  Subtítulo dinámico con fecha y portal
// ─────────────────────────────────────────────
function actualizarSubtitulo() {
  const fecha = new Date().toLocaleDateString("es-MX", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  const portales = [
    ...new Set(todosLosRegistros.map((r) => r.portal).filter(Boolean)),
  ];
  const portal = portales.length === 1 ? portales[0] : "Distribución Monterrey";
  document.getElementById("page-sub").textContent =
    fecha.charAt(0).toUpperCase() + fecha.slice(1) + " · " + portal;
}

// ─────────────────────────────────────────────
//  Tarjetas de estadísticas
// ─────────────────────────────────────────────
function actualizarStats() {
  const total = todosLosRegistros.length;

  // Portales activos: valores únicos de la columna "portal"
  const portales = new Set(
    todosLosRegistros.map((r) => r.portal).filter(Boolean)
  ).size;

  // Campos capturados: cuenta todas las celdas que no sean "—" ni vacías,
  // excluyendo timestamp, estado y portal (son de control, no datos del proceso)
  const EXCLUIR = new Set(["timestamp", "estado", "portal"]);
  const campos = todosLosRegistros.reduce((acc, r) => {
    return acc + Object.entries(r).filter(
      ([k, v]) => !EXCLUIR.has(k) && v && v !== "—"
    ).length;
  }, 0);

  // Clics ahorrados: cada campo requiere ~3 interacciones (click + escribir + tab)
  const clics = campos * 3;

  // Deltas vs ciclo anterior
  const diffTotal = total - cantidadAnterior;

  document.getElementById("stat-total").textContent = total || "0";
  document.getElementById("stat-portales").textContent = portales || "0";
  document.getElementById("stat-campos").textContent = campos || "0";
  document.getElementById("stat-clics").textContent = clics || "0";

  document.getElementById("stat-delta-total").textContent =
    cantidadAnterior > 0 && diffTotal > 0 ? "↑ " + diffTotal + " nueva" + (diffTotal > 1 ? "s" : "") : "";
  document.getElementById("stat-delta-portales").textContent =
    portales === 1 ? portales + " portal" : portales > 1 ? portales + " portales" : "";
  document.getElementById("stat-delta-campos").textContent =
    campos > 0 ? "~" + (campos / Math.max(total, 1)).toFixed(0) + " por orden" : "";
  document.getElementById("stat-delta-clics").textContent =
    clics > 0 ? "sin intervención humana" : "";

  cantidadAnterior = total;
}

// ─────────────────────────────────────────────
//  Render de la tabla
// ─────────────────────────────────────────────
function renderTabla(hayNuevos = false) {
  const tabla = document.getElementById("tabla");
  const vacio = document.getElementById("vacio");
  const buscar = document.getElementById("filtro-buscar").value.toLowerCase();

  let registros = todosLosRegistros.filter((r) => {
    if (!buscar) return true;
    return JSON.stringify(r).toLowerCase().includes(buscar);
  });

  if (registros.length === 0) {
    tabla.classList.add("hidden");
    vacio.classList.remove("hidden");
    return;
  }

  tabla.classList.remove("hidden");
  vacio.classList.add("hidden");

  const tbody = document.getElementById("tbody");
  tbody.innerHTML = "";

  // Más recientes primero
  [...registros].reverse().forEach((r, idx) => {
    const tr = document.createElement("tr");
    if (hayNuevos && idx === 0) tr.className = "nueva";

    // Extraer hora del timestamp si existe (formato "DD/MM/YYYY, HH:MM:SS")
    let hora = r.hora || "—";
    if (!r.hora && r.timestamp) {
      const match = r.timestamp.match(/(\d{1,2}:\d{2})/);
      if (match) hora = match[1];
    }

    // SKUs: mostrar "N SKUs" si es array/string con comas, o el valor directo
    let skus = r.skus || r.sku_producto || "—";
    if (Array.isArray(skus)) skus = skus.length + " SKUs";
    else if (String(skus).includes(","))
      skus = String(skus).split(",").length + " SKUs";
    else if (skus !== "—") skus = skus + " SKUs";

    // Importe: formatear si es número
    let importe = r.importe || r.monto || "—";
    if (importe !== "—" && !isNaN(importe)) {
      importe =
        "$ " +
        Number(importe).toLocaleString("es-MX", { minimumFractionDigits: 2 });
    }

    tr.innerHTML =
      `<td>${r.orden || r.cliente_id || "—"}</td>` +
      `<td>${r.cliente || r.cliente_nombre || "—"}</td>` +
      `<td>${skus}</td>` +
      `<td>${importe}</td>` +
      `<td>${hora}</td>` +
      `<td>${badgeEstado(r.estado)}</td>`;

    tbody.appendChild(tr);
  });
}

// ─────────────────────────────────────────────
//  Badge de estado
// ─────────────────────────────────────────────
function badgeEstado(val) {
  if (!val || val === "—") return '<span class="badge badge-cola">—</span>';
  const v = String(val).toLowerCase();
  if (v.includes("ejecut"))
    return `<span class="badge badge-ejecutando">${val}</span>`;
  if (v.includes("complet"))
    return `<span class="badge badge-completada">${val}</span>`;
  if (v.includes("cola")) return `<span class="badge badge-cola">${val}</span>`;
  if (v.includes("error") || v.includes("fall"))
    return `<span class="badge badge-error">${val}</span>`;
  return `<span class="badge badge-cola">${val}</span>`;
}

// ─────────────────────────────────────────────
//  Arranque y auto-refresh cada 3 segundos
// ─────────────────────────────────────────────
cargarDatos();
setInterval(cargarDatos, 3000);
