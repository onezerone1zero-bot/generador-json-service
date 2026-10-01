// Test SIN IA (no llama a ninguna API, no usa claves): comprueba el esquema de la herramienta, el prompt y las reglas
// que hacen cumplir el razonamiento previo ("analisis") del generador visual.
// Correr con:  node test_criterio_visual.mjs
import { validarVisual, validarAnalisisVisual, validarDictamenVisual, veredictoDelJuezVisual, necesitaHerramientaDelJuezVisual, validarRevisionMatematicaVisual } from "./lib/validarEstructura.js";
import { armarToolClaude, armarToolCorreccion, armarPromptClaude, armarToolJuezVisual, armarPromptJuezVisual, armarPromptCorreccionFable } from "./prompts/prompts.js";

let fallos = 0;
const check = (nombre, cond, extra) => {
  console.log((cond ? "OK   " : "FALLA") + " " + nombre + (extra ? "  " + extra : ""));
  if (!cond) fallos++;
};

const analisisOk = (veredicto, extra = {}) => ({
  concepto_central: "La presión de un fluido en reposo crece con la profundidad.",
  relacion_candidata: "P(h) = P0 + rho*g*h: x sería la profundidad h, y la presión P.",
  prueba_del_alumno: "Sin rótulos vería una recta cualquiera, no un fluido ni una presión.",
  veredicto,
  ...extra,
});
const necesita = { tema: "Presión en un fluido en reposo", motivo: "Solo se puede dibujar una recta genérica sin significado.", herramienta_sugerida: "Escena interactiva de un recipiente con un fluido y sondas de presión." };

// ---- esquema de la herramienta ----
const crear = armarToolClaude("visual");
const corregir = armarToolCorreccion("visual");
check("creación: 'analisis' es la PRIMERA propiedad (el modelo razona antes de elegir fórmulas)", Object.keys(crear.input_schema.properties)[0] === "analisis");
check("creación: 'analisis' es obligatorio", JSON.stringify(crear.input_schema.required) === JSON.stringify(["analisis"]));
check("creación: el veredicto solo admite grafica_bien | reservar", JSON.stringify(crear.input_schema.properties.analisis.properties.veredicto.enum) === JSON.stringify(["grafica_bien", "reservar"]));
check("corrección: NO lleva 'analisis' (ya se decidió, solo se revisan fórmulas)", !("analisis" in corregir.input_schema.properties));
check("corrección: lleva 'revision_matematica' PRIMERO y obligatoria (el revisor re-deriva cada fórmula)", Object.keys(corregir.input_schema.properties)[0] === "revision_matematica" && JSON.stringify(corregir.input_schema.required) === JSON.stringify(["revision_matematica"]));
check("corrección: conserva formulas y necesitaHerramienta", "formulas" in corregir.input_schema.properties && "necesitaHerramienta" in corregir.input_schema.properties);
check("el esquema no usa anyOf/oneOf/allOf en la raíz (la API de Anthropic lo rechaza)", !("anyOf" in crear.input_schema) && !("oneOf" in crear.input_schema) && !("allOf" in crear.input_schema));
check("las otras herramientas siguen igual (exam, practice, formula)", armarToolClaude("exam").name === "guardar_banco_preguntas" && armarToolClaude("practice").name === "guardar_banco_preguntas" && armarToolClaude("formula").name === "guardar_formula" && armarToolCorreccion("exam").name === "guardar_banco_preguntas_corregido");

// ---- prompt ----
const { system } = armarPromptClaude("visual", "Física", "Hidrostática: presión y equilibrio en fluidos en reposo", "es");
check("prompt: incluye la 'prueba del alumno'", system.includes("PRUEBA DEL ALUMNO"));
check("prompt: incluye el contraejemplo real (a*x, 2*x, 0.5*x)", system.includes('"a*x", "2*x" y "0.5*x"'));
check("prompt: ya no desalienta reservar ('no es un atajo')", !system.includes("no es un atajo"));
check("prompt: pide razonar primero ('analisis')", system.includes('PRIMERO el campo "analisis"'));
check("prompt: sin variables sin resolver", !system.includes("${"));

// ---- validarAnalisisVisual: casos coherentes ----
check("graficar: veredicto grafica_bien + formulas -> válido", validarAnalisisVisual({ analisis: analisisOk("grafica_bien"), formulas: [{ formula: "x^2" }] }).ok);
check("reservar: veredicto reservar + necesitaHerramienta -> válido", validarAnalisisVisual({ analisis: analisisOk("reservar"), necesitaHerramienta: necesita }).ok);

// ---- incoherencias e incumplimientos (deben rechazarse) ----
const malo = (nombre, data, fragmento) => {
  const r = validarAnalisisVisual(data);
  check("rechaza: " + nombre, !r.ok && r.errores.some(e => e.includes(fragmento)), r.ok ? "(pasó)" : "(" + r.errores[0] + ")");
};
malo("falta el análisis", { formulas: [{ formula: "x^2" }] }, 'falta "analisis"');
malo("análisis que no es objeto", { analisis: "ok", formulas: [{ formula: "x" }] }, 'falta "analisis"');
malo("campo de análisis demasiado corto (relleno)", { analisis: analisisOk("grafica_bien", { prueba_del_alumno: "sí" }), formulas: [{ formula: "x^2" }] }, "prueba_del_alumno");
malo("veredicto inventado", { analisis: analisisOk("quizas"), formulas: [{ formula: "x^2" }] }, "veredicto tiene que ser");
malo("dice reservar pero no manda necesitaHerramienta", { analisis: analisisOk("reservar"), formulas: [{ formula: "a*x" }] }, "falta \"necesitaHerramienta\"");
malo("dice reservar y ADEMÁS manda fórmulas", { analisis: analisisOk("reservar"), necesitaHerramienta: necesita, formulas: [{ formula: "a*x" }] }, "también mandó \"formulas\"");
malo("dice grafica_bien pero manda necesitaHerramienta", { analisis: analisisOk("grafica_bien"), necesitaHerramienta: necesita }, "mandó \"necesitaHerramienta\"");

// ---- las dos validaciones juntas, como las aplica generar.js al borrador ----
const borrador = d => { const a = validarVisual(d), b = validarAnalisisVisual(d); return a.ok && b.ok; };
check("borrador completo para reservar (necesitaHerramienta + análisis coherente) pasa ambas validaciones", borrador({ analisis: analisisOk("reservar"), necesitaHerramienta: necesita }));
check("borrador de gráfica normal (sin(x)) pasa ambas validaciones", borrador({ analisis: analisisOk("grafica_bien"), formulas: [{ formula: "sin(x)*cos(y)" }] }));
check("borrador viejo SIN análisis (como el que daba antes) ahora se rechaza", !borrador({ formulas: [{ formula: "a*x" }, { formula: "2*x" }, { formula: "0.5*x" }] }));

// ---- juez: consulta CIEGA ("¿se puede crear una herramienta mejor que un graficador?") ----
const juez = armarToolJuezVisual();
check("juez: razona EN ORDEN (lección -> mejor herramienta -> qué alcanza el graficador -> qué se pierde -> mejora -> razón)", JSON.stringify(Object.keys(juez.input_schema.properties)) === JSON.stringify(["leccion_esencial", "mejor_herramienta_posible", "que_alcanza_a_mostrar_un_graficador", "lo_que_se_pierde", "mejora", "razon"]));
check("juez: la mejora tiene 4 niveles y NO elige veredicto él mismo", JSON.stringify(juez.input_schema.properties.mejora.enum) === JSON.stringify(["ninguna", "marginal", "sustancial", "enorme"]) && !("veredicto" in juez.input_schema.properties));
const pj = armarPromptJuezVisual("Física", "Hidrostática", "es");
check("juez: es una consulta ciega (el user prompt es SOLO materia y tema)", pj.prompt === "Materia: Física\nTema: Hidrostática");
check("juez: la pregunta es '¿se puede crear una herramienta MEJOR que ese graficador?'", pj.system.includes("¿se puede crear una herramienta MEJOR que ese graficador"));
check("juez: no recibe el criterio ni los campos del creador", !pj.system.includes("PRUEBA DEL ALUMNO") && !pj.system.includes("relacion_candidata") && !pj.system.includes('campo "analisis"') && !pj.system.includes("a*x"));
check("juez: sabe qué hace el graficador (catálogo) para poder comparar", pj.system.includes("Comandos 2D") && pj.system.includes("sin rótulos"));
check("juez: advierte en los dos sentidos (no inventar mejoras / no conformarse)", pj.system.includes("no inventes mejoras") && pj.system.includes("ni te conformes"));
check("juez: los ejemplos de calibración no son el caso Hidrostática", !/\bhidrost/i.test(pj.system.replace("Hidrostática", "")));
check("revisor matemático: su prompt exige re-derivar (REVISIÓN MATEMÁTICA)", armarPromptCorreccionFable("visual", { formulas: [{ formula: "x" }] }, "es").system.includes("REVISIÓN MATEMÁTICA"));

// ---- validarDictamenVisual + derivación del veredicto ----
const dict = (o = {}) => ({ leccion_esencial: "La presión crece con la profundidad.", mejor_herramienta_posible: "Un recipiente con fluido y sondas de presión.", que_alcanza_a_mostrar_un_graficador: "Una recta genérica sin significado.", lo_que_se_pierde: "El fluido y la presión no se ven.", mejora: "enorme", razon: "La lección está en una escena física.", ...o });
check("dictamen: completo -> válido", validarDictamenVisual(dict()).ok);
check("dictamen: campo de relleno -> rechazado", !validarDictamenVisual(dict({ lo_que_se_pierde: "no" })).ok);
check("dictamen: mejora inventada -> rechazada", !validarDictamenVisual(dict({ mejora: "bastante" })).ok);
check("dictamen: falta un campo -> rechazado", !validarDictamenVisual({ ...dict(), razon: undefined }).ok);
check("veredicto: 'enorme' y 'sustancial' reservan", veredictoDelJuezVisual(dict({ mejora: "enorme" })) === "reservar" && veredictoDelJuezVisual(dict({ mejora: "sustancial" })) === "reservar");
check("veredicto: 'marginal' y 'ninguna' aprueban (el graficador alcanza)", veredictoDelJuezVisual(dict({ mejora: "marginal" })) === "aprobar" && veredictoDelJuezVisual(dict({ mejora: "ninguna" })) === "aprobar");
const nh = necesitaHerramientaDelJuezVisual(dict());
check("necesitaHerramienta derivado del dictamen: tema, motivo y herramienta, y es válido para el camino 'sin cobertura'", nh.tema.includes("presión") && nh.motivo.includes("fluido") && nh.herramienta_sugerida.includes("sondas") && validarVisual({ necesitaHerramienta: nh }).ok);
check("necesitaHerramienta derivado: recorta textos largos al máximo permitido (600)", necesitaHerramientaDelJuezVisual(dict({ mejor_herramienta_posible: "a".repeat(2000) })).herramienta_sugerida.length === 600);

// ---- validarRevisionMatematicaVisual ----
const fila = (o = {}) => ({ relacion_prevista: "Densidad normal estándar exp(-x^2/2)/sqrt(2*pi).", comprobacion: "En x=0 da 0.399; en x=1 da 0.242.", resultado: "correcta", ...o });
check("revisión: una fila por fórmula -> válido", validarRevisionMatematicaVisual({ revision_matematica: [fila(), fila()], formulas: [{ formula: "a" }, { formula: "b" }] }).ok);
check("revisión: falta -> rechazado", !validarRevisionMatematicaVisual({ formulas: [{ formula: "a" }] }).ok);
check("revisión: distinta cantidad de filas que de fórmulas -> rechazado", !validarRevisionMatematicaVisual({ revision_matematica: [fila()], formulas: [{ formula: "a" }, { formula: "b" }] }).ok);
check("revisión: comprobación de relleno -> rechazado", !validarRevisionMatematicaVisual({ revision_matematica: [fila({ comprobacion: "ok" })], formulas: [{ formula: "a" }] }).ok);
check("revisión: resultado inventado -> rechazado", !validarRevisionMatematicaVisual({ revision_matematica: [fila({ resultado: "mas o menos" })], formulas: [{ formula: "a" }] }).ok);

console.log(fallos === 0 ? "\nTodo bien." : `\n${fallos} comprobación(es) fallaron.`);
process.exit(fallos === 0 ? 0 : 1);
