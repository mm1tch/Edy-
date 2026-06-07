// apps_script.gs
// Backend de Arca Agent en Google Apps Script.
// Exponer como Web App: Implementar → Nueva implementación → Aplicación web
//   Ejecutar como: Yo  |  Acceso: Cualquiera
// Copiar la URL generada → pegarla en DASHBOARD_URL (content_script.js) y en dashboard.js

const SHEET_NAME = "Pedidos"; // nombre de la pestaña dentro del Sheets

// ─────────────────────────────────────────────
//  doPost — recibe un pedido desde background.js
//  Body esperado (JSON): { portal, ...camposDinamicos }
//  Ejemplo: { portal:"SAP VA01", cliente_id:"C-4821", skus:"X1,X2", monto:500 }
// ─────────────────────────────────────────────
function doPost(e) {
  try {
    const datos = JSON.parse(e.postData.contents);
    datos.timestamp = new Date().toLocaleString("es-MX", { timeZone: "America/Monterrey" });

    const sheet = obtenerHoja();
    expandirColumnas(sheet, datos);
    agregarFila(sheet, datos);

    return respuestaOk({ mensaje: "guardado" });
  } catch (err) {
    return respuestaError(err.message);
  }
}

// ─────────────────────────────────────────────
//  doGet — devuelve todos los pedidos como JSON
//  Lo consume dashboard.js
// ─────────────────────────────────────────────
function doGet() {
  try {
    const sheet = obtenerHoja();
    const [encabezados, ...filas] = sheet.getDataRange().getValues();

    const registros = filas.map(fila => {
      const obj = {};
      encabezados.forEach((col, i) => { obj[col] = fila[i]; });
      return obj;
    });

    return respuestaOk(registros);
  } catch (err) {
    return respuestaError(err.message);
  }
}

// ─────────────────────────────────────────────
//  Helpers internos
// ─────────────────────────────────────────────

// Obtiene (o crea) la hoja de destino.
// Si la hoja existe pero está vacía, inicializa el encabezado automáticamente.
function obtenerHoja() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }
  // Si la hoja está vacía (sin encabezado), lo crea solo
  if (sheet.getLastColumn() === 0) {
    const celda = sheet.getRange(1, 1);
    celda.setValue("timestamp");
    celda.setFontWeight("bold");
  }
  return sheet;
}

// Si el pedido trae llaves nuevas que no existen como columna, las agrega al final.
// Así la tabla crece sola con cada portal distinto que aparezca.
function expandirColumnas(sheet, datos) {
  const encabezados = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const llaves = Object.keys(datos);

  llaves.forEach(llave => {
    if (!encabezados.includes(llave)) {
      const nuevaCol = sheet.getLastColumn() + 1;
      const celda = sheet.getRange(1, nuevaCol);
      celda.setValue(llave);
      celda.setFontWeight("bold");
      encabezados.push(llave); // actualiza el array local para la misma iteración
    }
  });
}

// Agrega una fila nueva respetando el orden actual de columnas.
// Las columnas que el pedido no traiga quedan como "—".
function agregarFila(sheet, datos) {
  const encabezados = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const fila = encabezados.map(col => (datos[col] !== undefined ? datos[col] : "—"));
  sheet.appendRow(fila);

  // Resalta la fila recién agregada con fondo suave para el efecto visual
  const ultimaFila = sheet.getLastRow();
  sheet.getRange(ultimaFila, 1, 1, encabezados.length)
    .setBackground("#fff5f5"); // rojo muy suave (brand color)

  // Quita el resaltado de la penúltima fila si existía
  if (ultimaFila > 2) {
    sheet.getRange(ultimaFila - 1, 1, 1, encabezados.length)
      .setBackground(null);
  }
}

// Respuestas JSON con CORS abierto (necesario para fetch desde el dashboard)
function respuestaOk(payload) {
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true, data: payload }))
    .setMimeType(ContentService.MimeType.JSON);
}

function respuestaError(mensaje) {
  return ContentService
    .createTextOutput(JSON.stringify({ ok: false, error: mensaje }))
    .setMimeType(ContentService.MimeType.JSON);
}
