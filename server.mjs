import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 4173);
const DATA_DIR = path.join(__dirname, "data");
const LEADS_FILE = path.join(DATA_DIR, "leads.ndjson");
const EMAIL_TEMPLATE_FILE = path.join(__dirname, "email-confirmacion.html");
const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || "https://solicitud-demo-01.automatizahoy.ai";

const ELASTIC_EMAIL_API_KEY = process.env.ELASTIC_EMAIL_API_KEY || "";
const ELASTIC_EMAIL_FROM = process.env.ELASTIC_EMAIL_FROM || "";
const ELASTIC_EMAIL_TO = process.env.ELASTIC_EMAIL_TO || "";
const ELASTIC_EMAIL_FROM_NAME =
  process.env.ELASTIC_EMAIL_FROM_NAME || "H-OperIA Inmobiliaria";
const ELASTIC_EMAIL_ENDPOINT =
  "https://api.elasticemail.com/v4/emails/transactional";

fs.mkdirSync(DATA_DIR, { recursive: true });

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon"
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });

  res.end(JSON.stringify(payload));
}

function clean(value, maxLength = 2000) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function validateLead(body) {
  const lead = {
    nombre: clean(body.nombre, 150),
    cargo: clean(body.cargo, 150),
    empresa: clean(body.empresa, 200),
    email: clean(body.email, 254).toLowerCase(),
    whatsapp: clean(body.whatsapp, 80),
    telefono: clean(body.telefono, 80),
    proyectos: clean(body.proyectos, 4000),
    web: clean(body.web, 4000),
    necesidad: clean(body.necesidad, 5000),
    origen: clean(body.origen, 150) || "landing-directa",
    canal_contacto: "correo"
  };

  const errores = [];

  if (!lead.nombre) errores.push("Nombre del contacto");
  if (!lead.empresa) errores.push("Empresa");
  if (!lead.email || !isValidEmail(lead.email)) errores.push("Correo electrónico válido");
  if (!lead.whatsapp) errores.push("WhatsApp");
  if (!lead.proyectos) errores.push("Nombre del proyecto o proyectos");

  return { lead, errores };
}

async function readJsonBody(req) {
  return await new Promise((resolve, reject) => {
    let body = "";
    let received = 0;
    const MAX_BYTES = 64 * 1024;

    req.on("data", chunk => {
      received += chunk.length;

      if (received > MAX_BYTES) {
        reject(new Error("PAYLOAD_TOO_LARGE"));
        req.destroy();
        return;
      }

      body += chunk;
    });

    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("INVALID_JSON"));
      }
    });

    req.on("error", reject);
  });
}

function saveLead(lead, req) {
  const record = {
    id: `HOP-LEAD-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    recibidoEn: new Date().toISOString(),
    ip:
      clean(req.headers["x-forwarded-for"] || "", 200)
        .split(",")[0]
        .trim() ||
      req.socket.remoteAddress ||
      "",
    userAgent: clean(req.headers["user-agent"] || "", 500),
    ...lead
  };

  fs.appendFileSync(
    LEADS_FILE,
    JSON.stringify(record) + "\n",
    { encoding: "utf8", mode: 0o600 }
  );

  return record;
}

function valueOrDash(value) {
  return value || "-";
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function buildProspectHtml(record) {
  let html = fs.readFileSync(EMAIL_TEMPLATE_FILE, "utf8");

  html = html
    .replaceAll("{{NOMBRE}}", escapeHtml(record.nombre))
    .replaceAll("{{LEAD_ID}}", escapeHtml(record.id))
    .replaceAll(
      'src="email-assets/',
      `src="${PUBLIC_BASE_URL}/email-assets/`
    );

  return html;
}

async function notifyLeadByEmail(record) {
  if (!ELASTIC_EMAIL_API_KEY || !ELASTIC_EMAIL_FROM || !ELASTIC_EMAIL_TO) {
    console.warn(
      `[EMAIL] Configuracion incompleta; ${record.id} quedo guardado sin notificacion.`
    );
    return;
  }

  const content = [
    "Nueva solicitud de demostracion de H-OperIA Inmobiliaria",
    "",
    `ID: ${record.id}`,
    `Recibida: ${record.recibidoEn}`,
    `Nombre: ${record.nombre}`,
    `Cargo: ${valueOrDash(record.cargo)}`,
    `Empresa: ${record.empresa}`,
    `Correo: ${record.email}`,
    `WhatsApp: ${record.whatsapp}`,
    `Telefono: ${valueOrDash(record.telefono)}`,
    `Proyecto(s): ${record.proyectos}`,
    `Web: ${valueOrDash(record.web)}`,
    `Que desea gestionar mejor: ${valueOrDash(record.necesidad)}`,
    `Origen: ${record.origen}`
  ].join("\n");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(ELASTIC_EMAIL_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-ElasticEmail-ApiKey": ELASTIC_EMAIL_API_KEY
      },
      body: JSON.stringify({
        Recipients: {
          To: [ELASTIC_EMAIL_TO]
        },
        Content: {
          Body: [
            {
              ContentType: "PlainText",
              Content: content,
              Charset: "utf-8"
            }
          ],
          From: `${ELASTIC_EMAIL_FROM_NAME} <${ELASTIC_EMAIL_FROM}>`,
          ReplyTo: record.email,
          Subject: `Nueva solicitud de demostracion - ${record.empresa}`
        },
        Options: {
          ChannelName: "H-OperIA Solicitud Demo"
        }
      }),
      signal: controller.signal
    });

    const responseText = await response.text();

    if (!response.ok) {
      throw new Error(
        `Elastic Email ${response.status}: ${responseText.slice(0, 500)}`
      );
    }

    console.log(`[EMAIL] Notificacion enviada | ${record.id}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function confirmLeadByEmail(record) {
  if (!ELASTIC_EMAIL_API_KEY || !ELASTIC_EMAIL_FROM) {
    console.warn(
      `[EMAIL] Configuracion incompleta; ${record.id} quedo guardado sin confirmacion al prospecto.`
    );
    return;
  }

  const plainText = [
    `Hola, ${record.nombre}:`,
    "",
    "Gracias por su interés en H-OperIA Inmobiliaria.",
    "",
    "Hemos recibido correctamente su solicitud de demostración y la información básica sobre su empresa y proyecto.",
    "",
    "Revisaremos el contexto que nos ha compartido para preparar una demostración enfocada en sus necesidades.",
    "",
    `Referencia de su solicitud: ${record.id}`,
    "",
    "Si desea agregar alguna información antes de la demostración, puede responder directamente a este correo.",
    "",
    "Miguel Ángel Rivas",
    "Director · Automatiza Hoy IA",
    "Tel. / WhatsApp: +503 7576-2213",
    "marivas@automatizahoy.ai"
  ].join("\n");

  const htmlContent = buildProspectHtml(record);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(ELASTIC_EMAIL_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-ElasticEmail-ApiKey": ELASTIC_EMAIL_API_KEY
      },
      body: JSON.stringify({
        Recipients: {
          To: [record.email]
        },
        Content: {
          Body: [
            {
              ContentType: "HTML",
              Content: htmlContent,
              Charset: "utf-8"
            },
            {
              ContentType: "PlainText",
              Content: plainText,
              Charset: "utf-8"
            }
          ],
          From: `${ELASTIC_EMAIL_FROM_NAME} <${ELASTIC_EMAIL_FROM}>`,
          ReplyTo: ELASTIC_EMAIL_TO || ELASTIC_EMAIL_FROM,
          Subject: "Hemos recibido su solicitud de demostración | H-OperIA Inmobiliaria"
        },
        Options: {
          ChannelName: "H-OperIA Solicitud Demo"
        }
      }),
      signal: controller.signal
    });

    const responseText = await response.text();

    if (!response.ok) {
      throw new Error(
        `Elastic Email ${response.status}: ${responseText.slice(0, 500)}`
      );
    }

    console.log(`[EMAIL] Confirmacion enviada al prospecto | ${record.id}`);
  } finally {
    clearTimeout(timeout);
  }
}

function serveStatic(req, res) {
  let pathname;

  try {
    pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  } catch {
    res.writeHead(400);
    res.end("Solicitud inválida");
    return;
  }

  if (pathname === "/") pathname = "/index.html";

  const requestedPath = path.resolve(
    __dirname,
    "." + pathname
  );

  if (!requestedPath.startsWith(__dirname)) {
    res.writeHead(403);
    res.end("Acceso denegado");
    return;
  }

  if (
    requestedPath.includes(path.sep + "data" + path.sep) ||
    requestedPath.endsWith(path.sep + "data")
  ) {
    res.writeHead(404);
    res.end("No encontrado");
    return;
  }

  fs.stat(requestedPath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, {
        "Content-Type": "text/plain; charset=utf-8"
      });
      res.end("No encontrado");
      return;
    }

    const ext = path.extname(requestedPath).toLowerCase();

    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff"
    });

    fs.createReadStream(requestedPath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      servicio: "HOPERIA_Solicitud_Demo_PWA"
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/leads") {
    try {
      const body = await readJsonBody(req);
      const { lead, errores } = validateLead(body);

      if (errores.length) {
        sendJson(res, 400, {
          ok: false,
          error: "Faltan datos requeridos.",
          campos: errores
        });
        return;
      }

      const record = saveLead(lead, req);

      console.log(
        `[LEAD] ${record.recibidoEn} | ${record.id} | ${record.empresa} | ${record.email}`
      );

      const emailResults = await Promise.allSettled([
        notifyLeadByEmail(record),
        confirmLeadByEmail(record)
      ]);

      if (emailResults[0].status === "rejected") {
        console.error(
          `[EMAIL] No fue posible notificar internamente ${record.id}:`,
          emailResults[0].reason?.message || emailResults[0].reason
        );
      }

      if (emailResults[1].status === "rejected") {
        console.error(
          `[EMAIL] No fue posible confirmar al prospecto ${record.id}:`,
          emailResults[1].reason?.message || emailResults[1].reason
        );
      }

      sendJson(res, 201, {
        ok: true,
        id: record.id
      });

    } catch (error) {
      if (error.message === "PAYLOAD_TOO_LARGE") {
        sendJson(res, 413, {
          ok: false,
          error: "Solicitud demasiado grande."
        });
        return;
      }

      if (error.message === "INVALID_JSON") {
        sendJson(res, 400, {
          ok: false,
          error: "Formato de solicitud inválido."
        });
        return;
      }

      console.error(error);

      sendJson(res, 500, {
        ok: false,
        error: "No fue posible registrar la solicitud."
      });
    }

    return;
  }

  if (req.method === "GET") {
    serveStatic(req, res);
    return;
  }

  res.writeHead(405, {
    "Content-Type": "text/plain; charset=utf-8",
    "Allow": "GET, POST"
  });

  res.end("Método no permitido");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("");
  console.log("=== H-OPERIA SOLICITUD DEMO ===");
  console.log(`Servidor: http://localhost:${PORT}`);
  console.log(`Health:   http://localhost:${PORT}/api/health`);
  console.log(`Leads:    ${LEADS_FILE}`);
  console.log("");
});
