const DEFAULT_GEMINI_MODEL = "gemini-2.0-flash-lite";

export async function aprenderMapeoConGemini(input) {
  const acciones = Array.isArray(input) ? input : input?.acciones;

  if (!Array.isArray(acciones) || acciones.length === 0) {
    throw new Error("No llegaron acciones para aprender el mapeo.");
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("Falta GEMINI_API_KEY en las variables de entorno.");
  }

  const model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  console.log("[Gemini] Modelo utilizado:", model);
  console.log("[Gemini] Viene de .env:", Boolean(process.env.GEMINI_MODEL));
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(model) +
    ":generateContent?key=" +
    encodeURIComponent(apiKey);

  const respuesta = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: crearPromptMapeo(acciones) }],
        },
      ],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: "application/json",
      },
    }),
  });

  const textoRespuesta = await respuesta.text();

  if (!respuesta.ok) {
    throw new Error("Gemini respondio " + respuesta.status + ": " + textoRespuesta);
  }

  const data = JSON.parse(textoRespuesta);
  const textoGemini = data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
  return parseGeminiJson(textoGemini);
}

function crearPromptMapeo(acciones) {
  return [
    "Eres el cerebro de un agente RPA llamado Edy para Arca Agent.",
    "Tu trabajo es leer acciones grabadas en una pagina web e inferir un mapeo semantico.",
    "Detecta campos como cliente_id, sku, cantidad, direccion, fecha_entrega, pedido_id y cualquier otro campo relevante.",
    "Aprende equivalencias aunque el origen y destino usen nombres distintos. Ejemplos: Product Name equivale a Nombre del Articulo; Price equivale a Costo Unitario; Quantity equivale a Cantidad; Zip Code equivale a Codigo Postal.",
    "Para cada campo, incluye nombre_origen, nombre_destino si lo puedes inferir, nombre_semantico canonico y aliases utiles.",
    "Conserva selectores CSS utiles para reproducir las acciones.",
    "Si una accion tiene valor capturado, mantenlo en el paso correspondiente.",
    "No inventes acciones ni botones que no aparezcan en las acciones grabadas.",
    "Si la pagina contiene botones alternativos como Cancelar, Regresar o Eliminar, incluyelos SOLO si el usuario realmente hizo click en ellos durante la grabacion.",
    "Cada paso ejecutable debe venir de una accion grabada. Usa los botones visibles solo como contexto, no como instrucciones nuevas.",
    "Tambien devuelve datos_sugeridos: un objeto selector -> valor nuevo, generando valores realistas y distintos a los grabados para todos los campos de texto capturados (nombre, apellido, direccion, codigo postal, telefono, correo, cantidad, etc). Usa el selector exacto que aparece en cada paso como llave.",
    "Responde SOLO JSON valido, sin markdown, sin explicaciones.",
    "La estructura exacta debe ser:",
    JSON.stringify({
      campos: [
        {
          nombre_origen: "Product Name",
          nombre_destino: "Nombre del Articulo",
          nombre_semantico: "product_name",
          aliases: ["producto", "articulo", "item_name"],
          selector: "#cliente",
          evidencia: "label, placeholder o texto usado para inferirlo",
        },
      ],
      pasos: [
        {
          nombre: "Capturar cliente_id",
          accion: "input",
          selector: "#cliente",
          valor: "12345",
        },
      ],
      datos_pedido: {
        cliente_id: "12345",
        sku: ["SKU-1"],
        cantidad: [10],
      },
      datos_sugeridos: {
        "#first-name": "Maria",
        "#last-name": "Lopez",
        "#postal-code": "64000",
      },
    }),
    "Acciones grabadas:",
    JSON.stringify(acciones, null, 2),
  ].join("\n");
}

function parseGeminiJson(texto) {
  const limpio = String(texto || "{}")
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  return JSON.parse(limpio);
}
