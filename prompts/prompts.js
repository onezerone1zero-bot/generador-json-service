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
// Este generador, hoy, SOLO sabe EMITIR esas 3 más el comando euler(...)
// (formato 4) -- no arma ninguno de los otros comandos aunque el frontend
// ya los soporte. Este bloque existe para que
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
- euler(angulo) -> fórmula de Euler en el plano complejo: círculo unidad y flecha a e^(i*angulo) = cos(angulo) + i*sin(angulo), con sus proyecciones y el paso "+1" (con angulo = pi la flecha termina en 0: e^(i*pi)+1=0). El ángulo va en radianes y puede llevar una letra suelta como parámetro animable (euler(t)). ESTE es el único comando que vos SÍ podés emitir (ver el formato 4 de arriba).

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
(una familia de curvas cuyo parámetro tiene un significado que el tema enseña), no en cada fórmula ni
solo para mostrar "distintas pendientes" o "distintas escalas" de la misma curva.`;

// Criterio de REPRESENTACIÓN para "visual" -- el modelo lo aplica ANTES de elegir fórmulas (ver el campo "analisis"
// de armarToolVisual y validarAnalisisVisual en validarEstructura.js). Surge de un caso real: para
// "Hydrostatics" el generador devolvió "a*x", "2*x" y "0.5*x" -- tres rectas genéricas que el alumno no puede
// asociar a la presión ni a la profundidad (el graficador solo muestra ejes x/y sin rótulos ni unidades). La
// regla central es la "prueba del alumno": el gráfico tiene que enseñar el tema POR SU FORMA, sin texto.
const CRITERIO_CUERPO_VISUAL = `Lo que el alumno ve es SOLO un gráfico con ejes x/y (o x/y/z) sin título, sin rótulos, sin unidades y sin
explicación escrita: no puede saber que "x" quería decir "profundidad" o "tiempo". El gráfico tiene que enseñar el
tema por su forma.
PRUEBA DEL ALUMNO: si alguien ve la gráfica sin ningún texto, ¿entiende qué enseña el tema, o ve una función
cualquiera? Si ve una función cualquiera, el tema NO se grafica bien acá.
- GRAFICÁ cuando la esencia del tema ES una función o relación matemática cuya forma es la lección:
  funciones y sus familias, límites, derivadas, integrales, trigonometría, cónicas, curvas y superficies,
  números complejos, distribuciones de probabilidad (la curva de densidad), series y sucesiones, ecuaciones
  diferenciales (campos de pendientes).
- GRAFICÁ un tema de otra ciencia SOLO si tiene una curva canónica, la que todo libro dibuja y que se reconoce
  sin rótulos (ej. la campana de Gauss, una oscilación senoidal, la trayectoria parabólica y(x) de un tiro
  oblicuo, un decaimiento exponencial).
- RESERVÁ cuando la esencia del tema es una ESCENA, un sistema, un proceso, un aparato o una magnitud con unidades
  (fluidos en reposo, circuitos, reacciones y estequiometría, división celular, diagramas de rayos, fuerzas sobre un
  cuerpo, oferta y demanda con curvas rotuladas) y lo único que se podría dibujar es una recta o curva genérica a
  la que solo el autor le da significado. Que una ley sea lineal NO justifica graficar "a*x", "2*x" y "0.5*x": eso
  es una familia de rectas sin significado para el alumno.
- Que "se pueda escribir una fórmula" NO es suficiente: tiene que enseñar el tema. Forzar un gráfico genérico es
  peor que reservar, porque el alumno cree que eso es lo que el tema significa.
- Si la prueba del alumno se pasa, se grafica sin vacilar; si falla, se reserva.`;

// Versión para el CREADOR del borrador (usa el campo "analisis" de su herramienta).
const CRITERIO_REPRESENTACION_VISUAL = `PRIMERO DECIDÍ SI ESTE TEMA SE PUEDE MOSTRAR BIEN EN ESTE GRAFICADOR. Antes de elegir ninguna fórmula,
completá el campo "analisis" de la herramienta. ${CRITERIO_CUERPO_VISUAL}
En "relacion_candidata" decí qué magnitud es cada eje. Reservar = "veredicto": "reservar" + "necesitaHerramienta".`;

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

  if (tipo === "visual") return armarToolVisual(true);

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
 * Tool de "visual". `conAnalisis` = true para la CREACIÓN del borrador: suma el campo "analisis" (razonamiento
 * previo que el modelo tiene que completar ANTES de elegir fórmulas -- con tool_choice forzado no hay "thinking"
 * extendido, así que el razonamiento se obliga por esquema; el servidor lo valida en validarAnalisisVisual).
 * La tool de CORRECCIÓN (armarToolCorreccion) usa conAnalisis = false: ahí ya se decidió y solo se revisan fórmulas.
 */
function armarToolVisual(conAnalisis) {
  const analisis = conAnalisis ? {
    analisis: {
      type: "object",
      description: "Razonamiento previo: completalo PRIMERO, antes de \"formulas\" o \"necesitaHerramienta\". No se muestra al alumno; el servidor lo valida.",
      properties: {
        concepto_central: {
          type: "string",
          description: "Qué enseña este tema, en 1 frase concreta (no el nombre del tema repetido).",
        },
        relacion_candidata: {
          type: "string",
          description: "La relación matemática concreta que sería el corazón del tema y qué significa cada variable o eje (x, y, z, u, v). Si ninguna enseña el tema, escribí \"ninguna\" y explicá por qué.",
        },
        prueba_del_alumno: {
          type: "string",
          description: "Qué entendería un alumno que ve SOLO la gráfica, con ejes x/y sin etiquetas, sin unidades y sin tu explicación: ¿ve el concepto del tema o una función cualquiera?",
        },
        veredicto: {
          type: "string",
          enum: ["grafica_bien", "reservar"],
          description: "\"grafica_bien\" SOLO si la prueba del alumno se pasa; \"reservar\" si no. Con \"reservar\" hay que completar \"necesitaHerramienta\" y NO mandar \"formulas\"; con \"grafica_bien\" hay que mandar \"formulas\" y NO \"necesitaHerramienta\".",
        },
      },
      required: ["concepto_central", "relacion_candidata", "prueba_del_alumno", "veredicto"],
    },
  } : {};
  return {
    name: "guardar_formulas_visual",
    description: "Guarda las fórmulas que se grafican por defecto en el graficador interactivo del tema. Completá primero \"analisis\". Si el tema no se enseña bien con ninguna fórmula (ni con ningún comando que ya tenga visual.js), usá \"necesitaHerramienta\" en vez de \"formulas\".",
    input_schema: {
      type: "object",
      ...(conAnalisis ? { required: ["analisis"] } : {}),
      properties: {
        ...analisis,
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
                description: `Expresión evaluable, NO LaTeX -- ver el system prompt para el detalle completo. Cuatro formatos posibles: (1) explícita en x/y, ej. "sin(x)*cos(y)"; (2) implícita "izquierda=derecha" en x/y o x/y/z, ej. "x^2+y^2=25"; (3) paramétrica, tres líneas "x=...\\ny=...\\nz=..." en u/v; (4) el comando euler(ángulo), ej. "euler(t)" o "euler(pi)": fórmula de Euler en el plano complejo (solo 2D, va solo o con curvas 2D). Salvo en euler(...), solo puede usar números, esas variables, pi/e, los operadores + - * / ^ ( ), y estas funciones: ${FUNCIONES_PERMITIDAS_VISUAL}.`,
              },
            },
            required: ["formula"],
          },
        },
        necesitaHerramienta: {
          type: "object",
          description: "Alternativa a \"formulas\" -- usar SOLO cuando ni los 4 formatos de fórmula ni ninguno de los comandos que ya tiene visual.js (ver el catálogo completo en el system prompt) alcanzan para mostrar bien este tema. No mandar junto con \"formulas\": es uno u otro.",
          properties: {
            tema: {
              type: "string",
              description: "Qué se quería graficar/mostrar para este tema (1-2 frases concretas, no genéricas).",
            },
            motivo: {
              type: "string",
              description: "Por qué ni los 4 formatos de fórmula ni ninguno de los comandos que ya tiene visual.js (ver catálogo en el system prompt) alcanzan para esto.",
            },
            herramienta_sugerida: {
              type: "string",
              description: "Qué haría falta para cubrirlo: un comando/función nueva en visual.js, o una herramienta externa aparte (y para qué, ej. precálculo pesado mejor en Rust/C++).",
            },
          },
          required: ["tema", "motivo", "herramienta_sugerida"],
        },
      },
      // SIN anyOf/oneOf/allOf en la raíz: la API de Anthropic rechaza el
      // input_schema con 400 ("input_schema does not support oneOf,
      // allOf, or anyOf at the top level"), lo que hacía fallar TODOS los
      // intentos de "visual". La regla "formulas O necesitaHerramienta"
      // (uno u otro, al menos uno) ya la hace cumplir validarVisual en
      // lib/validarEstructura.js del lado del servidor, y el description
      // de cada campo se lo dice al modelo.
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
  if (tipo === "visual") {
    // Sin "analisis": la decisión de graficar/reservar ya se tomó (borrador + juez); acá solo se revisan las
    // fórmulas. Lleva "revision_matematica" (PRIMERA propiedad, obligatoria): el revisor matemático tiene que
    // re-derivar cada fórmula antes de devolverla -- ver validarRevisionMatematicaVisual.
    const base = armarToolVisual(false);
    return {
      ...base,
      name: "guardar_formulas_visual_corregidas",
      description: "Guarda las fórmulas visuales revisadas del tema. Completá primero \"revision_matematica\" (una fila por fórmula).",
      input_schema: {
        ...base.input_schema,
        required: ["revision_matematica"],
        properties: {
          revision_matematica: {
            type: "array",
            minItems: 1,
            maxItems: MAX_FORMULAS_VISUAL,
            description: "Una fila por fórmula de \"formulas\" (misma cantidad y mismo orden), completada ANTES de devolver las fórmulas.",
            items: {
              type: "object",
              properties: {
                relacion_prevista: {
                  type: "string",
                  description: "Qué relación matemática del tema debería representar esta fórmula, en palabras o en notación (ej. \"densidad normal estándar: exp(-x^2/2)/sqrt(2*pi)\").",
                },
                comprobacion: {
                  type: "string",
                  description: "Cómo la re-derivaste y comprobaste: constantes, signos, dominio y 2-3 valores concretos calculados a mano (ej. \"en x=0 da 0.399; en x=±1 da 0.242\") y si se ve en el rango x,y∈[-10,10].",
                },
                resultado: { type: "string", enum: ["correcta", "corregida"], description: "\"correcta\" si la dejás IGUAL; \"corregida\" si la cambiaste." },
              },
              required: ["relacion_prevista", "comprobacion", "resultado"],
            },
          },
          ...base.input_schema.properties,
        },
      },
    };
  }
  const toolBase = armarToolClaude(tipo);
  if (tipo === "formula") {
    return { ...toolBase, name: "guardar_formula_corregida", description: "Guarda la fórmula corregida del tema." };
  }
  return { ...toolBase, name: "guardar_banco_preguntas_corregido", description: `Guarda el banco de preguntas de ${tipo} corregido para el tema.` };
}

/**
 * Tool del JUEZ de "visual". El juez es una CONSULTA CIEGA: no ve nada de lo que propuso el creador (ni fórmulas ni
 * razonamiento ni criterio) -- recibe solo materia + tema y responde "¿se puede crear una herramienta mejor que un
 * graficador de funciones para enseñar esto?". Así no se ancla a la propuesta del creador (los modelos que evalúan
 * tienden a coincidir con lo que leen) y la pregunta cambia el sesgo: en vez de pedirle que "se rinda", se le pide
 * que PROPONGA la mejor herramienta, que es lo que un modelo hace con ganas. El veredicto lo deriva el servidor
 * del nivel de "mejora" (ver veredictoDelJuezVisual): el modelo no elige "aprobar" a la ligera. Los campos van en
 * el orden en que tiene que razonar.
 */
export function armarToolJuezVisual() {
  return {
    name: "dictaminar_visual",
    description: "Dictamina cuánto mejor podría enseñar este tema una herramienta ideal frente a un graficador de funciones. Completá los campos EN ORDEN.",
    input_schema: {
      type: "object",
      required: ["leccion_esencial", "mejor_herramienta_posible", "que_alcanza_a_mostrar_un_graficador", "lo_que_se_pierde", "mejora", "razon"],
      properties: {
        leccion_esencial: {
          type: "string",
          description: "Lo esencial que un alumno debería entender de este tema (1-2 frases concretas).",
        },
        mejor_herramienta_posible: {
          type: "string",
          description: "La mejor herramienta imaginable para enseñar esa lección, sin limitarte a lo que existe hoy: qué mostraría y cómo se usaría, en concreto.",
        },
        que_alcanza_a_mostrar_un_graficador: {
          type: "string",
          description: "Qué parte de la lección llegaría a mostrar un graficador de funciones (curvas y superficies sobre ejes x/y sin rótulos ni unidades).",
        },
        lo_que_se_pierde: {
          type: "string",
          description: "Qué parte ESENCIAL de la lección el graficador NO muestra o muestra de forma confusa. Si ninguna, decilo y explicá por qué.",
        },
        mejora: {
          type: "string",
          enum: ["ninguna", "marginal", "sustancial", "enorme"],
          description: "Cuánto más enseñaría la herramienta ideal que el graficador, en lo ESENCIAL (no cuenta el pulido visual ni lo que el graficador ya hace): ninguna | marginal | sustancial | enorme.",
        },
        razon: { type: "string", description: "Justificación de la mejora en 1-3 frases, para el registro (no la ve el alumno)." },
      },
    },
  };
}

/**
 * Prompt del JUEZ de "visual" (consulta ciega, ver armarToolJuezVisual). Recibe SOLO materia y tema; describe
 * qué es y qué hace hoy el graficador para que pueda comparar, pero no incluye la propuesta del creador, su
 * razonamiento ni el criterio de graficar/reservar. Los dos ejemplos de calibración son de signo contrario y
 * ninguno es el caso que originó este flujo (Hidrostática).
 */
export function armarPromptJuezVisual(materia, tema, idioma = "es") {
  return {
    system: `Sos un diseñador de herramientas educativas con mucha experiencia. Te consultan por un tema (materia:
"${materia}", tema: "${tema}").

Hoy esta biblioteca enseña los temas con un GRAFICADOR DE FUNCIONES. Esto es TODO lo que hace: dibuja curvas y
superficies a partir de fórmulas, sobre ejes x/y (o x/y/z) sin título, sin rótulos y sin unidades; el alumno ve solo
las gráficas y la lista de fórmulas, nada más. No dibuja escenas, aparatos, objetos físicos, diagramas ni procesos.
Lo que ya sabe hacer, además de graficar fórmulas:
${CAPACIDADES_VISUAL_JS_COMPLETAS}

Tu pregunta: ¿se puede crear una herramienta MEJOR que ese graficador para enseñar ESTE tema?
1. Pensá primero qué es lo esencial que un alumno debería entender ("leccion_esencial").
2. Imaginá la mejor herramienta posible para enseñarlo, sin limitarte a lo que existe hoy
   ("mejor_herramienta_posible"): qué mostraría y cómo se usaría, en concreto.
3. Pensá qué parte de esa lección llegaría a mostrar el graficador de funciones
   ("que_alcanza_a_mostrar_un_graficador") y qué parte NO ("lo_que_se_pierde").
4. Dá la "mejora": cuánto más enseñaría la herramienta ideal que el graficador, en lo ESENCIAL del tema.
   - "ninguna": el graficador ya muestra lo esencial; una herramienta nueva no enseñaría más.
   - "marginal": enseñaría un poco más (más prolijo, más cómodo, algún extra), pero la lección se entiende igual con
     el graficador.
   - "sustancial": hay una parte esencial de la lección que el graficador no puede mostrar, o solo muestra de forma
     confusa.
   - "enorme": el graficador casi no sirve para este tema; la lección está en otra cosa (una escena, un proceso, un
     aparato, objetos reales) y solo podría dibujar curvas genéricas.
   No cuenta como mejora: mejor diseño, colores, más animación decorativa, ni nada que el graficador ya hace
   (parámetros animables con deslizador, los comandos de arriba).
Sé honesto en los dos sentidos: no inventes mejoras para temas que el graficador ya enseña bien (por ejemplo, una
derivada y su recta tangente), ni te conformes con el graficador en temas cuya esencia no es una función (por
ejemplo, las fases de la mitosis).
${bloqueIdioma(idioma)}
Respondé llamando a la herramienta, completando los campos en orden.`,
    prompt: `Materia: ${materia}\nTema: ${tema}`,
  };
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
Respondé llamando a la herramienta: PRIMERO el campo "analisis" y DESPUÉS {"formulas": [{"formula": "string"}, ...]}
(o "necesitaHerramienta" en lugar de "formulas" si el tema no se enseña bien con este graficador).

${CRITERIO_REPRESENTACION_VISUAL}

CUÁNTAS: elegí entre 1 y ${MAX_FORMULAS_VISUAL} fórmulas, según lo que el tema realmente necesite.
- Si el tema se entiende con una sola curva o superficie, devolvé UNA. No agregues fórmulas de relleno.
- Si el tema se entiende mejor comparando (ej: una función y su derivada, distintos casos de un parámetro
  con significado, función e inversa), devolvé las que hagan falta para esa comparación.
- La primera es la principal. Las demás tienen que aportar algo distinto Y con un papel que puedas nombrar en
  el tema (la función y su derivada; el caso con a>0 y el caso con a<0): nunca repitas una fórmula, ni
  devuelvas variantes triviales de la misma (ej: "sin(x)" y "1*sin(x)"), ni múltiplos arbitrarios de la misma
  curva que solo cambian la escala (ej: "x", "2*x" y "0.5*x").
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
4) EULER (comando "euler(ángulo)", solo 2D): dibuja la fórmula de Euler en el plano complejo -- el círculo
   unidad y una flecha desde el origen hasta e^(i*ángulo) = cos(ángulo) + i*sin(ángulo), con sus
   proyecciones sobre los ejes y el paso "+1". Usalo SOLO cuando el tema trate de la fórmula/identidad de
   Euler, la forma polar o exponencial de un número complejo, o las raíces de la unidad (el círculo unidad
   en el plano complejo) -- no para cualquier tema de trigonometría. El ángulo va en radianes: usá una
   constante (ej. "euler(pi)" muestra la identidad e^(i*pi)+1=0) o UNA letra suelta como parámetro animable
   para que el alumno lo mueva (ej. "euler(t)", arranca en 1 rad). Adentro de euler() NO se puede usar x, y,
   z, u ni v. Va una sola vez por lista, y se puede sumar a curvas 2D (ej. {"formulas": [{"formula":
   "euler(t)"}]}) pero nunca a paramétricas ni superficies 3D.

REGLA DURA sobre el contenido de cada "formula" (no es LaTeX, es una expresión que un parser simple tiene
que poder evaluar tal cual), aplica a las tres partes de cualquiera de los tres primeros formatos de arriba
(en euler(...) el ángulo sigue las mismas reglas de expresión: números, pi, e, operadores y funciones):
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
Ejemplo de tema comparativo (una función y su derivada): {"formulas": [{"formula": "x^2"}, {"formula": "2*x"}]}.

SI NINGUNA FÓRMULA REPRESENTA BIEN EL TEMA: antes de forzar algo que no queda bien, tené en cuenta que
visual.js (el frontend) ya soporta bastante más que estas fórmulas -- este catálogo completo:
${CAPACIDADES_VISUAL_JS_COMPLETAS}
Importante: VOS solo podés emitir "formulas" en los 4 formatos de arriba (explícita, implícita, paramétrica y
euler(...)) -- no podés emitir ninguno de estos otros comandos (Circle, tangent, area, riemann, taylor, field,
matrix, Surface, etc.), aunque el frontend ya los tenga. Si el tema se resolvería con uno de ESOS comandos, o si ni con todo este catálogo alcanza (haría
falta una función nueva en visual.js o una herramienta externa aparte), NO inventes una fórmula forzada que
no muestre bien el tema: llamá a la herramienta con "necesitaHerramienta" en vez de "formulas", explicando
qué se quería graficar, por qué no alcanza lo disponible, y qué haría falta. Usalo cuando la PRUEBA DEL
ALUMNO falle (ver arriba): un gráfico genérico que solo vos sabés interpretar es peor que reservar el tema.
No lo uses para evitar pensar la fórmula cuando el tema SÍ se grafica bien: los temas donde la función o la
relación matemática ES la lección (funciones, cálculo, trigonometría, cónicas, números complejos,
distribuciones) se resuelven con una fórmula normal.
No agregues texto fuera de la llamada a la herramienta.`,
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
- Comando euler(ángulo), solo 2D: fórmula de Euler en el plano complejo (círculo unidad y flecha a
  e^(i*ángulo)), ej. "euler(t)" o "euler(pi)". Es válido tal cual: NO lo reescribas como otra cosa ni lo
  conviertas a una explícita. El ángulo va en radianes (una constante o UNA letra suelta como parámetro
  animable) y no puede usar x, y, z, u ni v. Va una sola vez y nunca junto a paramétricas o superficies 3D.
En cualquiera de los tres primeros, solo puede usar: números, las variables de ese formato (x/y en explícita; x/y/z
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
- Comando euler(ángulo), solo 2D: fórmula de Euler en el plano complejo (círculo unidad y flecha a
  e^(i*ángulo)), ej. "euler(t)" o "euler(pi)". Es válido tal cual: NO lo reescribas como otra cosa ni lo
  conviertas a una explícita. El ángulo va en radianes (una constante o UNA letra suelta como parámetro
  animable) y no puede usar x, y, z, u ni v. Va una sola vez y nunca junto a paramétricas o superficies 3D.
En cualquiera de los tres primeros, solo puede usar: números, las variables de ese formato (x/y en explícita; x/y/z
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

REVISIÓN MATEMÁTICA (es tu tarea principal; la gramática de arriba es secundaria). Sos el revisor de la LÓGICA
MATEMÁTICA: otro asistente eligió qué mostrar y un juez ya aprobó que esa idea enseña el tema, así que NO cambies
la intención pedagógica ni quites ni reemplaces fórmulas por otras ideas. Verificás que cada fórmula sea
matemáticamente correcta. Antes de devolver las fórmulas, completá "revision_matematica" con UNA fila por fórmula
(mismo orden). Para cada una:
1. "relacion_prevista": decí qué relación del tema debería representar (ej. densidad normal estándar,
   exp(-x^2/2)/sqrt(2*pi)).
2. Re-derivala DESDE CERO con tu propio cálculo, sin asumir que está bien: constantes de normalización, signos,
   exponentes, el dominio (que no quede indefinida justo donde importa), y que sea la función o la curva COMPLETA que
   corresponde (ej. una circunferencia implícita en vez de una raíz que muestra media circunferencia).
3. "comprobacion": calculá a mano 2 o 3 valores concretos y anotalos (ej. "en x=0 da 0.399; en x=±1 da 0.242").
   Verificá además que la parte importante se vea en x,y∈[-10,10]: no aplastada contra un eje ni fuera de pantalla.
4. "resultado": "correcta" si la dejás IGUAL; "corregida" si encontraste un error y la cambiaste. No retoques por
   gusto una fórmula que ya está bien.
${bloqueIdioma(idioma)}
Guardá la revisión y las fórmulas visuales revisadas con la herramienta.`,
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
