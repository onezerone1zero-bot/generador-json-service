// Prueba REAL (usa la API de Anthropic y cuesta unos centavos): recorre para una lista de temas el MISMO orden que el
// servicio -- 1) el JUEZ a ciegas ("¿se puede crear una herramienta mejor que un graficador?"); si reserva, el
// creador ni se llama; 2) si no, el CREADOR propone análisis y fórmulas -- y muestra el razonamiento de cada paso.
// NO escribe nada en KV ni toca el servicio. Requiere ANTHROPIC_API_KEY en el entorno (nunca se imprime).
//
//   node probar_criterio_visual.mjs                      -> todos los temas
//   node probar_criterio_visual.mjs hidrostatica         -> solo los que contengan ese texto
//   node probar_criterio_visual.mjs --sin-juez           -> salta al juez: solo el creador (como JUEZ_VISUAL=off)
//   MODELO_VISUAL_JUEZ=claude-opus-4-8 node probar_criterio_visual.mjs   -> probar otro modelo de juez
//   MODELO_VISUAL=claude-opus-5-5 node probar_criterio_visual.mjs        -> probar otro creador
// No incluye el revisor matemático (solo corrige fórmulas, no cambia graficar/reservar).
//
// "esperado" es el criterio del dueño del proyecto, no una verdad absoluta: si el modelo difiere en un tema dudoso
// conviene leer su razonamiento antes de decidir quién tiene razón. Se cuentan los DOS errores posibles:
// graficar de más (el que originó este flujo: Hidrostática con a*x, 2*x, 0.5*x) y reservar de más.
import { llamarIA } from "./lib/claude.js";
import { intentarJuzgarVisual } from "./lib/generar.js";
import { armarPromptClaude, armarToolClaude } from "./prompts/prompts.js";
import { validarVisual, validarAnalisisVisual, veredictoDelJuezVisual } from "./lib/validarEstructura.js";

const MODELO_CREADOR = process.env.MODELO_VISUAL || "claude-fable-5-1";
const MODELO_JUEZ = process.env.MODELO_VISUAL_JUEZ || "claude-opus-5-5";

// [materia, tema, esperado]  esperado: "grafica" | "reserva"
const TEMAS = [
  ["Física", "Hidrostática: presión y equilibrio en fluidos en reposo", "reserva"], // el caso que falló
  ["Química", "Estequiometría", "reserva"],
  ["Biología", "Mitosis y meiosis", "reserva"],
  ["Física", "Circuitos de corriente continua (leyes de Kirchhoff)", "reserva"],
  ["Economía", "Oferta y demanda: equilibrio de mercado", "reserva"],
  ["Matemática", "Derivadas: recta tangente y función derivada", "grafica"],
  ["Matemática", "Funciones trigonométricas: seno y coseno", "grafica"],
  ["Estadística", "Distribución normal", "grafica"],
  ["Matemática", "Cónicas: la elipse", "grafica"],
  ["Física", "Tiro oblicuo: trayectoria parabólica", "grafica"],
  ["Matemática", "Números complejos: fórmula de Euler", "grafica"],
];

const filtro = (process.argv.slice(2).find(a => !a.startsWith("--")) || "").toLowerCase();
const sinAcentos = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const lista = TEMAS.filter(([m, t]) => !filtro || sinAcentos(m + " " + t).includes(sinAcentos(filtro)));
if (!process.env.ANTHROPIC_API_KEY) { console.error("Falta ANTHROPIC_API_KEY en el entorno."); process.exit(1); }
if (!lista.length) { console.error("Ningún tema coincide con:", filtro); process.exit(1); }
const sinJuez = process.argv.includes("--sin-juez");

let aciertos = 0, graficoDeMas = 0, reservoDeMas = 0;
for (const [materia, tema, esperado] of lista) {
  console.log("\n==================================================");
  console.log(`${materia} / ${tema}   (esperado: ${esperado})`);
  try {
    let real = null;

    // 1) JUEZ a ciegas (puerta de entrada)
    if (!sinJuez) {
      const d = await intentarJuzgarVisual(materia, tema, "es");
      if (!d) {
        console.log("  JUEZ: sin dictamen (el servicio seguiría con el creador)");
      } else {
        const veredicto = veredictoDelJuezVisual(d);
        console.log(`  JUEZ (${MODELO_JUEZ}): mejora = ${d.mejora.toUpperCase()}  ->  ${veredicto.toUpperCase()}`);
        console.log("    lección esencial:    ", d.leccion_esencial);
        console.log("    mejor herramienta:   ", d.mejor_herramienta_posible);
        console.log("    el graficador muestra:", d.que_alcanza_a_mostrar_un_graficador);
        console.log("    se pierde:           ", d.lo_que_se_pierde);
        console.log("    razón:               ", d.razon);
        if (veredicto === "reservar") { real = "reserva"; console.log("  => RESERVADO por el juez (el creador no se llama)"); }
      }
    }

    // 2) CREADOR (solo si el juez no reservó)
    if (!real) {
      const { system, prompt } = armarPromptClaude("visual", materia, tema, "es");
      const b = await llamarIA({ system, prompt, model: MODELO_CREADOR, maxTokens: 4000, tool: armarToolClaude("visual") });
      const a = b.analisis || {};
      console.log(`  CREADOR (${MODELO_CREADOR}): veredicto = ${a.veredicto}`);
      console.log("    concepto:         ", a.concepto_central);
      console.log("    relación:         ", a.relacion_candidata);
      console.log("    prueba del alumno:", a.prueba_del_alumno);
      if (b.necesitaHerramienta) { real = "reserva"; console.log("  => RESERVA del creador:", b.necesitaHerramienta.motivo); }
      else { real = "grafica"; console.log("  => FÓRMULAS:", (b.formulas || []).map(f => f.formula.replace(/\n/g, " | ")).join("   ;   ")); }
      const v = validarVisual(b), va = validarAnalisisVisual(b);
      if (!v.ok || !va.ok) console.log("  (el servidor rechazaría este borrador y lo reintentaría:", [...(v.errores || []), ...(va.errores || [])].join("; "), ")");
    }

    if (real === esperado) { aciertos++; console.log("  ✔ coincide con lo esperado"); }
    else {
      if (real === "grafica") graficoDeMas++; else reservoDeMas++;
      console.log(`  ✘ DIFIERE (esperado ${esperado}, salió ${real})`);
    }
  } catch (e) {
    console.log("  ERROR:", String(e.message).slice(0, 300));
  }
}
console.log(`\nResultado: ${aciertos}/${lista.length} coinciden con lo esperado.`);
console.log(`  graficó de más (esperaba reservar): ${graficoDeMas}   |   reservó de más (esperaba graficar): ${reservoDeMas}`);
