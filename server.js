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

/**
 * POST /generar-json
 * Body: { materia, tema, tipos? }
 *   tipos (opcional): subset de ["practice", "exam", "formula"].
 *   Default: ["practice", "exam", "formula"].
 *
 * Llamado por generador-service-main después de generar el contenido
 * teórico de un tema (mismo tema, mismo slug). Para cada tipo pedido
 * corre Claude/Fable (crea) + un corrector -- Mistral para
 * practice/formula, Fable con Mistral de fallback para exam, ver
 * lib/generar.js -- y guarda cada resultado en KV (namespaces
 * separados por tipo, keys "practice:<slug>" / "exam:<slug>" /
 * "formulas:<slug>").
 *
 * Es síncrono (como /generar en el otro service): espera el resultado y
 * lo devuelve en la misma response. Si en el futuro esto tarda demasiado
 * (varios tipos x 2 llamadas de IA c/u), se puede pasar a un patrón de
 * cola + callback como /crear-tema-callback del otro service -- por ahora,
 * con 2-3 tipos, un request síncrono alcanza.
 */
app.post("/generar-json", async (req, res) => {
  if (!chequearAuth(req, res)) return;

  const { materia, tema, tipos } = req.body || {};
  if (!materia || !tema) {
    return res.status(400).json({ error: "Faltan materia o tema" });
  }

  const tiposValidos = ["practice", "exam", "formula"];
  const tiposPedidos = Array.isArray(tipos) && tipos.length > 0 ? tipos : ["practice", "exam", "formula"];
  const tiposInvalidos = tiposPedidos.filter((t) => !tiposValidos.includes(t));
  if (tiposInvalidos.length > 0) {
    return res.status(400).json({ error: `tipos inválidos: ${tiposInvalidos.join(", ")}. Válidos: ${tiposValidos.join(", ")}` });
  }

  try {
    const resultado = await generarYGuardarJSON({ materia, tema, tipos: tiposPedidos });
    // Si algún tipo falló pero otros salieron bien, devolvemos 207-like
    // (200 con ok:false y detalle) en vez de 500 -- así generador-service-main
    // puede decidir qué hacer con el resultado parcial en vez de perderlo todo.
    res.json(resultado);
  } catch (err) {
    console.error("[generar-json] error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`generador-json-service escuchando en :${port}`));
