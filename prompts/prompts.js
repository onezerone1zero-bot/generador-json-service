import { FUNCIONES_PERMITIDAS } from "../lib/formulaSegura.js";

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
// SINCRONIZADO: se importa la lista directo de FUNCIONES_PERMITIDAS de
// lib/formulaSegura.js (que a su vez espeja FUNCIONES_PERMITIDAS_FORMULA
// de visual.js) en vez de tener una tercera copia hardcodeada acá --
// ya pasó dos veces que esta copia quedó vieja (primero le faltaban
// asin/acos/atan/cbrt/log2/ln, después cot/sec/csc/sinh/cosh/tanh/
// asinh/acosh/atanh/log10/floor/ceil/round/sign) y aprobaba en el schema
// funciones que formulaSegura.js iba a rechazar después. Importando de
// una sola fuente, ya no se puede desincronizar entre estas dos.
const FUNCIONES_PERMITIDAS_VISUAL = FUNCIONES_PERMITIDAS.join(", ");
const MAX_FORMULAS_VISUAL = 6; // tiene que coincidir con MAX_FORMULAS_VISUAL de lib/validarEstructura.js

// Catálogo de TODO lo que visual.js (frontend) ya sabe graficar, más allá
// de las 3 fórmulas simples de arriba (explícita/implícita/paramétrica).
// Este generador, hoy, SOLO sabe EMITIR esas 3 -- no arma ninguno de estos
// comandos aunque el frontend ya los soporte. Este bloque existe para que
// la IA, al elegir qué graficar por defecto para un tema, tenga el mapa
// REAL de lo que existe en visual.js y pueda distinguir dos casos bien
// distintos antes de recurrir a "necesitaHerramienta" (ver más abajo y
// armarToolClaude("visual")):
//   (a) el tema se resolvería con uno de estos comandos (que visual.js YA
//       tiene), pero este generador todavía no sabe emitirlo -- brecha de
//       ESTE service, no de visual.js;
//   (b) ni con esto alcanza -- haría falta una función nueva en visual.js,
//       o una herramienta aparte (ej. algo pesado de precalcular, mejor en
//       Rust/C++ que en el parser de fórmulas del canvas).
// Mantener sincronizado a mano con la lista real de visual.js (no hay un
// export compartido para esto, a diferencia de FUNCIONES_PERMITIDAS_VISUAL
// arriba, que sí se importa de formulaSegura.js).
const CAPACIDADES_VISUAL_JS_COMPLETAS = `
Funciones (modo real, variable x; en modo complejo, z): ${FUNCIONES_PERMITIDAS_VISUAL}.
Funciones solo en modo complejo, sobre z: re(z), im(z), conj(z), arg(z).
Constantes: pi, e, i (i solo en modo complejo).

Comandos 2D que visual.js YA soporta (además de fórmulas explícita/implícita):
- Circle(radius)
- r = f(theta) -> curva polar
- a(n) = f(n) -> sucesión
- dy/dx = f(x, y) -> campo de pendientes
- f(x,y) <, >, <=, >= g(x,y) -> región sombreada por desigualdad
- tangent(f(x), x0) -> recta tangente en x0 (acepta constantes: pi, 2*pi, sqrt(2), etc.)
- derivative(f(x)) -> grafica f'(x) como curva completa (derivada numérica)
- area(f(x), a, b) -> área bajo la curva entre a y b (a, b aceptan constantes)
- riemann(f(x), a, b, n, type) -> rectángulos de Riemann; type: left, right o midpoint
- taylor(f(x), a, n) -> f y su polinomio de Taylor de grado n en x=a
- field(P(x,y), Q(x,y)) -> campo vectorial (dx,dy)=(P,Q)
- matrix(a, b, c, d) -> transformación lineal [[a,b],[c,d]] aplicada a la grilla

Comandos 3D que visual.js YA soporta:
- Sphere(radius)
- Surface((x(u,v), y(u,v), z(u,v)), u, umin, umax, v, vmin, vmax)

Comportamientos automáticos (no son comandos, pasan solos con curvas explícitas):
intersecciones entre curvas visibles, raíces/corte con eje y/extremos/asíntotas verticales,
y cualquier letra suelta arma su propio slider de parámetro animable.
`.trim();

// Texto del prompt para el parámetro animable de visual.js: cualquier
// letra suelta (una sola letra, que no sea x/y/z/u/v/e/pi ni una de las
// funciones de arriba) que aparezca en la fórmula arma su propio slider
// animable en el frontend (arranca en 1, rango [-5,5]) -- ver
// detectarLetrasParametroGlobal en visual.js y la nota de "PARÁMETRO
// ANIMABLE" en formulaSegura.js. Antes esto estaba prohibido a propósito
// acá (una letra suelta se rechazaba como nombre no permitido); ya se
// habilitó en formulaSegura.js, así que el prompt tiene que decirle a la
// IA que existe y cómo usarlo sin romper la fórmula al valor inicial.
const BLOQUE_PARAMETRO_ANIMABLE = `Opcionalmente podés usar UNA letra suelta (ej. "a") como parámetro animable -- el
frontend le arma un slider propio automáticamente. Arranca en valor 1, así que la fórmula tiene que verse
bien (no quedar constante, indefinida o sin solución real) también con esa letra en 1. No la uses como la
única fuente de escala de una implícita (ej. "x^2+y^2=a" da un círculo de radio 1, válido pero chico) sin
sumarle algo -- preferí algo como "x^2+y^2=(3+a)^2". Usá como máximo una, y solo cuando de verdad aporte
(una familia de curvas con un parámetro variable), no en cada fórmula.`;

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
      description: "Guarda las fórmulas que se grafican por defecto en el graficador interactivo del tema. Si ninguna fórmula (ni ningún comando que ya tenga visual.js) representa bien el tema, usa \"necesitaHerramienta\" en vez de \"formulas\".",
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
                  description: `Expresión evaluable, NO LaTeX -- ver el system prompt para el detalle completo. Tres formatos posibles: (1) explícita en x/y, ej. "sin(x)*cos(y)"; (2) implícita "izquierda=derecha" en x/y o x/y/z, ej. "x^2+y^2=25"; (3) paramétrica, tres líneas "x=...\\ny=...\\nz=..." en u/v. Solo puede usar números, esas variables, pi/e, los operadores + - * / ^ ( ), y estas funciones: ${FUNCIONES_PERMITIDAS_VISUAL}.`,
                },
              },
              required: ["formula"],
            },
          },
          necesitaHerramienta: {
            type: "object",
            description: "Alternativa a \"formulas\" -- usar SOLO cuando ni los 3 formatos de fórmula ni ninguno de los comandos que ya tiene visual.js (ver el catálogo completo en el system prompt) alcanzan para mostrar bien este tema. No mandar junto con \"formulas\": es uno u otro.",
            properties: {
              tema: {
                type: "string",
                description: "Qué se quería graficar/mostrar para este tema (1-2 frases concretas, no genéricas).",
              },
              motivo: {
                type: "string",
                description: "Por qué ni los 3 formatos de fórmula ni ninguno de los comandos que ya tiene visual.js (ver catálogo en el system prompt) alcanzan para esto.",
              },
              herramienta_sugerida: {
                type: "string",
                description: "Qué haría falta para cubrirlo: un comando/función nueva en visual.js, o una herramienta externa aparte (y para qué, ej. precálculo pesado mejor en Rust/C++).",
              },
            },
            required: ["tema", "motivo", "herramienta_sugerida"],
          },
        },
        anyOf: [{ required: ["formulas"] }, { required: ["necesitaHerramienta"] }],
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

FORMATOS que podés usar para cada "formula" (elegí el que mejor se ajuste al tema, no fuerces uno):
1) EXPLÍCITA (el caso más común): expresión evaluable en x e y, sin "=". Ej: "sin(x)*cos(y)", "x^2-y^2".
2) IMPLÍCITA ("izquierda = derecha", en x/y o x/y/z para una superficie): usala para círculos, elipses,
   curvas de nivel o superficies que NO se pueden despejar como "y=..." o "z=..." sin perder la mitad de
   la curva. Ej: "x^2+y^2=25" (circunferencia completa -- mejor que "y=sqrt(25-x^2)", que solo muestra la
   mitad de arriba), "x^2/9+y^2/4=1" (elipse), "x^2+y^2+z^2=25" (esfera, superficie 3D).
3) PARAMÉTRICA (tres líneas "x=...", "y=...", "z=..." dentro del mismo string, cada una en función de u
   y/o v): usala para superficies o curvas 3D que no son el gráfico de una función (planos, helicoides,
   superficies regladas). Cada línea tiene que depender de u y/o v -- si las tres dependen solo de u
   (o ninguna depende de ninguna), da una superficie degenerada. El rango por defecto es u∈[0,2π],
   v∈[-1,1]: elegí algo que se vea bien EN ESE rango, no asumas que podés pedir otro. Ej. de un plano:
   {"formula": "x=u\ny=v\nz=u+v"}

REGLA DURA sobre el contenido de cada "formula" (no es LaTeX, es una expresión que un parser simple tiene
que poder evaluar tal cual), aplica a las tres partes de cualquiera de los formatos de arriba:
- Solo podés usar: números, las variables que correspondan al formato (x/y en explícita; x/y/z en
  implícita; u/v en paramétrica), las constantes pi y e, los operadores + - * / ^ ( ), y EXCLUSIVAMENTE
  estas funciones: ${FUNCIONES_PERMITIDAS_VISUAL}.
- Nada de LaTeX (sin \\frac, sin ^{}, sin subíndices), nada de comas, nada de otras funciones
  (nunca pow/atan2/mod/etc. -- fuera de la lista de arriba no existen), nada de variables sueltas fuera
  de esa lista y del parámetro animable opcional (ver abajo), nada de "y =" antepuesto a una explícita
  (para eso está el formato implícita) ni "f(x) =".
- Multiplicación implícita está permitida (ej. "2x" o "(x+1)y"), pero preferí "*" explícito salvo que
  sea un caso claro como coeficiente pegado a la variable.
- Máximo 400 caracteres para explícita/implícita; hasta 800 en total (con los saltos de línea incluidos)
  para una paramétrica de 3 líneas. Preferí siempre algo simple y visualmente claro.
- EVITÁ que la fórmula dé una pantalla vacía o inútil dentro del rango default: que no sea constante
  (ej. "0*x+5"), que no quede indefinida en casi todo el rango x,y∈[-10,10] (ej. "log(x-100)"), que no se
  dispare a valores absurdos ahí (ej. "exp(x)" ya da ~22000 en x=10), y si es implícita, que realmente
  tenga solución real en ese rango (que cambie de signo en algún punto, no que un lado del "=" domine
  siempre al otro).
- ${BLOQUE_PARAMETRO_ANIMABLE}
${bloqueIdioma(idioma)}
Ejemplos válidos: "sin(x)*cos(y)", "x^2-y^2", "exp(-x^2-y^2)", "x^2+y^2=25".
Ejemplo de tema comparativo: {"formulas": [{"formula": "x^2"}, {"formula": "2*x"}]}.

SI NINGUNA FÓRMULA REPRESENTA BIEN EL TEMA: antes de forzar algo que no queda bien, tené en cuenta que
visual.js (el frontend) ya soporta bastante más que estas 3 fórmulas -- este catálogo completo:
${CAPACIDADES_VISUAL_JS_COMPLETAS}
Importante: VOS solo podés emitir "formulas" en los 3 formatos de arriba -- no podés emitir ninguno de estos
otros comandos (Circle, tangent, area, riemann, taylor, field, matrix, Surface, etc.), aunque el frontend ya
los tenga. Si el tema se resolvería con uno de ESOS comandos, o si ni con todo este catálogo alcanza (haría
falta una función nueva en visual.js o una herramienta externa aparte), NO inventes una fórmula forzada que
no muestre bien el tema: llamá a la herramienta con "necesitaHerramienta" en vez de "formulas", explicando
qué se quería graficar, por qué no alcanza lo disponible, y qué haría falta. Usalo solo cuando de verdad
haga falta -- la gran mayoría de los temas SÍ se resuelven bien con una fórmula explícita/implícita/
paramétrica normal, esto no es un atajo para evitar pensar la fórmula.
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
      system: `Revisá estas fórmulas visuales (una lista en "formulas"). Cada una tiene que estar en uno de estos
formatos -- NO LaTeX:
- Explícita: expresión evaluable en x e y, sin "=".
- Implícita: "izquierda = derecha" en x/y (o x/y/z para una superficie 3D) -- para círculos, elipses o
  superficies que no se pueden despejar sin perder la mitad de la curva.
- Paramétrica: tres líneas "x=...", "y=...", "z=..." dentro del mismo string, cada una en función de u y/o v.
En cualquiera de los tres, solo puede usar: números, las variables de ese formato (x/y en explícita; x/y/z
en implícita; u/v en paramétrica), pi, e, los operadores + - * / ^ ( ), y EXCLUSIVAMENTE estas funciones:
${FUNCIONES_PERMITIDAS_VISUAL}. Excepción: UNA sola letra suelta (que no sea de esa lista) es válida como
parámetro animable -- ver el párrafo de abajo -- no la reescribas como si fuera "otra variable" inválida.
Si encontrás algo fuera de esa gramática (otra función, LaTeX, dos o más letras sueltas distintas, una coma,
"y =" antepuesto a una explícita, "f(x) ="), reescribila para que quede dentro de estas reglas sin cambiar
demasiado la idea matemática original -- si la idea es un círculo o superficie que solo se puede expresar de
forma implícita o paramétrica, NO la fuerces a explícita aunque eso implique perder la mitad de la curva.
${BLOQUE_PARAMETRO_ANIMABLE}
También corregí, sin cambiar el formato elegido, si la fórmula da una pantalla vacía o inútil: constante,
indefinida en casi todo el rango x,y∈[-10,10] (o u∈[0,2π], v∈[-1,1] en paramétrica), que se dispara a
valores absurdos ahí, o que -siendo implícita- no tiene solución real en ese rango (no cambia de signo).
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
      system: `Revisá estas fórmulas visuales (una lista en "formulas"). Cada una tiene que estar en uno de estos
formatos -- NO LaTeX:
- Explícita: expresión evaluable en x e y, sin "=".
- Implícita: "izquierda = derecha" en x/y (o x/y/z para una superficie 3D) -- para círculos, elipses o
  superficies que no se pueden despejar sin perder la mitad de la curva.
- Paramétrica: tres líneas "x=...", "y=...", "z=..." dentro del mismo string, cada una en función de u y/o v.
En cualquiera de los tres, solo puede usar: números, las variables de ese formato (x/y en explícita; x/y/z
en implícita; u/v en paramétrica), pi, e, los operadores + - * / ^ ( ), y EXCLUSIVAMENTE estas funciones:
${FUNCIONES_PERMITIDAS_VISUAL}. Excepción: UNA sola letra suelta (que no sea de esa lista) es válida como
parámetro animable -- ver el párrafo de abajo -- no la reescribas como si fuera "otra variable" inválida.
Si encontrás algo fuera de esa gramática (otra función, LaTeX, dos o más letras sueltas distintas, una coma,
"y =" antepuesto a una explícita, "f(x) ="), reescribila para que quede dentro de estas reglas sin cambiar
demasiado la idea matemática original -- si la idea es un círculo o superficie que solo se puede expresar de
forma implícita o paramétrica, NO la fuerces a explícita aunque eso implique perder la mitad de la curva.
${BLOQUE_PARAMETRO_ANIMABLE}
También corregí, sin cambiar el formato elegido, si la fórmula da una pantalla vacía o inútil: constante,
indefinida en casi todo el rango x,y∈[-10,10] (o u∈[0,2π], v∈[-1,1] en paramétrica), que se dispara a
valores absurdos ahí, o que -siendo implícita- no tiene solución real en ese rango (no cambia de signo).
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
