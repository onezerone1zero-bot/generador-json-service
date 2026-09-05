import express from "express";
import { generarYGuardarJSON } from "./lib/generar.js";
import { validarEnv } from "./lib/validarEnv.js";

validarEnv();

const app = express();
app.use(express.json({ limit: "2mb" }));

function chequearAuth(req, res) {
  const auth = req.headers.authorization || "";
  const token = auth.replace("Bearer ", "");
  if (token !== process.env.SERVICE_KEY) {
    res.status(401).json({ error: "No autorizado" });
    return false;
  }
  return true;
}

app.post("/generar-json", async (req, res) => {
  if (!chequearAuth(req, res)) return;

  const { materia, tema, tipos, temaCanonico } = req.body || {};
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
    const resultado = await generarYGuardarJSON({ materia, tema, tipos: tiposPedidos, temaCanonico });
    res.json(resultado);
  } catch (err) {
    console.error("[generar-json] error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`generador-json-service escuchando en :${port}`));
