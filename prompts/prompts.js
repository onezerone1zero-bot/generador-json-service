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

/**
 * Prompt para DeepSeek (IA que CREA el primer borrador).
 * tipo: "practice" | "exam" | "formula"
 */
export function armarPromptDeepSeek(tipo, materia, tema) {
  if (tipo === "formula") {
    return {
      system: `Sos un asistente que arma fichas de fórmulas de matemática/estadística para una biblioteca educativa (materia: "${materia}", tema: "${tema}").
${INSTRUCCIONES_POR_TIPO.formula}
Devolvé SOLO un JSON válido con esta forma: {"formulas": [{"nombre": "string", "latex": "string"}]}.
No agregues texto fuera del JSON.`,
      prompt: `Materia: ${materia}\nTema: ${tema}`,
    };
  }

  return {
    system: `Sos un asistente que arma bancos de preguntas de opción múltiple para una biblioteca educativa (materia: "${materia}", tema: "${tema}").
${INSTRUCCIONES_POR_TIPO[tipo]}
Devolvé SOLO un JSON válido con esta forma exacta:
{
  "modelos": [
    { "premium": false, "preguntas": [ /* 10 preguntas */ ] },
    { "premium": false, "preguntas": [ /* 10 preguntas */ ] },
    { "premium": false, "preguntas": [ /* 10 preguntas */ ] },
    { "premium": true,  "preguntas": [ /* 10 preguntas */ ] },
    { "premium": true,  "preguntas": [ /* 10 preguntas */ ] },
    { "premium": true,  "preguntas": [ /* 10 preguntas */ ] }
  ]
}
Cada pregunta tiene esta forma: ${JSON.stringify(PREGUNTA_SCHEMA_EJEMPLO)}.
Los modelos premium:true tienen que ser un poco más difíciles/completos que los premium:false.
No repitas preguntas entre modelos. No agregues texto fuera del JSON.`,
    prompt: `Materia: ${materia}\nTema: ${tema}`,
  };
}

/**
 * Prompt para ChatGPT (IA que CORRIGE el borrador de DeepSeek).
 * tipo: "practice" | "exam" | "formula"
 * borrador: el objeto JSON ya parseado que devolvió DeepSeek.
 */
export function armarPromptChatGPT(tipo, borrador) {
  if (tipo === "formula") {
    return {
      system: `Revisá este borrador de fórmulas. Corregí errores matemáticos, LaTeX mal formado, y nombres poco claros.
Devolvé el JSON corregido completo con la misma forma {"formulas": [...]}. Sin texto fuera del JSON.`,
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
