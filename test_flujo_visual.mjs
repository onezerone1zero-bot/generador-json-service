// Test de PUNTA A PUNTA del generador visual SIN IA y SIN claves: simula la API de Anthropic (juez -> creador ->
// revisor matemático) y Cloudflare KV en memoria, y comprueba qué se guarda en cada caso y qué modelo hizo cada paso.
//   node test_flujo_visual.mjs                    -> escenarios A..G (juez encendido)
//   JUEZ_VISUAL=off node test_flujo_visual.mjs    -> escenario F (juez apagado)
// No toca ningún servicio real: todo fetch() sale a un simulador.

process.env.ANTHROPIC_API_KEY = "clave-falsa-de-prueba";
process.env.CLOUDFLARE_ACCOUNT_ID = "cuenta";
process.env.CLOUDFLARE_API_TOKEN = "token";
for (const n of ["PRACTICE", "EXAM", "FORMULA", "VISUAL", "VISUAL_LATER"]) process.env["CLOUDFLARE_NAMESPACE_ID_" + n] = "ns_" + n.toLowerCase();
process.env.SUPABASE_URL = "https://supabase.falso";
process.env.SUPABASE_SERVICE_ROLE_KEY = "x";
delete process.env.MODELO_VISUAL; delete process.env.MODELO_VISUAL_JUEZ; delete process.env.MODELO_VISUAL_MATEMATICAS;

const juezApagado = (process.env.JUEZ_VISUAL || "").toLowerCase() === "off";
let fallos = 0;
const check = (nombre, cond, extra) => { console.log((cond ? "OK   " : "FALLA") + " " + nombre + (extra ? "  " + extra : "")); if (!cond) fallos++; };

// ---------- simulador de fetch ----------
const kv = new Map();           // "namespace/key" -> texto
let llamadas = [];              // { tool, model, prompt }
let guion = {};                 // tool -> input (objeto) | "ERROR"
const respuestaIA = (nombreTool, input) => new Response(JSON.stringify({
  content: [{ type: "tool_use", id: "t1", name: nombreTool, input }], stop_reason: "tool_use", usage: { input_tokens: 100, output_tokens: 50 },
}), { status: 200, headers: { "content-type": "application/json" } });

globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.startsWith("https://api.anthropic.com/")) {
    const body = JSON.parse(init.body);
    const tool = body.tools?.[0]?.name;
    llamadas.push({ tool, model: body.model, system: body.system, prompt: body.messages?.[0]?.content });
    const g = guion[tool];
    if (g === undefined) return new Response("sin guion para " + tool, { status: 500 });
    if (g === "ERROR") return new Response("overloaded", { status: 529 });
    return respuestaIA(tool, g);
  }
  if (url.startsWith("https://api.cloudflare.com/")) {
    const m = url.match(/namespaces\/([^/]+)\/values\/([^?]+)/);
    const id = m[1] + "/" + decodeURIComponent(m[2]);
    if (!init.method || init.method === "GET") return kv.has(id) ? new Response(kv.get(id), { status: 200 }) : new Response("no", { status: 404 });
    if (init.method === "PUT") { kv.set(id, init.body); return new Response("{}", { status: 200 }); }
    if (init.method === "DELETE") { kv.delete(id); return new Response("{}", { status: 200 }); }
  }
  if (url.includes("mistral.ai")) return new Response("sin Mistral en el test", { status: 500 });
  return new Response("{}", { status: 200 });   // Supabase y cualquier otra cosa: best-effort
};

const { generarYGuardarJSON } = await import("./lib/generar.js");

// ---------- datos de los escenarios ----------
const analisis = (veredicto) => ({
  concepto_central: "Concepto central del tema de prueba, en una frase.",
  relacion_candidata: "Relación candidata de prueba con el significado de los ejes.",
  prueba_del_alumno: "Qué entendería el alumno viendo solo la gráfica, de prueba.",
  veredicto,
});
const necesita = { tema: "Escena de un recipiente con fluido y sondas de presión", motivo: "Una recta genérica no enseña presión ni profundidad.", herramienta_sugerida: "Escena interactiva de un recipiente con un fluido." };
// Dictamen del juez ciego (mejora: ninguna | marginal | sustancial | enorme)
const dictamen = (mejora, extra = {}) => ({
  leccion_esencial: "La presión de un fluido en reposo crece con la profundidad.",
  mejor_herramienta_posible: "Un recipiente con fluido y sondas de presión que el alumno mueve a distintas profundidades.",
  que_alcanza_a_mostrar_un_graficador: "Solo una recta genérica a la que el alumno no puede dar significado.",
  lo_que_se_pierde: "El fluido, la profundidad y la presión: lo esencial no se ve en curvas sin rótulos.",
  mejora,
  razon: "La lección está en una escena física, no en una función.",
  ...extra,
});
const revision = (n, resultado = "correcta") => Array.from({ length: n }, () => ({ relacion_prevista: "Relación prevista de la fórmula de prueba.", comprobacion: "En x=1 da el valor esperado, comprobado a mano.", resultado }));

async function correr(materia, tema) { llamadas = []; kv.clear(); return generarYGuardarJSON({ materia, tema, tipos: ["visual"], idioma: "es" }); }
const leer = (ns, parteKey) => { for (const [k, v] of kv) if (k.startsWith("ns_" + ns + "/") && (!parteKey || k.includes(parteKey))) return JSON.parse(v); return null; };
const modelos = () => llamadas.map(l => l.tool.replace("guardar_formulas_visual", "creador").replace("_corregidas", "+matematica").replace("dictaminar_visual", "juez") + ":" + l.model).join(" -> ");

if (!juezApagado) {
  // A) El caso real (Hidrostática): el juez, a ciegas, ve una mejora ENORME -> se reserva y el creador ni se llama.
  guion = { dictaminar_visual: dictamen("enorme") };
  let r = await correr("Física", "Hidrostática: presión y equilibrio en fluidos en reposo");
  check("A) Hidrostática: queda 'sin cobertura'", r.ok && r.resultados[0].sinCobertura === true, JSON.stringify(r.errores));
  check("A) el creador (Fable, el paso caro) NO se llama: solo el juez (Opus 5.5)", modelos() === "juez:claude-opus-5-5", modelos());
  check("A) el visual NO guarda rectas: guarda una marca _sinCobertura", leer("visual")?._sinCobertura === true && !leer("visual")?.formulas);
  const later = leer("visual_later");
  check("A) visual_later: decidido por el juez, con su dictamen y la herramienta que propone", later?.decidido_por === "juez" && later?.analisis?.juez?.mejora === "enorme" && later?.herramienta_sugerida.includes("sondas de presión") && later?.tema_deseado.includes("presión"), JSON.stringify(later?.analisis?.juez?.mejora));
  const j = llamadas[0];
  check("A) el juez es CIEGO: recibe solo materia y tema (ni fórmulas ni razonamiento ni criterio del creador)", j.prompt === "Materia: Física\nTema: Hidrostática: presión y equilibrio en fluidos en reposo" && !/analisis|formula|PRUEBA DEL ALUMNO|relacion_candidata/.test(j.system));

  // A2) Mejora "sustancial" también reserva.
  guion = { dictaminar_visual: dictamen("sustancial") };
  r = await correr("Química", "Estequiometría");
  check("A2) mejora 'sustancial' también reserva (sin llamar al creador)", r.ok && r.resultados[0].sinCobertura === true && modelos() === "juez:claude-opus-5-5", modelos());

  // A3) Mejora "marginal": el graficador alcanza -> sigue el creador.
  guion = {
    dictaminar_visual: dictamen("marginal", { lo_que_se_pierde: "Nada esencial: solo comodidad extra de uso del graficador." }),
    guardar_formulas_visual: { analisis: analisis("grafica_bien"), formulas: [{ formula: "sin(x)" }] },
    guardar_formulas_visual_corregidas: { revision_matematica: revision(1), formulas: [{ formula: "sin(x)" }] },
  };
  r = await correr("Matemática", "Funciones trigonométricas: seno y coseno");
  check("A3) mejora 'marginal': no reserva, sigue el creador y el revisor", r.ok && leer("visual")?.formulas?.[0]?.formula === "sin(x)" && modelos().startsWith("juez:claude-opus-5-5 -> creador:claude-fable-5-1"), modelos());

  // B) Tema que sí se grafica: el juez no ve mejora, crea el creador y corrige el revisor matemático.
  guion = {
    dictaminar_visual: dictamen("ninguna", { lo_que_se_pierde: "Nada esencial: el graficador ya muestra la función y su derivada." }),
    guardar_formulas_visual: { analisis: analisis("grafica_bien"), formulas: [{ formula: "x^2" }, { formula: "2*x" }] },
    guardar_formulas_visual_corregidas: { revision_matematica: revision(2), formulas: [{ formula: "x^2" }, { formula: "2*x" }] },
  };
  r = await correr("Matemática", "Derivadas: recta tangente y función derivada");
  const guardado = leer("visual");
  check("B) Derivadas: se guarda un visual.json normal", r.ok && r.resultados[0].generado === true && Array.isArray(guardado?.formulas) && guardado.formulas.length === 2, JSON.stringify(r.errores));
  check("B) el visual.json guardado NO trae análisis ni revisión (no ensucia al frontend)", guardado && JSON.stringify(Object.keys(guardado)) === JSON.stringify(["formulas"]), JSON.stringify(Object.keys(guardado || {})));
  check("B) modelos: juez Opus 5.5 -> creador Fable 5.1 -> matemáticas Opus 4.8", modelos() === "juez:claude-opus-5-5 -> creador:claude-fable-5-1 -> creador+matematica:claude-opus-4-8", modelos());
  check("B) no se escribió visual_later (no hubo reserva)", leer("visual_later") === null);

  // B2) El revisor matemático corrige una fórmula: se guarda la corregida.
  guion.guardar_formulas_visual_corregidas = { revision_matematica: revision(1, "corregida"), formulas: [{ formula: "exp(-x^2/2)/sqrt(2*pi)" }] };
  guion.guardar_formulas_visual = { analisis: analisis("grafica_bien"), formulas: [{ formula: "exp(-x^2/2)" }] };
  r = await correr("Estadística", "Distribución normal");
  check("B2) el revisor matemático corrige y se guarda su versión", leer("visual")?.formulas?.[0]?.formula === "exp(-x^2/2)/sqrt(2*pi)", JSON.stringify(leer("visual")));

  // C) El creador reserva por su cuenta (el juez no vio mejora): queda registrado como decidido por el creador.
  guion = { dictaminar_visual: dictamen("ninguna"), guardar_formulas_visual: { analisis: analisis("reservar"), necesitaHerramienta: necesita } };
  r = await correr("Biología", "Tema que el creador reserva");
  check("C) reserva del creador: no pasa por el revisor", r.ok && r.resultados[0].sinCobertura === true && modelos() === "juez:claude-opus-5-5 -> creador:claude-fable-5-1", modelos());
  check("C) visual_later: decidido por el creador, con su análisis y el dictamen del juez", leer("visual_later")?.decidido_por === "creador" && !!leer("visual_later")?.analisis?.creador && leer("visual_later")?.analisis?.juez?.mejora === "ninguna");

  // D) El juez no responde (error de la API): se sigue con el creador (fail-open) y se revisa la matemática.
  guion = {
    dictaminar_visual: "ERROR",
    guardar_formulas_visual: { analisis: analisis("grafica_bien"), formulas: [{ formula: "sin(x)" }] },
    guardar_formulas_visual_corregidas: { revision_matematica: revision(1), formulas: [{ formula: "sin(x)" }] },
  };
  r = await correr("Matemática", "Funciones trigonométricas");
  check("D) si el juez falla, no se pierde el job: sigue el creador y se guarda", r.ok && leer("visual")?.formulas?.[0]?.formula === "sin(x)", JSON.stringify(r.errores));

  // D2) El juez devuelve algo que no valida (razonamiento de relleno): 2 intentos y se sigue con el creador.
  guion = {
    dictaminar_visual: dictamen("enorme", { lo_que_se_pierde: "x" }),
    guardar_formulas_visual: { analisis: analisis("grafica_bien"), formulas: [{ formula: "sin(x)" }] },
    guardar_formulas_visual_corregidas: { revision_matematica: revision(1), formulas: [{ formula: "sin(x)" }] },
  };
  r = await correr("Matemática", "Tema con juez de relleno");
  check("D2) dictamen de relleno: se descarta (2 intentos) y el flujo sigue sin reservar por error", r.ok && llamadas.filter(l => l.tool === "dictaminar_visual").length === 2 && !!leer("visual")?.formulas, modelos());

  // E) El revisor matemático no completa la revisión: esa corrección se descarta y queda el borrador.
  guion = {
    dictaminar_visual: dictamen("ninguna"),
    guardar_formulas_visual: { analisis: analisis("grafica_bien"), formulas: [{ formula: "x^2" }] },
    guardar_formulas_visual_corregidas: { formulas: [{ formula: "x^3" }] },   // sin revision_matematica
  };
  r = await correr("Matemática", "Parábolas");
  check("E) sin 'revision_matematica' la corrección NO se acepta: queda el borrador (x^2), no x^3", r.ok && leer("visual")?.formulas?.[0]?.formula === "x^2", JSON.stringify(leer("visual")));

  // G) Incoherencia del creador: dice "reservar" pero manda fórmulas -> reintenta (hasta 3) y falla limpio.
  guion = { dictaminar_visual: dictamen("ninguna"), guardar_formulas_visual: { analisis: analisis("reservar"), formulas: [{ formula: "x^2" }] } };
  r = await correr("Física", "Tema incoherente");
  check("G) borrador incoherente (reservar + fórmulas): 3 intentos del creador y error claro, sin guardar nada", !r.ok && llamadas.filter(l => l.tool === "guardar_formulas_visual").length === 3 && leer("visual") === null, modelos());
} else {
  // F) Con JUEZ_VISUAL=off el flujo vuelve al de antes: creador -> revisor matemático, sin juez.
  guion = {
    dictaminar_visual: dictamen("enorme"),
    guardar_formulas_visual: { analisis: analisis("grafica_bien"), formulas: [{ formula: "a*x" }, { formula: "2*x" }] },
    guardar_formulas_visual_corregidas: { revision_matematica: revision(2), formulas: [{ formula: "a*x" }, { formula: "2*x" }] },
  };
  const r = await correr("Física", "Hidrostática");
  check("F) JUEZ_VISUAL=off: no se llama al juez (flujo anterior)", r.ok && !modelos().includes("juez") && leer("visual")?.formulas?.length === 2, modelos());
}

console.log(fallos === 0 ? "\nTodo bien." : `\n${fallos} comprobación(es) fallaron.`);
process.exit(fallos === 0 ? 0 : 1);
