// ASUNCIÓN A CONFIRMAR: no tenemos el contenido real de practice.js/exam.js
// del frontend en este chat, así que este es el schema de "pregunta" que
// asumimos (multiple choice con 4 opciones). Si el frontend espera otra
// forma, se cambia ACÁ nomás -- es el único lugar donde hay que tocar algo,
// tanto para el schema como para el texto de los prompts.
export const PREGUNTA_SCHEMA_EJEMPLO = {
  enunciado: "string, puede incluir LaTeX entre $...$",
  opciones: ["string", "string", "string", "string"],
  respuesta_correcta: "índice (0-3) de la opción correcta",
  explicacion: "string, por qué esa es la respuesta correcta",
};

const INSTRUCCIONES_POR_TIPO = {
  practice:
    "Generá preguntas de PRÁCTICA: pensadas para que el alumno aprenda mientras resuelve, con explicaciones claras y pedagógicas en cada una.",
  exam:
    "Generá preguntas de EXAMEN: mismo nivel de dificultad que practice pero enunciados más secos/formales, como en un parcial real, sin pistas en el enunciado.",
  formula:
    "Generá las fórmulas clave del tema (las que se muestran en el título/encabezado del tema), en LaTeX, con una etiqueta corta de qué es cada una.",
};

// Cantidad de preguntas por modelo, según tipo. exam.js (frontend) arma
// 3 modelos free de 12 preguntas cada uno para el examen (antes 10) --
// practice se mantiene en 10, que es lo que ya venía funcionando.
const PREGUNTAS_POR_MODELO = {
  practice: 10,
  exam: 12,
};

/**
 * Tool schema para forzar a Claude a devolver JSON válido por
 * construcción (tool use), en vez de texto libre que hay que parsear
 * después con extraerJson(). Con tool_choice forzado, la API de
 * Anthropic valida la respuesta contra este schema del lado del
 * servidor antes de devolverla -- elimina la clase entera de errores
 * de "JSON mal formado" (comillas faltantes, comas colgantes, etc.)
 * que puede meter un modelo escribiendo texto suelto.
 */
export function armarToolClaude(tipo) {
  if (tipo === "formula") {
    return {
      name: "guardar_formula",
      description: "Guarda la fórmula principal del tema.",
      input_schema: {
        type: "object",
        properties: {
          formula: { type: "string", description: "Fórmula en LaTeX" },
        },
        required: ["formula"],
      },
    };
  }

  const cantidad = PREGUNTAS_POR_MODELO[tipo] ?? 10;
  const pregunta = {
    type: "object",
    properties: {
      enunciado: { type: "string" },
      opciones: {
        type: "array",
        items: { type: "string" },
        minItems: 4,
        maxItems: 4,
      },
      respuesta_correcta: { type: "integer", minimum: 0, maximum: 3 },
      explicacion: { type: "string" },
    },
    required: ["enunciado", "opciones", "respuesta_correcta", "explicacion"],
  };

  return {
    name: "guardar_banco_preguntas",
    description: `Guarda el banco de preguntas de ${tipo} para el tema.`,
    input_schema: {
      type: "object",
      properties: {
        modelos: {
          type: "array",
          minItems: 6,
          maxItems: 6,
          items: {
            type: "object",
            properties: {
              premium: { type: "boolean" },
              preguntas: {
                type: "array",
                minItems: cantidad,
                maxItems: cantidad,
                items: pregunta,
              },
            },
            required: ["premium", "preguntas"],
          },
        },
      },
      required: ["modelos"],
    },
  };
}

/**
 * Prompt para Claude (IA que CREA el primer borrador).
 * tipo: "practice" | "exam" | "formula"
 */
export function armarPromptClaude(tipo, materia, tema) {
  if (tipo === "formula") {
    return {
      system: `Sos un asistente que identifica la fórmula principal de un tema de matemática/estadística para una biblioteca educativa (materia: "${materia}", tema: "${tema}").
Es la fórmula que resume el tema, la que se muestra como título/encabezado.
Devolvé SOLO un JSON válido con esta forma: {"formula": "string en LaTeX"}.

Si el tema tiene UNA sola fórmula que lo resume, devolvé esa fórmula sola, sin envoltorio extra.

Si el tema tiene VARIAS fórmulas igual de importantes (ej: "Integrales definidas e indefinidas" tiene
dos fórmulas centrales, una por cada tipo), NO las juntes en una sola línea separadas por espacio o
\\quad -- envolvé todas las fórmulas juntas en un solo bloque \\begin{gathered}...\\end{gathered},
separando cada fórmula con \\\\ (doble backslash, salto de línea real de LaTeX). Ejemplo con dos
fórmulas: "\\begin{gathered}\\int f(x)\\,dx = F(x) + C \\\\ \\int_a^b f(x)\\,dx = F(b) - F(a)\\end{gathered}".
Nunca más de 3-4 fórmulas en el mismo bloque -- si hay más, elegí solo las 2-3 más representativas del tema.

No agregues texto fuera del JSON.`,
      prompt: `Materia: ${materia}\nTema: ${tema}`,
    };
  }

  const cantidad = PREGUNTAS_POR_MODELO[tipo] ?? 10;

  return {
    system: `Sos un asistente que arma bancos de preguntas de opción múltiple para una biblioteca educativa (materia: "${materia}", tema: "${tema}").
${INSTRUCCIONES_POR_TIPO[tipo]}
Devolvé SOLO un JSON válido con esta forma exacta:
{
  "modelos": [
    { "premium": false, "preguntas": [ /* ${cantidad} preguntas */ ] },
    { "premium": false, "preguntas": [ /* ${cantidad} preguntas */ ] },
    { "premium": false, "preguntas": [ /* ${cantidad} preguntas */ ] },
    { "premium": true,  "preguntas": [ /* ${cantidad} preguntas */ ] },
    { "premium": true,  "preguntas": [ /* ${cantidad} preguntas */ ] },
    { "premium": true,  "preguntas": [ /* ${cantidad} preguntas */ ] }
  ]
}
Cada modelo tiene EXACTAMENTE ${cantidad} preguntas, ni más ni menos.
Cada pregunta tiene esta forma: ${JSON.stringify(PREGUNTA_SCHEMA_EJEMPLO)}.
Los modelos premium:true tienen que ser un poco más difíciles/completos que los premium:false.
No repitas preguntas entre modelos. No agregues texto fuera del JSON.`,
    prompt: `Materia: ${materia}\nTema: ${tema}`,
  };
}

/**
 * Prompt para Mistral (IA que CORRIGE el borrador de Claude).
 * tipo: "practice" | "exam" | "formula"
 * borrador: el objeto JSON ya parseado que devolvió Claude.
 */
export function armarPromptMistral(tipo, borrador) {
  if (tipo === "formula") {
    return {
      system: `Revisá esta fórmula principal del tema. Corregí errores matemáticos o LaTeX mal formado.
Si el campo "formula" tiene varias fórmulas dentro de un bloque \\begin{gathered}...\\end{gathered}
separadas por \\\\, mantené esa estructura -- es el formato esperado para temas con más de una fórmula
central, no lo deshagas ni lo juntes en una sola línea.
Devolvé el JSON corregido con la misma forma {"formula": "..."}. Sin texto fuera del JSON.`,
      prompt: JSON.stringify(borrador),
    };
  }

  return {
    system: `Revisá este borrador de banco de preguntas. Corregí errores matemáticos, ambigüedades en el enunciado,
opciones repetidas o mal armadas, y que "respuesta_correcta" apunte realmente a la opción correcta.
Mantené la cantidad de modelos y de preguntas por modelo tal cual está. Devolvé el JSON corregido completo
con la misma forma. Sin texto fuera del JSON.`,
    prompt: JSON.stringify(borrador),
  };
}
