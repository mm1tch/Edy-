import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.join(__dirname, ".env"));

const PORT = Number(process.env.PORT || 3000);
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";

const server = http.createServer(async (req, res) => {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (req.method === "GET" && req.url === "/health") {
      sendJson(res, 200, {
        ok: true,
        service: "arca-agent-backend",
        geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
      });
      return;
    }

    if (req.method === "POST" && req.url === "/api/aprender-mapeo") {
      const payload = await readJsonBody(req);

      if (payload.tipo !== "aprender_mapeo") {
        sendJson(res, 400, {
          ok: false,
          error: "tipo debe ser aprender_mapeo",
        });
        return;
      }

      const mapeo = await aprenderMapeoConGemini(payload.acciones || []);
      sendJson(res, 200, { ok: true, mapeo });
      return;
    }

    sendJson(res, 404, {
      ok: false,
      error: "Ruta no encontrada",
    });
  } catch (error) {
    console.error("[arca-agent-backend]", error);
    sendJson(res, 500, {
      ok: false,
      error: error.message,
    });
  }
});

server.listen(PORT, () => {
  console.log(`Arca Agent backend escuchando en el puerto ${PORT}`);
  console.log(`Endpoint local: http://localhost:${PORT}/api/aprender-mapeo`);
});

async function aprenderMapeoConGemini(acciones) {
  if (!Array.isArray(acciones) || acciones.length === 0) {
    throw new Error("No llegaron acciones para aprender el mapeo.");
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("Falta GEMINI_API_KEY en arca-agent/backend/.env");
  }

  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(GEMINI_MODEL) +
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
    "Conserva selectores CSS utiles para reproducir las acciones.",
    "Si una accion tiene valor capturado, mantenlo en el paso correspondiente.",
    "Responde SOLO JSON valido, sin markdown, sin explicaciones.",
    "La estructura exacta debe ser:",
    JSON.stringify({
      campos: [
        {
          nombre_semantico: "cliente_id",
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
    }),
    "Acciones grabadas:",
    JSON.stringify(acciones, null, 2),
  ].join("\n");
}

function loadEnv(envPath) {
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) continue;

    const key = trimmed.slice(0, equalsIndex).trim();
    const value = trimmed.slice(equalsIndex + 1).trim().replace(/^["']|["']$/g, "");

    if (!process.env[key]) process.env[key] = value;
  }
}

async function readJsonBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};

  return JSON.parse(raw);
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

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}
