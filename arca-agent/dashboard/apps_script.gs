// apps_script.gs — Edy: Google Apps Script backend
// Deploy as Web App (Execute as: Me, Access: Anyone) and paste the URL into the extension.

var HOJA_NOMBRE = "Pedidos";
var COLUMNAS = ["timestamp", "portal", "ejecutado_por", "orden", "cliente", "skus", "importe", "estado", "tiempo_ahorrado", "datos_completos"];

// ─── POST: recibe un pedido de la extensión y lo guarda en Sheets ─────────────

function doPost(e) {
  try {
    var raw = e.postData && e.postData.contents ? e.postData.contents : "{}";
    var datos = JSON.parse(raw);
    var hoja = obtenerHoja();

    var fila = COLUMNAS.map(function(col) {
      var val = datos[col];
      if (val === undefined || val === null) return "";
      if (typeof val === "object") return JSON.stringify(val);
      return String(val);
    });

    hoja.appendRow(fila);
    SpreadsheetApp.flush();

    return ContentService
      .createTextOutput(JSON.stringify({ ok: true, mensaje: "Pedido guardado" }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ─── GET: devuelve todos los pedidos en formato JSON para el dashboard ────────

function doGet(e) {
  try {
    var hoja = obtenerHoja();
    var filas = hoja.getDataRange().getValues();

    if (filas.length <= 1) {
      return jsonResponse({ ok: true, data: [] });
    }

    var encabezados = filas[0].map(function(h) { return String(h).toLowerCase(); });
    var pedidos = [];

    for (var i = 1; i < filas.length; i++) {
      var fila = filas[i];
      var obj = {};
      encabezados.forEach(function(col, idx) {
        obj[col] = fila[idx];
      });

      // Normalizar para dashboard.js (espera estos campos)
      pedidos.push({
        orden:     obj.orden     || obj.cliente_id || ("EDY-" + i),
        cliente:   obj.cliente   || obj.cliente_nombre || obj.portal || "—",
        skus:      obj.skus      || obj.sku_producto  || "—",
        importe:   obj.importe   || obj.monto         || "—",
        hora:      obj.timestamp || obj.hora          || "",
        estado:    obj.estado    || "Completada",
        portal:    obj.portal    || "—",
        ejecutado_por: obj.ejecutado_por || "Edy",
        tiempo_ahorrado: obj.tiempo_ahorrado || "3.5",
      });
    }

    return jsonResponse({ ok: true, data: pedidos });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message, data: [] });
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function obtenerHoja() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var hoja = ss.getSheetByName(HOJA_NOMBRE);

  if (!hoja) {
    hoja = ss.insertSheet(HOJA_NOMBRE);
    hoja.appendRow(COLUMNAS);
    hoja.getRange(1, 1, 1, COLUMNAS.length).setFontWeight("bold").setBackground("#1a1a2e").setFontColor("#ffffff");
    hoja.setFrozenRows(1);
  }

  return hoja;
}

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
