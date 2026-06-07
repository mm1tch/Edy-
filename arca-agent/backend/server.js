import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aprenderMapeoConGemini } from "./lib/gemini.js";
import { setCorsHeaders } from "./lib/cors.js";
import { guardarPedido, listarPedidos } from "./lib/pedidos.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.join(__dirname, ".env"));

const PORT = Number(process.env.PORT || 3000);

const server = http.createServer(async (req, res) => {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if ((req.method === "GET" || req.method === "HEAD") && (req.url === "/" || req.url === "/dashboard.js" || req.url?.startsWith("/icons/"))) {
      await servirArchivoEstatico(req, res);
      return;
    }

    if (req.method === "GET" && req.url === "/api/health") {
      sendJson(res, 200, {
        ok: true,
        service: "arca-agent-backend",
        runtime: "local",
        geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
      });
      return;
    }

    if (req.url === "/api/pedidos") {
      if (req.method === "GET") {
        sendJson(res, 200, { ok: true, data: listarPedidos() });
        return;
      }

      if (req.method === "POST") {
        const payload = await readJsonBody(req);
        const registro = guardarPedido(payload);
        sendJson(res, 200, { ok: true, data: registro });
        return;
      }

      sendJson(res, 405, { ok: false, error: "Metodo no permitido" });
      return;
    }

    if (req.url === "/api/aprender-mapeo") {
      if (req.method === "GET") {
        sendJson(res, 200, {
          ok: true,
          endpoint: "/api/aprender-mapeo",
          method: "POST",
          message: "Este endpoint se prueba con POST enviando acciones grabadas.",
          example: {
            tipo: "aprender_mapeo",
            acciones: [
              {
                tipo: "input",
                selector: "#cliente",
                valor: "123",
                nombreCampo: "Cliente",
              },
            ],
          },
        });
        return;
      }

      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, error: "Metodo no permitido" });
        return;
      }

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
  console.log(`Dashboard local: http://localhost:${PORT}/`);
  console.log(`Health local: http://localhost:${PORT}/api/health`);
  console.log(`Gemini local: POST http://localhost:${PORT}/api/aprender-mapeo`);
  console.log(`Pedidos local: http://localhost:${PORT}/api/pedidos`);
});

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

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

async function servirArchivoEstatico(req, res) {
  const pathname = req.url === "/" ? "/index.html" : req.url;
  const relativePath = pathname.replace(/^\/+/, "");
  const filePath = path.join(__dirname, "public", relativePath);

  if (!filePath.startsWith(path.join(__dirname, "public"))) {
    sendJson(res, 403, { ok: false, error: "Ruta no permitida" });
    return;
  }

  if (!fs.existsSync(filePath)) {
    sendJson(res, 404, { ok: false, error: "Archivo no encontrado" });
    return;
  }

  const ext = path.extname(filePath);
  const contentType =
    ext === ".html" ? "text/html; charset=utf-8" :
    ext === ".js" ? "text/javascript; charset=utf-8" :
    ext === ".png" ? "image/png" :
    "application/octet-stream";

  res.writeHead(200, { "Content-Type": contentType });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  fs.createReadStream(filePath).pipe(res);
}
