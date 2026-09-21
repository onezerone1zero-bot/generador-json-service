import express from "express";
import { generarYGuardarJSON } from "./lib/generar.js";
import { validarEnv } from "./lib/validarEnv.js";

// Validar variables de entorno antes de hacer cualquier cosa
validarEnv();

const app = express();
app.use(express.json({ limit: "2mb" }));

// Auth simple entre generador-service-main (quien dispara esto) y este
// servicio -- mismo esquema que generador-service-main/src/server.js.
// SERVICE_KEY acá es una clave DISTINTA a la del otro service (ver
// .env.example): si alguna se filtra, la otra sigue segura.
function chequearAuth(req, res) {
  const auth = req.headers.authorization || "";
  const token = auth.replace("Bearer ", "");
  if (token !== process.env.SERVICE_KEY) {
    res.status(401).json({ error: "No autorizado" });
    return false;
  }
  return true;
}

const TIPOS_VALIDOS = ["practice", "exam", "formula", "visual"];

// Lo que genera POST /generar-json cuando NO se manda `tipos`. Es lo que
// dispara generador-service-main después de la teoría: solo la fórmula.
// practice / exam / visual se piden por separado (ver más abajo) para que
// un llamado no arrastre a los demás en cadena.
const TIPOS_DEFAULT = ["formula"];

/**
 * Corre el pipeline para una lista de tipos y responde. Compartido por
 * POST /generar-json y por los endpoints de un solo tipo.
 */
async function responderGeneracion(req, res, tiposPedidos) {
  const { materia, tema, temaCanonico, idioma } = req.body || {};
  if (!materia || !tema) {
    return res.status(400).json({ error: "Faltan materia o tema" });
  }

  try {
    const resultado = await generarYGuardarJSON({
      materia,
      tema,
      tipos: tiposPedidos,
      temaCanonico,
      idioma: (idioma || "es").trim(),
    });
    // Si algún tipo falló pero otros salieron bien, devolvemos 200 con
    // ok:false y detalle en vez de 500 -- así el llamador puede decidir
    // qué hacer con el resultado parcial en vez de perderlo todo.
    res.json(resultado);
  } catch (err) {
    console.error("[generar-json] error:", err);
    res.status(500).json({ error: err.message });
  }
}

/**
 * POST /generar-json
 * Body: { materia, tema, tipos?, temaCanonico?, idioma? }
 *   tipos (opcional): subset de ["practice", "exam", "formula", "visual"].
 *   Default (si no se manda `tipos`): ["formula"] -- un solo KV por
 *   llamado. Este es el camino que usa generador-service-main.
 *   Si se manda `tipos` explícito, se respeta tal cual (ej. ["practice"]),
 *   así que el contrato con el otro generador no cambia.
 *   temaCanonico (opcional): título del tema en el índice canónico
 *     (español), si el llamador ya lo resolvió contra ese índice. Ver
 *     nota en lib/generar.js (generarYGuardarJSON).
 *   idioma (opcional, default "es"): idioma destino del contenido. Lo
 *     manda generador-service-main en cada request.
 *
 * Es síncrono: espera el resultado y lo devuelve en la misma response.
 */
app.post("/generar-json", async (req, res) => {
  if (!chequearAuth(req, res)) return;

  const { tipos } = req.body || {};
  const tiposPedidos = Array.isArray(tipos) && tipos.length > 0 ? tipos : TIPOS_DEFAULT;

  const tiposInvalidos = tiposPedidos.filter((t) => !TIPOS_VALIDOS.includes(t));
  if (tiposInvalidos.length > 0) {
    return res.status(400).json({ error: `tipos inválidos: ${tiposInvalidos.join(", ")}. Válidos: ${TIPOS_VALIDOS.join(", ")}` });
  }

  await responderGeneracion(req, res, tiposPedidos);
});

/**
 * Endpoints separados, uno por tipo: cada uno genera SOLO su KV.
 *   POST /generar-json/practice
 *   POST /generar-json/exam
 *   POST /generar-json/formula
 *   POST /generar-json/visual
 * Body: { materia, tema, temaCanonico?, idioma? } (sin `tipos`, no aplica).
 * Así practice y exam ya no salen en cadena con la fórmula: se disparan
 * cuando quieras, cada uno con su propio llamado.
 */
for (const tipo of TIPOS_VALIDOS) {
  app.post(`/generar-json/${tipo}`, async (req, res) => {
    if (!chequearAuth(req, res)) return;
    await responderGeneracion(req, res, [tipo]);
  });
}

app.get("/health", (_req, res) => res.json({ ok: true }));

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`generador-json-service escuchando en :${port}`));
