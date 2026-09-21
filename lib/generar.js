import { llamarIA as llamarClaude, esErrorDeCreditoAnthropic } from "./claude.js";
import { llamarIA as llamarMistral, esErrorDeCreditoMistral } from "./mistral.js";
import {
  armarPromptClaude,
  armarPromptMistral,
  armarPromptCorreccionFable,
  armarToolClaude,
  armarToolCorreccion,
} from "../prompts/prompts.js";
import { validarPreguntas, validarFormulas, validarVisual } from "./validarEstructura.js";
import { leerJSON, escribirJSON, borrarJSON, keyPractice, keyExam, keyFormulas, keyVisual, keyVisualLater } from "./kv.js";
import { slugify } from "./slugify.js";

// 16000 alcanzaba para 60 preguntas (6 modelos x 10, caso de practice).
// exam pide 6 modelos x 12 = 72 preguntas. El salto 16000->20000 (+25%
// contra un +20% de preguntas) NO alcanzó en producción con temas con
// LaTeX (ver logs del 2026-08-17: 3/3 intentos de "Cálculo / Derivadas"
// volvieron con "modelos" vacío o faltante -- el tool_use se corta a
// mitad del schema antes de cerrar el array, así que la validación ve
// el JSON incompleto). Subir esto todavía es una estimación, no una
// medición: no se pudo probar con la API real desde este entorno para
// confirmar el output_tokens real que usa un examen de Derivadas.
//
// Cálculo (conservador, no medido): ~150 tokens/pregunta en JSON plano
// (enunciado + 4 opciones + explicación) + ~50% extra por LaTeX pesado
// en enunciado y 2-4 opciones (derivadas casi siempre trae \frac, \left,
// \right, etc.) = ~225 tokens/pregunta en el peor caso. 72 x 225 =
// ~16200 solo de contenido -- lo cual en teoría ya entraba en 20000, así
// que el techo real probablemente esté en la VARIANZA entre modelos
// (uno más largo que el resto) y no en el promedio. Por eso el número
// nuevo deja bastante más margen que un simple "+20% otra vez", en vez
// de repetir el mismo tipo de ajuste que ya falló una vez.
//
// Ver el log "[generar-json] exam: intento N -- stop_reason=... output_tokens=..."
// en claude.js: la próxima corrida real muestra si 28000 alcanza. Si
// vuelve a fallar con stop_reason "max_tokens", subir de nuevo con ese
// dato real en vez de otra estimación.
const MAX_TOKENS_PREGUNTAS_POR_TIPO = {
  practice: 16000, // 60 preguntas (6x10) -- funcionando, no tocar
  exam: 28000,      // 72 preguntas (6x12) + margen amplio para LaTeX, sin medir todavía
};
const MAX_TOKENS_FORMULAS = 4000;
// El visual.json lleva de 1 a MAX_FORMULAS_VISUAL (6) expresiones cortas
// (ideal <60 caracteres cada una, tope duro de 400 -- ver formulaSegura.js),
// muchísimo más chico que el LaTeX de MAX_TOKENS_FORMULAS. El peor caso
// teórico (6 x 400 chars) ronda los 1200 tokens, así que 2500 deja margen
// amplio; en la práctica se usan ~200. No está medido en producción todavía.
const MAX_TOKENS_VISUAL = 2500;

// Versión de "herramientas disponibles" para el generador de "visual" --
// se le pega como etiqueta (campo herramienta_version) a cada marca de
// "sin cobertura" que se escribe (ver más abajo y kv.js). Sirve para 2
// cosas:
//   1) El frontend/panel admin puede comparar esta etiqueta contra la
//      versión con la que se generó cada marca vieja, y mostrar (o no)
//      un botón de "generar con IA" para ese tema puntual -- ver la nota
//      de "botón de generar" más abajo, en generarUnTipo().
//   2) Este mismo service usa la comparación para NO bloquear como
//      "ya existe" una marca vieja (ver el chequeo de `existente` en
//      generarUnTipo): si version_actual != version_de_la_marca, se
//      reintenta la generación en vez de asumir que sigue sin solución.
// Subir este número (a mano, en Render) cuando se agrega una herramienta
// nueva (comando en visual.js, o algo externo) que resuelve casos que
// antes caían en "necesitaHerramienta" -- así los temas marcados con la
// versión vieja vuelven a intentarse solos la próxima vez que se pidan.
// Default "v0.1" si no está seteada (no se agregó a REQUERIDAS en
// lib/validarEnv.js por eso mismo, mismo criterio que IDIOMA).
const VERSION_HERRAMIENTAS_VISUAL = process.env.VERSION_HERRAMIENTAS_VISUAL || "v0.1";

// TTL del lock "generación en curso", en segundos. Tiene que alcanzar
// para las 2 llamadas de IA (Claude + Mistral) de un tipo con margen;
// si el proceso se cuelga a mitad de camino, pasado este tiempo la key
// expira sola y un request posterior puede reintentar en vez de quedar
// bloqueado para siempre.
const TTL_LOCK_SEGUNDOS = 600; // 10 min

// Reintentos para el borrador de Claude. Con tool use forzado (ver
// armarToolClaude en prompts.js) el JSON mal formado ya no debería
// pasar, pero se deja este margen para otros motivos de fallo
// transitorio (network, 5xx, sobrecarga puntual del modelo, o que
// igual no cumpla la validación semántica de validarEstructura.js).
const MAX_INTENTOS_BORRADOR = 3;

// Modelo de Claude a usar para el borrador, por tipo -- un tipo sin
// entry acá usa el default de claude.js (ahora Opus 4.8, ver
// lib/claude.js). El mismo tipo que tiene override acá TAMBIÉN usa ese
// modelo (con Mistral como fallback, no como corrector principal) para
// el paso de CORRECCIÓN, en vez de Mistral solo -- ver la rama
// `if (MODELO_CLAUDE_POR_TIPO[tipo])` más abajo en generarUnTipo().
//
// Los tres tipos usan Opus 4.8 (antes: exam en Fable, practice/formula
// en Haiku). Se subió todo a Opus a pedido explícito de priorizar
// calidad sobre costo -- el contenido es matemática/símbolos, donde
// modelos más chicos cometen más errores. La auditoría manual de un
// examen real (2026-08-17) ya había encontrado 4 preguntas con errores
// matemáticos que la corrección de Mistral -- con su prompt genérico de
// "revisá que esté bien" -- no atrapó; el prompt de re-derivación
// explícita (armarPromptCorreccionFable en prompts.js) sigue siendo el
// que corre acá, solo que ahora con Opus en vez de Fable.
const MODELO_CLAUDE_POR_TIPO = {
  practice: "claude-opus-4-8",
  exam: "claude-opus-4-8",
  formula: "claude-opus-4-8",
  visual: "claude-opus-4-8",
};

function validar(tipo, data) {
  if (tipo === "formula") return validarFormulas(data);
  if (tipo === "visual") return validarVisual(data);
  return validarPreguntas(data);
}

function keyPara(tipo, slugMateria, slugTema, slugTemaCanonico, idioma) {
  if (tipo === "practice") return keyPractice(slugMateria, slugTema, slugTemaCanonico, idioma);
  if (tipo === "exam") return keyExam(slugMateria, slugTema, slugTemaCanonico, idioma);
  if (tipo === "visual") return keyVisual(slugMateria, slugTema, slugTemaCanonico, idioma);
  return keyFormulas(slugMateria, slugTema, slugTemaCanonico, idioma);
}

/**
 * Intenta corregir el borrador con Mistral. Devuelve el JSON corregido
 * si la llamada sale bien Y pasa validarEstructura.js -- si cualquiera
 * de las dos cosas falla, devuelve null en vez de tirar. null le dice
 * al caller "seguí sin esta corrección": este es siempre el intento de
 * fallback después de Opus (ver MODELO_CLAUDE_POR_TIPO, hoy aplica a
 * los tres tipos), y si también falla, se queda con el borrador tal
 * cual.
 */
async function intentarCorregirConMistral(tipo, borrador, maxTokens, idioma) {
  const { system: sysCorregir, prompt: promptCorregir } = armarPromptMistral(tipo, borrador, idioma);
  try {
    const corregido = await llamarMistral({ system: sysCorregir, prompt: promptCorregir, parseJson: true, maxTokens });
    const validacion = validar(tipo, corregido);
    if (validacion.ok) return corregido;
    console.warn(
      `[generar-json] ${tipo}: la corrección de Mistral no tiene la forma esperada:\n  - ${validacion.errores.join("\n  - ")}`
    );
  } catch (err) {
    if (esErrorDeCreditoMistral(err)) {
      console.warn(`[generar-json] ${tipo}: Mistral sin crédito/cuota (${err.message.slice(0, 200)})`);
    } else {
      console.warn(`[generar-json] ${tipo}: Mistral falló (${err.message.slice(0, 200)})`);
    }
  }
  return null;
}

/**
 * Intenta corregir el borrador con Opus, con tool_choice forzado
 * (armarToolCorreccion) igual que en el borrador -- así la corrección
 * también viene garantizada con la forma del schema, no como texto
 * libre a parsear. Mismo contrato que intentarCorregirConMistral:
 * devuelve null en vez de tirar, para que el caller pueda caer a
 * Mistral como fallback sin duplicar try/catch. Se llama para los tres
 * tipos (ver MODELO_CLAUDE_POR_TIPO).
 */
async function intentarCorregirConOpus(tipo, borrador, maxTokens, idioma) {
  const { system: sysCorregir, prompt: promptCorregir } = armarPromptCorreccionFable(tipo, borrador, idioma);
  const toolCorregir = armarToolCorreccion(tipo);
  try {
    const corregido = await llamarClaude({
      system: sysCorregir,
      prompt: promptCorregir,
      model: MODELO_CLAUDE_POR_TIPO[tipo],
      maxTokens,
      tool: toolCorregir,
    });
    const validacion = validar(tipo, corregido);
    if (validacion.ok) return corregido;
    console.warn(
      `[generar-json] ${tipo}: la corrección de Opus no tiene la forma esperada:\n  - ${validacion.errores.join("\n  - ")}`
    );
  } catch (err) {
    if (esErrorDeCreditoAnthropic(err)) {
      console.warn(`[generar-json] ${tipo}: Opus sin crédito/cuota (${err.message.slice(0, 200)})`);
    } else {
      console.warn(`[generar-json] ${tipo}: Opus falló (${err.message.slice(0, 200)})`);
    }
  }
  return null;
}

/**
 * Corre el flujo para UN tipo de JSON (practice, exam, o formula):
 * chequea si la key ya existe en KV -> reserva la key (lock) -> Claude
 * (Opus 4.8 para los tres tipos -- ver MODELO_CLAUDE_POR_TIPO) crea el
 * borrador -> valida forma -> se corrige -> valida forma de nuevo ->
 * guarda el resultado final en KV (pisando el lock).
 *
 * El corrector es el mismo para los tres tipos: Opus primero
 * (intentarCorregirConOpus, con el prompt de re-derivación explícita)
 * y Mistral como fallback SOLO si Opus falla o no valida -- nunca los
 * dos a la vez, y nunca Mistral como corrector principal.
 *
 * El chequeo + la reserva pasan ANTES de llamar a ninguna IA: así, si
 * llegan dos requests para el mismo materia+tema (doble click, retry
 * por timeout del caller, etc.), el segundo ve la key ya ocupada y
 * corta ahí -- no vuelve a gastar llamadas de IA ni pisa en KV lo que
 * el primero ya guardó.
 *
 * Nota: Cloudflare KV es eventualmente consistente entre edge
 * locations, así que esto no es un lock perfecto para requests que
 * llegan literalmente al mismo milisegundo -- pero cubre el caso real
 * (doble click, retry de un caller con timeout), que es lo que estaba
 * pasando.
 *
 * Si el borrador no valida, NO se intenta corregir (no tiene sentido
 * corregir algo con la forma rota) -- se corta ahí con error (y se
 * libera el lock, ver abajo). Si la corrección falla entera (Opus Y
 * Mistral), se sigue adelante con el borrador tal cual (ya validado),
 * en vez de abortar el job entero.
 */
async function generarUnTipo(tipo, materia, tema, temaCanonico, idioma = "es") {
  const slugMateria = slugify(materia);
  const slugTema = slugify(tema);
  // slugTemaCanonico (opcional): ver nota "IDIOMA Y SLUG DE TEMA
  // CANÓNICO" en generarYGuardarJSON -- si el llamador lo manda, la key
  // se arma con ESE slug en vez de derivarlo de `tema` (título en
  // idioma local), para que el mismo tema conceptual en dos idiomas
  // distintos arme la misma key salvo por el sufijo de idioma.
  const slugTemaCanonico = temaCanonico ? slugify(temaCanonico) : undefined;
  const key = keyPara(tipo, slugMateria, slugTema, slugTemaCanonico, idioma);

  const existente = await leerJSON(key, tipo);
  // true si lo que hay en la key es una marca de "sin cobertura" de versión
  // vieja que vamos a reintentar. En ese caso NO reservamos el lock ni
  // borramos la key si algo falla (ver más abajo): la marca vieja se queda
  // intacta hasta que el resultado nuevo esté listo para pisarla.
  let reintentandoMarcaVieja = false;
  if (existente) {
    if (existente._enGeneracion) {
      console.log(`[generar-json] ${tipo}: ya se está generando en otro request (${key}), no arranco de nuevo`);
      return { tipo, slugMateria, slugTema, key, generado: false };
    }
    // Caso especial de "visual": si lo guardado es una marca de "sin
    // cobertura" (ver la rama de necesitaHerramienta más abajo) escrita
    // con una VERSIÓN de herramientas vieja (ver VERSION_HERRAMIENTAS_VISUAL
    // más arriba), no la tratamos como "ya existe" -- puede que la
    // herramienta que hacía falta ya se haya construido, así que se deja
    // pasar para reintentar la generación en vez de bloquear para
    // siempre. Si la versión coincide (ya se reintentó con la actual y
    // volvió a fallar, o nunca cambió desde que se marcó), se bloquea
    // igual que cualquier otro "ya existe" de más abajo.
    const marcaSinCoberturaVieja = tipo === "visual" && existente._sinCobertura === true
      && existente.herramienta_version !== VERSION_HERRAMIENTAS_VISUAL;
    if (!marcaSinCoberturaVieja) {
      console.log(`[generar-json] ${tipo}: ya existe en KV (${key}), no se regenera`);
      return { tipo, slugMateria, slugTema, key, generado: false };
    }
    reintentandoMarcaVieja = true;
    console.log(`[generar-json] visual: marca de "sin cobertura" de versión vieja (${existente.herramienta_version} != ${VERSION_HERRAMIENTAS_VISUAL}) en (${key}), reintentando`);
  }

  // Reservamos la key ANTES de llamar a las IAs -- ver nota arriba.
  //
  // EXCEPCIÓN: si estamos reintentando una marca de "sin cobertura" vieja,
  // NO reservamos. El lock y la marca viven en la MISMA key, así que
  // reservar pisaría la marca, y si la generación fallara el catch de más
  // abajo borraría la key entera -- el tema quedaría sin marca y sin
  // fórmulas. Sin lock, la marca vieja sigue en pie mientras se genera, y
  // solo se pisa al final con el resultado ya listo (escribirJSON del
  // final, o la marca reescrita en la rama de necesitaHerramienta).
  // Costo aceptado: dos pedidos simultáneos del mismo tema marcado podrían
  // correr a la vez (se gasta una llamada de IA de más; gana el último en
  // escribir). El reintento de marcas es manual y puntual, así que el
  // riesgo es chico.
  if (!reintentandoMarcaVieja) {
    await escribirJSON(
      key,
      { _enGeneracion: true, iniciadoEn: new Date().toISOString() },
      tipo,
      { ttlSegundos: TTL_LOCK_SEGUNDOS }
    );
  }

  try {
    const { system: sysCrear, prompt: promptCrear } = armarPromptClaude(tipo, materia, tema, idioma);
    const toolCrear = armarToolClaude(tipo);
    const maxTokens = tipo === "formula" ? MAX_TOKENS_FORMULAS
      : tipo === "visual" ? MAX_TOKENS_VISUAL
      : (MAX_TOKENS_PREGUNTAS_POR_TIPO[tipo] ?? 16000);

    // Reintenta el borrador hasta MAX_INTENTOS_BORRADOR veces. Con tool
    // use forzado, la API ya garantiza JSON sintácticamente válido y
    // con la forma del schema -- este loop cubre fallos transitorios
    // (red, 5xx/sobrecarga) o el caso residual de que el contenido no
    // pase validarEstructura.js (schema correcto pero, por ejemplo,
    // una opción vacía).
    let borrador;
    let ultimoError;
    for (let intento = 1; intento <= MAX_INTENTOS_BORRADOR; intento++) {
      console.log(`[generar-json] ${tipo}: Claude arma el borrador (${materia} / ${tema}), intento ${intento}/${MAX_INTENTOS_BORRADOR}`);
      try {
        const candidato = await llamarClaude({
          system: sysCrear,
          prompt: promptCrear,
          model: MODELO_CLAUDE_POR_TIPO[tipo],
          maxTokens,
          tool: toolCrear,
        });
        const validacionCandidato = validar(tipo, candidato);
        if (validacionCandidato.ok) {
          borrador = candidato;
          break;
        }
        ultimoError = new Error(
          `el borrador de Claude no tiene la forma esperada:\n  - ${validacionCandidato.errores.join("\n  - ")}`
        );
        console.warn(`[generar-json] ${tipo}: intento ${intento} inválido (${ultimoError.message}), reintentando...`);
      } catch (err) {
        ultimoError = err;
        console.warn(`[generar-json] ${tipo}: intento ${intento} falló (${err.message.slice(0, 200)}), reintentando...`);
      }
    }

    if (!borrador) {
      throw new Error(`[generar-json] ${tipo}: se agotaron los ${MAX_INTENTOS_BORRADOR} intentos del borrador. Último error: ${ultimoError?.message}`);
    }

    // Camino "no cobertura" (solo puede pasar en tipo "visual" -- ver
    // validarNecesitaHerramientaVisual en validarEstructura.js y
    // CAPACIDADES_VISUAL_JS_COMPLETAS en prompts.js): la IA decidió que ni
    // una fórmula simple ni ningún comando que ya tiene visual.js alcanza
    // para este tema. No hay nada matemático que corregir acá (es texto
    // explicativo, no una fórmula a re-derivar), así que se corta ANTES del
    // paso de corrección (Opus/Mistral) y del guardado normal de más abajo,
    // y se anota en 2 lugares en vez de guardar fórmulas:
    //   1) visual_later (namespace nuevo, ver lib/kv.js): el detalle
    //      completo -- qué se quería graficar, por qué no alcanza lo que
    //      ya existe, y qué herramienta haría falta (función nueva en
    //      visual.js, o algo aparte, ej. en Rust/C++ por rendimiento) --
    //      para poder construirla más adelante en vez de perder el caso.
    //   2) visual (namespace YA existente, MISMA key que usaría un
    //      visual.json normal): un marcador chico en vez de fórmulas, para
    //      que el frontend no reciba un default roto para este tema, y
    //      para que el chequeo de "ya existe en KV" de arriba frene un
    //      reintento futuro sin gastar otra llamada de IA en el mismo
    //      tema. Si más adelante se construye la herramienta que hacía
    //      falta, NO hace falta borrar nada a mano: se sube
    //      VERSION_HERRAMIENTAS_VISUAL y la próxima vez que se pida este
    //      tema, el chequeo de "ya existe" de arriba deja pasar la marca
    //      vieja y se reintenta. Si ahora sí se puede graficar, el
    //      escribirJSON del final PISA esta key con las fórmulas nuevas.
    //      Si sigue sin poder, se reescribe la marca con la versión
    //      actual. visual_later nunca se borra desde acá (queda como
    //      historial). Esta key no tiene TTL, no es un lock.
    if (tipo === "visual" && borrador.necesitaHerramienta) {
      const { tema: temaDeseado, motivo, herramienta_sugerida: herramientaSugerida } = borrador.necesitaHerramienta;
      const keyLater = keyVisualLater(slugMateria, slugTema, slugTemaCanonico, idioma);
      console.log(`[generar-json] visual: sin cobertura para "${materia} / ${tema}" -- anotando en visual_later (${keyLater})`);

      await escribirJSON(
        keyLater,
        {
          materia,
          tema,
          idioma,
          tema_deseado: temaDeseado,
          motivo,
          herramienta_sugerida: herramientaSugerida,
          herramienta_version: VERSION_HERRAMIENTAS_VISUAL,
          anotadoEn: new Date().toISOString(),
        },
        "visual_later",
        { idioma }
      );

      await escribirJSON(
        key,
        {
          _sinCobertura: true,
          motivo,
          verEn: "visual_later",
          herramienta_version: VERSION_HERRAMIENTAS_VISUAL,
          anotadoEn: new Date().toISOString(),
        },
        tipo,
        { idioma }
      );

      return { tipo, slugMateria, slugTema, key, generado: false, sinCobertura: true, keyVisualLater: keyLater };
    }

    let final = borrador;

    if (MODELO_CLAUDE_POR_TIPO[tipo]) {
      // Los tres tipos tienen override hoy: Opus corrige primero --
      // mismo modelo que armó el borrador, con tool_choice forzado y un
      // prompt que pide re-derivar cada función en vez de solo juzgar
      // si el texto suena coherente (ver armarPromptCorreccionFable).
      // Si Opus falla o no valida, Mistral entra como fallback -- no
      // como corrector principal -- y si Mistral TAMBIÉN falla, se
      // guarda el borrador sin corregir (mismo criterio de siempre:
      // nunca se pierde el job entero por un fallo en el paso de
      // corrección).
      console.log(`[generar-json] ${tipo}: Opus corrige el borrador`);
      const corregidoOpus = await intentarCorregirConOpus(tipo, borrador, maxTokens, idioma);
      if (corregidoOpus) {
        final = corregidoOpus;
      } else {
        console.warn(`[generar-json] ${tipo}: Opus no corrigió, pruebo con Mistral como fallback`);
        const corregidoMistral = await intentarCorregirConMistral(tipo, borrador, maxTokens, idioma);
        if (corregidoMistral) {
          final = corregidoMistral;
        } else {
          console.warn(`[generar-json] ${tipo}: Mistral tampoco corrigió, me quedo con el borrador sin corregir`);
        }
      }
    } else {
      // Rama de respaldo por si algún tipo futuro queda sin override en
      // MODELO_CLAUDE_POR_TIPO: Mistral como único corrector.
      console.log(`[generar-json] ${tipo}: Mistral corrige el borrador`);
      const corregidoMistral = await intentarCorregirConMistral(tipo, borrador, maxTokens, idioma);
      if (corregidoMistral) {
        final = corregidoMistral;
      } else {
        console.warn(`[generar-json] ${tipo}: Mistral no corrigió, me quedo con el borrador de Claude sin corregir`);
      }
    }

    console.log(`[generar-json] ${tipo}: guardando en KV (${key})`);
    await escribirJSON(key, final, tipo, { idioma });

    return { tipo, slugMateria, slugTema, key, generado: true };
  } catch (err) {
    // Liberamos el lock para que un retry posterior no tenga que
    // esperar los TTL_LOCK_SEGUNDOS -- best-effort, si el borrado
    // falla el TTL lo limpia igual más tarde.
    //
    // Si estábamos reintentando una marca vieja NO hay lock nuestro que
    // liberar (no lo reservamos), y borrar la key destruiría la marca
    // vieja que justamente queríamos conservar. No tocamos nada.
    if (reintentandoMarcaVieja) {
      console.warn(`[generar-json] ${tipo}: el reintento de la marca vieja falló, la marca de (${key}) queda intacta`);
    } else {
      try {
        await borrarJSON(key, tipo);
      } catch (errBorrado) {
        console.warn(`[generar-json] ${tipo}: no pude liberar el lock (${key}) después del error: ${errBorrado.message}`);
      }
    }
    throw err;
  }
}

/**
 * Genera practice.json y exam.json para un tema (y opcionalmente
 * formula.json). tipos: array con los tipos a generar, default
 * ["practice", "exam"].
 *
 * Si uno de los tipos falla (Claude caído, borrador irrecuperable,
 * etc.), NO frena a los demás -- se juntan los resultados y errores de
 * todos, así un fallo puntual en "exam" no te hace perder el "practice"
 * que sí salió bien.
 *
 * `temaCanonico` (opcional, agregado -- ver
 * ANALISIS-idioma-generador-json.md, punto 1 "IDIOMA Y SLUG DE TEMA
 * CANÓNICO"): si el llamador (generador-service-main) ya resolvió este
 * tema contra el índice canónico (español) y sabe cuál es su título/slug
 * ahí, lo manda acá para que la key de KV se arme con ESE slug en vez de
 * `slugify(tema)` (título en el idioma local). Sin esto, el mismo tema
 * conceptual generado en dos idiomas distintos arma dos keys sin
 * relación entre sí (slugify("Stoichiometry") !== slugify("Estequiometría")).
 * Si no se pasa (caso por defecto, mientras generador-service-main no
 * mande este dato todavía), el comportamiento es idéntico al de antes:
 * la key sale de slugify(tema) tal cual.
 *
 * `idioma` (opcional, default "es"): idioma destino del contenido. Ya
 * no sale de process.env.IDIOMA -- esta instancia no tiene idioma fijo
 * propio, lo manda generador-service-main en cada request (mismo tema,
 * mismo idioma con el que generó la teoría).
 *
 * "visual" (fórmula default del graficador interactivo, ver
 * lib/formulaSegura.js) NO entra en el default de `tipos` a propósito --
 * a diferencia de practice/exam/formula, no es algo que se necesite para
 * cada tema existente de una, así que solo se genera si se pide
 * explícitamente en el array.
 */
export async function generarYGuardarJSON({ materia, tema, tipos = ["formula"], temaCanonico, idioma = "es" }) {
  if (!materia || !tema) {
    throw new Error("Faltan materia o tema");
  }

  const resultados = [];
  const errores = [];

  for (const tipo of tipos) {
    try {
      const resultado = await generarUnTipo(tipo, materia, tema, temaCanonico, idioma);
      resultados.push(resultado);
    } catch (err) {
      console.error(`[generar-json] ${tipo} falló:`, err.message);
      errores.push({ tipo, error: err.message });
    }
  }

  return {
    ok: errores.length === 0,
    slugMateria: slugify(materia),
    slugTema: temaCanonico ? slugify(temaCanonico) : slugify(tema),
    resultados,
    errores: errores.length > 0 ? errores : null,
  };
}

/**
 * Detecta si algún error del pipeline es por falta de crédito/cuota en
 * cualquiera de las dos IAs -- usado por server.js para loguear distinto
 * (no es un bug, es un tema de facturación).
 */
export function esErrorDeCredito(err) {
  return esErrorDeCreditoAnthropic(err) || esErrorDeCreditoMistral(err);
}
