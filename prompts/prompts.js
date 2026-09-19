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

// Gramática EXACTA que acepta el graficador del frontend (visual.js) y
// que revalida formulaSegura.js del lado del server -- ver ese archivo.
// Se repite el texto en el prompt (no solo en el schema del tool) porque
// tool_choice forzado garantiza la FORMA del JSON ({"formula": "..."}),
// no que el contenido de "formula" respete esta gramática -- eso lo
// sigue validando validarVisual() después.
const FUNCIONES_PERMITIDAS_VISUAL = "sin, cos, tan, sqrt, abs, exp, log";
const MAX_FORMULAS_VISUAL = 6; // tiene que coincidir con MAX_FORMULAS_VISUAL de lib/validarEstructura.js

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

  if (tipo === "visual") {
    return {
      name: "guardar_formulas_visual",
      description: "Guarda las fórmulas que se grafican por defecto en el graficador interactivo del tema.",
      input_schema: {
        type: "object",
        properties: {
          formulas: {
            type: "array",
            minItems: 1,
            maxItems: MAX_FORMULAS_VISUAL,
            description: `Entre 1 y ${MAX_FORMULAS_VISUAL} fórmulas distintas que se grafican juntas, cada una con su color. La primera es la principal.`,
            items: {
              type: "object",
              properties: {
                formula: {
                  type: "string",
                  description: `Expresión evaluable en x e y (no LaTeX). Solo puede usar: números, las variables x/y, las constantes pi/e, los operadores + - * / ^ ( ), y estas funciones: ${FUNCIONES_PERMITIDAS_VISUAL}. Ejemplo: "sin(x)*cos(y)".`,
                },
              },
              required: ["formula"],
            },
          },
        },
        required: ["formulas"],
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
 * Tool schema para la CORRECCIÓN con Fable (misma forma que
 * armarToolClaude, pero con nombre/descripción propios de un paso de
 * revisión en vez de creación). Se reusa la construcción del schema en
 * vez de duplicarlo a mano, así ambos tools quedan garantizados
 * idénticos en forma -- si se cambia el schema de preguntas en un
 * lugar (ej: agregar un campo nuevo a "pregunta"), automáticamente
 * aplica a los dos pasos sin tener que recordar tocar dos sitios.
 * Usada hoy solo para tipo="exam" -- ver MODELO_CLAUDE_POR_TIPO en
 * generar.js.
 */
export function armarToolCorreccion(tipo) {
  const toolBase = armarToolClaude(tipo);
  if (tipo === "formula") {
    return { ...toolBase, name: "guardar_formula_corregida", description: "Guarda la fórmula corregida del tema." };
  }
  if (tipo === "visual") {
    return { ...toolBase, name: "guardar_formulas_visual_corregidas", description: "Guarda las fórmulas visuales corregidas del tema." };
  }
  return { ...toolBase, name: "guardar_banco_preguntas_corregido", description: `Guarda el banco de preguntas de ${tipo} corregido para el tema.` };
}

/**
 * Bloque de instrucción de idioma, compartido por las tres funciones de
 * este archivo (armarPromptClaude, armarPromptMistral,
 * armarPromptCorreccionFable). Vacío para "es" (no cambia el texto para
 * la instancia española); para cualquier otro idioma, le dice
 * explícitamente a la IA que redacte el contenido en ese idioma.
 *
 * FIX (soporte de idioma, ver ANALISIS-idioma-generador-json.md, punto 3):
 * antes ninguna de las tres funciones recibía idioma, y el system entero
 * estaba hardcodeado en español sin indicar en qué idioma debía salir el
 * contenido generado -- si `materia`/`tema` llegaban en otro idioma, no
 * había nada que le impidiera a la IA redactar igual en español.
 *
 * IMPORTANTE: este bloque se usa en las TRES funciones, no solo en
 * armarPromptClaude. armarPromptCorreccionFable en particular RE-DERIVA
 * cada pregunta desde cero (no solo revisa forma) -- si a esta le
 * faltara el bloque, un borrador correcto en inglés podría volver
 * corregido en español sin que validarEstructura.js lo detecte (valida
 * forma, no idioma).
 *
 * @param {string} idioma
 * @param {string} [campoExtra] - nombre de un campo adicional a
 *   mencionar en la lista de campos a redactar (ej. "etiqueta" para
 *   formula). Si no se pasa, no se agrega ningún campo extra.
 */
function bloqueIdioma(idioma, campoExtra) {
  if (!idioma || idioma === "es") return "";
  const campos = ["enunciado", "opciones", "explicacion", ...(campoExtra ? [campoExtra] : [])].join(", ");
  return `\nIMPORTANTE - idioma de salida: "materia" y "tema" ya te llegan en el idioma de esta instancia
(código "${idioma}"). Todo el contenido que generás (${campos}) tiene que redactarse en ese mismo
idioma, aunque estas instrucciones estén en español. La notación matemática (LaTeX) no cambia.\n`;
}

/**
 * Prompt para Claude (IA que CREA el primer borrador).
 * tipo: "practice" | "exam" | "formula"
 * idioma: código de idioma de esta instancia (ver process.env.IDIOMA en
 *   generar.js). Default "es" -- no cambia el texto existente.
 */
export function armarPromptClaude(tipo, materia, tema, idioma = "es") {
  if (tipo === "formula") {
    return {
      system: `Sos un asistente que identifica la fórmula principal de un tema de matemática/estadística para una biblioteca educativa (materia: "${materia}", tema: "${tema}").
Es la fórmula que resume el tema, la que se muestra como título/encabezado.
Devolvé SOLO un JSON válido con esta forma: {"formula": "string en LaTeX"}.
${bloqueIdioma(idioma, "etiqueta")}
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

  if (tipo === "visual") {
    return {
      system: `Sos un asistente que elige las fórmulas matemáticas que se van a graficar por defecto en un
graficador interactivo (materia: "${materia}", tema: "${tema}"). Son solo los valores DEFAULT: el usuario
después las puede editar, sumar o quitar, y elige si las ve como gráfico 2D o como superficie 3D con los
mismos botones, así que no hace falta que decidas eso.
Devolvé SOLO un JSON válido con esta forma: {"formulas": [{"formula": "string"}, ...]}.

CUÁNTAS: elegí entre 1 y ${MAX_FORMULAS_VISUAL} fórmulas, según lo que el tema realmente necesite.
- Si el tema se entiende con una sola curva o superficie, devolvé UNA. No agregues fórmulas de relleno.
- Si el tema se entiende mejor comparando (ej: una función y su derivada, distintos casos de un parámetro,
  una familia de curvas, función e inversa), devolvé las que hagan falta para esa comparación.
- La primera es la principal. Las demás tienen que aportar algo distinto: nunca repitas una fórmula ni
  devuelvas variantes triviales de la misma (ej: "sin(x)" y "1*sin(x)").
- No mezcles fórmulas de 2D (solo x) con superficies 3D (x e y) en la misma lista salvo que el tema lo pida:
  se grafican todas en el mismo modo, y una función solo de x se ve como una pared en 3D.

REGLA DURA sobre el contenido de cada "formula" (no es LaTeX, es una expresión que un parser simple tiene
que poder evaluar tal cual):
- Solo podés usar: números, las variables x e y, las constantes pi y e, los operadores + - * / ^ ( ),
  y EXCLUSIVAMENTE estas funciones: ${FUNCIONES_PERMITIDAS_VISUAL}.
- Nada de LaTeX (sin \\frac, sin ^{}, sin subíndices), nada de comas, nada de otras funciones
  (nunca pow/cosh/atan/log10/etc.), nada de variables que no sean x/y, nada de "y =" ni "f(x) =".
- Multiplicación implícita está permitida (ej. "2x" o "(x+1)y"), pero preferí "*" explícito salvo que
  sea un caso claro como coeficiente pegado a la variable.
- Máximo 400 caracteres por fórmula, y preferí algo simple y visualmente claro (ideal: menos de 60).
${bloqueIdioma(idioma)}
Ejemplos válidos de una fórmula: "sin(x)*cos(y)", "x^2-y^2", "exp(-x^2-y^2)", "sqrt(abs(x*y))".
Ejemplo de tema comparativo: {"formulas": [{"formula": "x^2"}, {"formula": "2*x"}]}.
No agregues texto fuera del JSON.`,
      prompt: `Materia: ${materia}\nTema: ${tema}`,
    };
  }

  const cantidad = PREGUNTAS_POR_MODELO[tipo] ?? 10;

  return {
    system: `Sos un asistente que arma bancos de preguntas de opción múltiple para una biblioteca educativa (materia: "${materia}", tema: "${tema}").
${INSTRUCCIONES_POR_TIPO[tipo]}
${bloqueIdioma(idioma)}
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
 *
 * Para tipo="exam" este ya no es el corrector principal: generar.js
 * intenta primero con Fable (armarPromptCorreccionFable, más abajo) y
 * solo llama a esto si Fable falla o no valida -- ver
 * intentarCorregirConFable/intentarCorregirConMistral en generar.js.
 * El texto de este prompt no se tocó a propósito (para no cambiar el
 * comportamiento ya validado de practice/formula, que lo siguen usando
 * como corrector único), más allá de sumar el bloque de idioma (ver
 * bloqueIdioma arriba) -- necesario para que la corrección no reescriba
 * el borrador de vuelta al español.
 *
 * idioma: mismo parámetro que armarPromptClaude, default "es".
 */
export function armarPromptMistral(tipo, borrador, idioma = "es") {
  if (tipo === "formula") {
    return {
      system: `Revisá esta fórmula principal del tema. Corregí errores matemáticos o LaTeX mal formado.
Si el campo "formula" tiene varias fórmulas dentro de un bloque \\begin{gathered}...\\end{gathered}
separadas por \\\\, mantené esa estructura -- es el formato esperado para temas con más de una fórmula
central, no lo deshagas ni lo juntes en una sola línea.
${bloqueIdioma(idioma, "etiqueta")}
Devolvé el JSON corregido con la misma forma {"formula": "..."}. Sin texto fuera del JSON.`,
      prompt: JSON.stringify(borrador),
    };
  }

  if (tipo === "visual") {
    return {
      system: `Revisá estas fórmulas visuales (una lista en "formulas"). Cada una tiene que ser una expresión evaluable
en x e y -- NO LaTeX -- que solo use: números, x, y, pi, e, los operadores + - * / ^ ( ), y EXCLUSIVAMENTE
estas funciones: ${FUNCIONES_PERMITIDAS_VISUAL}. Si encontrás algo fuera de esa gramática (otra función,
LaTeX, otra variable, una coma, "y =" al principio), reescribila para que quede dentro de esas reglas sin
cambiar demasiado la idea matemática original.
Reglas de la lista: conservá la MISMA cantidad de fórmulas y el MISMO orden (la primera es la principal);
no agregues ni quites fórmulas salvo que haya dos repetidas o equivalentes triviales, en cuyo caso quitá la
repetida; máximo ${MAX_FORMULAS_VISUAL}. Si algún item trae "color", dejalo tal cual.
${bloqueIdioma(idioma)}
Devolvé el JSON corregido con la forma {"formulas": [{"formula": "..."}, ...]}. Sin texto fuera del JSON.`,
      prompt: JSON.stringify(borrador),
    };
  }

  return {
    system: `Revisá este borrador de banco de preguntas. Corregí errores matemáticos, ambigüedades en el enunciado,
opciones repetidas o mal armadas, y que "respuesta_correcta" apunte realmente a la opción correcta.
Mantené la cantidad de modelos y de preguntas por modelo tal cual está.
${bloqueIdioma(idioma)}
Devolvé el JSON corregido completo con la misma forma. Sin texto fuera del JSON.`,
    prompt: JSON.stringify(borrador),
  };
}

/**
 * Prompt para Opus (IA que CORRIGE el borrador con re-derivación
 * explícita; antes lo corría Fable, mismo prompt, solo cambió el
 * modelo). Se usa para "exam" siempre, y ahora también para
 * "practice"/"formula" como corrector -- ver MODELO_CLAUDE_POR_TIPO en
 * generar.js. A diferencia del prompt de Mistral -- que pide "corregí
 * errores matemáticos" como una línea entre varias otras tareas de
 * proofreading -- este es explícito paso a paso: pide RE-DERIVAR cada
 * función antes de mirar qué opción quedó marcada, en vez de leer el
 * texto y juzgar si "suena" coherente. Esto es deliberado: un borrador
 * puede tener una explicación con álgebra correcta y un resultado
 * final que la contradice (visto en auditoría manual de un examen real
 * de "Cálculo / Derivadas" -- 4 de 71 preguntas con ese patrón), que un
 * chequeo superficial de coherencia textual no atrapa pero un
 * recálculo sí.
 *
 * Si esta corrección falla o no valida, generar.js cae a
 * armarPromptMistral como fallback -- ver intentarCorregirConOpus /
 * intentarCorregirConMistral ahí.
 *
 * idioma: mismo parámetro que armarPromptClaude, default "es". Ver la
 * advertencia en el comentario de bloqueIdioma() sobre por qué este
 * parámetro es tan importante ACÁ como en armarPromptClaude: esta
 * función re-deriva el contenido desde cero, así que sin el bloque de
 * idioma puede devolver el banco corregido en español aunque el
 * borrador de entrada estuviera en otro idioma.
 */
export function armarPromptCorreccionFable(tipo, borrador, idioma = "es") {
  if (tipo === "formula") {
    return {
      system: `Revisá esta fórmula principal del tema. Corregí errores matemáticos o LaTeX mal formado.
Si el campo "formula" tiene varias fórmulas dentro de un bloque \\begin{gathered}...\\end{gathered}
separadas por \\\\, mantené esa estructura -- es el formato esperado para temas con más de una fórmula
central, no lo deshagas ni lo juntes en una sola línea.
${bloqueIdioma(idioma, "etiqueta")}
Guardá la fórmula corregida con la herramienta.`,
      prompt: JSON.stringify(borrador),
    };
  }

  if (tipo === "visual") {
    return {
      system: `Revisá estas fórmulas visuales (una lista en "formulas"). Cada una tiene que ser una expresión evaluable
en x e y -- NO LaTeX -- que solo use: números, x, y, pi, e, los operadores + - * / ^ ( ), y EXCLUSIVAMENTE
estas funciones: ${FUNCIONES_PERMITIDAS_VISUAL}. Si encontrás algo fuera de esa gramática (otra función,
LaTeX, otra variable, una coma, "y =" al principio), reescribila para que quede dentro de esas reglas sin
cambiar demasiado la idea matemática original.
Reglas de la lista: conservá la MISMA cantidad de fórmulas y el MISMO orden (la primera es la principal);
no agregues ni quites fórmulas salvo que haya dos repetidas o equivalentes triviales, en cuyo caso quitá la
repetida; máximo ${MAX_FORMULAS_VISUAL}. Si algún item trae "color", dejalo tal cual.
${bloqueIdioma(idioma)}
Guardá las fórmulas visuales corregidas con la herramienta.`,
      prompt: JSON.stringify(borrador),
    };
  }

  return {
    system: `Revisá este borrador de banco de preguntas de matemática. Para CADA pregunta, hacé lo siguiente
en este orden:
1. Volvé a derivar (o resolver) la función del enunciado DESDE CERO, con tu propio cálculo, sin mirar
   todavía cuál opción está marcada como correcta.
2. Comparé tu resultado contra las 4 opciones. Si tu resultado coincide EXACTAMENTE (incluyendo signo)
   con una de las 4 opciones, marcá esa como "respuesta_correcta". Si no coincide con ninguna, reescribí
   la opción marcada con tu resultado correcto (no dejes una opción matemáticamente incorrecta aunque sea
   la que estaba marcada).
3. Verificá que las 4 opciones de cada pregunta sean todas DISTINTAS entre sí como texto -- si dos
   opciones son idénticas, reescribí una de las incorrectas para que sea un distractor plausible pero
   distinto.
4. Revisá ambigüedades en el enunciado y que la explicación no se contradiga con el resultado final.
No cambies la cantidad de modelos ni de preguntas por modelo.
${bloqueIdioma(idioma)}
Guardá el banco corregido completo con la herramienta.`,
    prompt: JSON.stringify(borrador),
  };
}
