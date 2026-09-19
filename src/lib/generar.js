import { llamarIA as llamarIAMistral } from "./mistral.js";
import { llamarClaude as llamarIAClaude } from "./anthropic.js";
import { armarPromptIA3 } from "../prompts/ia3.js";
import { armarPromptIA4 } from "../prompts/ia4.js";
import { armarPromptVisual } from "../prompts/visual.js";
import { compilarTodo } from "./compile.js";
import { motorLatexPara } from "./idiomaCjk.js";
import { sanitizarTex, aplicarFixesDeterministas, detectarProblemasEstructurales, llavesBalanceadas } from "./sanitizar.js";
import { subirCompilados } from "./upload.js";
import { agregarTemaAMateria } from "./actualizarJson.js";
import { dispararGeneradorJson } from "./generadorJson.js";
import { slugify } from "./slugify.js";

// Máximo de rondas de generación + revisión (ambas con Opus 4.8).
const MAX_RONDAS = 3;

/**
 * Detecta si un error de la API de Anthropic es "tolerable": falta de
 * crédito/cuota, o Claude simplemente no disponible por un problema de
 * clave. En cualquiera de estos casos no cortamos el flujo: seguimos con
 * el veredicto de Mistral (IA#4) sin segunda opinión, en vez de abortar
 * todo.
 *
 * Se exporta porque server.js también la usa para el fallback de Claude
 * en /clasificar y /aviso-tema-auto (clasificación de materia, no
 * generación de contenido, pero mismo criterio de tolerancia).
 */
export function esErrorDeCreditoAnthropic(err) {
  const msg = (err?.message || "").toLowerCase();
  return (
    msg.includes("credit balance") ||
    msg.includes("429") ||
    msg.includes("insufficient") ||
    msg.includes("quota") ||
    msg.includes("401") ||
    msg.includes("authentication_error") ||
    msg.includes("invalid x-api-key") ||
    msg.includes("permission_error") ||
    msg.includes("not_found_error")
  );
}

// Generador y revisor principal: Opus 4.8 (mejor razonamiento matemático
// disponible hoy en la familia Claude). Antes esto era Mistral; se cambió
// a pedido explícito de priorizar calidad sobre costo, dado que el
// contenido es matemática/símbolos donde los errores de un modelo más
// chico son costosos (rompen compilación o quedan mal en el PDF final).
async function generarConOpus(contexto, correcciones, texsPrevios = null) {
  const { system, prompt } = armarPromptIA3(contexto, correcciones, texsPrevios);
  return await llamarIAClaude({ system, prompt, model: "claude-opus-4-8", parseJson: true, maxTokens: 16000 });
}

async function revisarConMistral(contexto, texs) {
  const { system, prompt } = armarPromptIA4(contexto, texs);
  return await llamarIAClaude({ system, prompt, model: "claude-opus-4-8", parseJson: true, maxTokens: 4000 });
}

// Antes: Mistral revisaba (IA#4) y, si rechazaba, Claude daba una
// "segunda opinión" para filtrar rechazos cosméticos. Ahora que el
// revisor principal (revisarConMistral, arriba) ya es Opus 4.8, pedirle
// una segunda opinión a Opus sobre su propio rechazo no aporta nada
// (mismo modelo revisando su propio veredicto) -- se elimina ese paso.
// Fallback de emergencia si Opus falla por crédito/cuota: usamos Mistral
// una sola vez para no perder el job entero.
async function revisarConFallback(contexto, texs) {
  try {
    return await revisarConMistral(contexto, texs);
  } catch (err) {
    if (esErrorDeCreditoAnthropic(err)) {
      console.warn(`[generar] Opus sin crédito/cuota para revisión (${err.message.slice(0, 200)}), reviso con Mistral como fallback`);
      const { system, prompt } = armarPromptIA4(contexto, texs);
      return await llamarIAMistral({ system, prompt, parseJson: true, maxTokens: 4000 });
    }
    throw err;
  }
}

async function generarFigura(contexto, figura, moldePractica, tipo = "practica") {
  const { system, prompt } = armarPromptVisual(contexto, figura, moldePractica, tipo);

  let resultado;
  try {
    console.log(`[generar] figura${tipo === "teoria" ? " (teoría)" : ""}: probando con Claude (Opus)`);
    resultado = await llamarIAClaude({ system, prompt, model: "claude-opus-4-8", parseJson: true, maxTokens: 4000 });
  } catch (err) {
    if (!esErrorDeCreditoAnthropic(err)) throw err;
    console.warn(`[generar] figura: Claude sin crédito/cuota (${err.message.slice(0, 200)}), paso a Mistral`);
    try {
      resultado = await llamarIAMistral({ system, prompt, parseJson: true, maxTokens: 4000 });
    } catch (errMistral) {
      console.warn(`[generar] figura: Mistral también falló (${errMistral.message.slice(0, 200)}), sigo sin figura`);
      return null;
    }
  }

  return resultado;
}

function insertarFigura(practicaTex, resultadoFigura) {
  if (!resultadoFigura?.tikz) {
    console.warn("[generar] figura: no se pudo generar, se deja el recuadro vacío");
    return practicaTex.replace("%%FIGURA_AQUI%%", "% (figura no disponible)");
  }

  if (!llavesBalanceadas(resultadoFigura.tikz)) {
    console.warn(
      "[generar] figura: el tikz devuelto tiene llaves { } desbalanceadas " +
      "(probable JSON truncado y recuperado a medias), se descarta y se deja el recuadro vacío"
    );
    return practicaTex.replace("%%FIGURA_AQUI%%", "% (figura no disponible)");
  }

  let tex = practicaTex.replace("%%FIGURA_AQUI%%", resultadoFigura.tikz);

  const librerias = resultadoFigura.usaLibrerias || [];
  if (librerias.length > 0) {
    const linea = `\\usetikzlibrary{${librerias.join(",")}}`;
    tex = tex.replace("\\usepackage{tikz}", `\\usepackage{tikz}\n${linea}`);
  }

  return tex;
}

// Misma idea que insertarFigura, pero para la figura OPCIONAL de teoría
// (%%FIGURA_TEORIA_AQUI%% dentro de teoria_pdf_tex, ver reglasTeoria en
// prompts/visual.js). Como mucho una figura por teoría, así que a diferencia
// de práctica no hay que preocuparse por varias marcas en el mismo texto.
function insertarFiguraTeoria(teoriaPdfTex, resultadoFigura) {
  if (!resultadoFigura?.tikz) {
    console.warn("[generar] figura de teoría: no se pudo generar, se deja el placeholder comentado");
    return teoriaPdfTex.replace("%%FIGURA_TEORIA_AQUI%%", "% (figura no disponible)");
  }

  if (!llavesBalanceadas(resultadoFigura.tikz)) {
    console.warn(
      "[generar] figura de teoría: el tikz devuelto tiene llaves { } desbalanceadas " +
      "(probable JSON truncado y recuperado a medias), se descarta y se deja el placeholder comentado"
    );
    return teoriaPdfTex.replace("%%FIGURA_TEORIA_AQUI%%", "% (figura no disponible)");
  }

  let tex = teoriaPdfTex.replace("%%FIGURA_TEORIA_AQUI%%", resultadoFigura.tikz);

  const librerias = resultadoFigura.usaLibrerias || [];
  if (librerias.length > 0) {
    const linea = `\\usetikzlibrary{${librerias.join(",")}}`;
    tex = tex.replace("\\usepackage{tikz}", `\\usepackage{tikz}\n${linea}`);
  }

  return tex;
}

/**
 * Corre el flujo completo de generación para un tema ya validado:
 * genera (Opus 4.8) → revisa (Opus 4.8, con Mistral como fallback solo
 * si Opus falla por crédito/cuota) → figura (si aplica) → sanitiza →
 * compila → sube a R2 → actualiza el JSON de la materia en KV. Nunca
 * aborta por rechazo de revisión: intenta compilar igual tras MAX_RONDAS.
 *
 * Usado por /generar, /aviso-tema-auto y /crear-tema-callback.
 *
 * contexto = { materia, tema, moldePractica, notasIA2, materiaNuevaInfo }
 * materiaNuevaInfo es opcional: { titulo, grupo } cuando la materia todavía
 * no existe en materias.json. Pasar null (o no pasarlo) si la materia ya
 * existe seguro.
 *
 * Devuelve { ok, slug, aprobadoPorRevision, correccionesPendientes, temaYaExistiaEnJSON }
 */
export async function generarYPublicar(contexto) {
  const { materia, tema, materiaNuevaInfo } = contexto;
  const slug = slugify(tema);

  console.log(`[generar] arrancando: ${materia} / ${tema} (slug=${slug})`);

  let texs = null;
  let texsAnteriores = null;
  let correcciones = null;
  let aprobado = false;

  for (let ronda = 1; ronda <= MAX_RONDAS && !aprobado; ronda++) {
    console.log(
      `[generar] IA#3 (Opus), ronda ${ronda}/${MAX_RONDAS}` +
      (texsAnteriores ? " (con texto previo real, fix quirúrgico)" : " (desde cero)")
    );
    texs = await generarConOpus(contexto, correcciones, texsAnteriores);

    // Fixes deterministas y gratis (regex, sin llamar a ninguna IA) ANTES
    // de gastar en revisión: si esto ya arregla lo que iba a fallar, la
    // revisión paga ya no lo ve ni lo señala de nuevo. texsAnteriores queda
    // en la versión fixeada, así la próxima ronda tampoco parte de un texto
    // con un bug que ya se arregló gratis.
    const { texs: texsFixeados, cambios: cambiosDeterministas } = aplicarFixesDeterministas(texs);
    texs = texsFixeados;
    texsAnteriores = texs;
    if (cambiosDeterministas.length > 0) {
      console.log(`[generar] ronda ${ronda}: fixes deterministas aplicados (gratis):\n  - ${cambiosDeterministas.join("\n  - ")}`);
    }

    // Si después de los fixes gratis queda un desbalance real (\[ \], \( \)
    // o { } sin cerrar), ya sabemos que esta ronda va a ser rechazada por
    // un error de compilación -- no tiene sentido pagar Mistral (revisor) +
    // Claude (segunda opinión) para que nos digan lo mismo que esto detecta
    // gratis. Saltamos directo a la próxima regeneración con el problema
    // como corrección.
    const problemasEstructurales = detectarProblemasEstructurales(texs);
    if (problemasEstructurales.length > 0) {
      correcciones = problemasEstructurales.join("\n");
      console.warn(
        `[generar] ronda ${ronda}: quedó un problema estructural que ningún fix determinista puede ` +
        `arreglar solo, salteo la revisión paga en esta ronda:\n${correcciones}`
      );
      continue;
    }

    console.log(`[generar] IA#4 (Opus) revisando, ronda ${ronda}/${MAX_RONDAS}`);
    const revision = await revisarConFallback(contexto, texs);
    aprobado = revision.aprobado === true;
    correcciones = revision.correcciones;

    if (aprobado) {
      console.log(`[generar] IA#4 (Opus) aprobó en ronda ${ronda}`);
      break;
    }

    console.log(`[generar] IA#4 (Opus) rechazó: ${correcciones}`);
  }

  if (!aprobado) {
    console.warn(
      `[generar] agotadas las ${MAX_RONDAS} rondas sin aprobación, se intenta compilar igual. ` +
      `Correcciones pendientes: ${correcciones}`
    );
  }

  if (texs.figura && texs.practica_tex?.includes("%%FIGURA_AQUI%%")) {
    console.log(`[generar] generando figura (caso ${texs.figura.caso}): ${texs.figura.descripcion}`);
    const resultadoFigura = await generarFigura(contexto, texs.figura, contexto.moldePractica);
    texs.practica_tex = insertarFigura(texs.practica_tex, resultadoFigura);
  }

  if (texs.figuraTeoria && texs.teoria_pdf_tex?.includes("%%FIGURA_TEORIA_AQUI%%")) {
    console.log(`[generar] generando figura de teoría: ${texs.figuraTeoria.descripcion}`);
    const resultadoFiguraTeoria = await generarFigura(contexto, texs.figuraTeoria, contexto.moldePractica, "teoria");
    texs.teoria_pdf_tex = insertarFiguraTeoria(texs.teoria_pdf_tex, resultadoFiguraTeoria);
  } else if (texs.teoria_pdf_tex?.includes("%%FIGURA_TEORIA_AQUI%%")) {
    // IA#3 dejó el placeholder pero no mandó el campo "figuraTeoria" (no debería pasar,
    // pero si pasa no queremos que %%FIGURA_TEORIA_AQUI%% quede como texto literal en el PDF).
    console.warn("[generar] teoria_pdf_tex tenía %%FIGURA_TEORIA_AQUI%% sin campo figuraTeoria, se comenta el placeholder");
    texs.teoria_pdf_tex = texs.teoria_pdf_tex.replace("%%FIGURA_TEORIA_AQUI%%", "% (figura no disponible)");
  }

  console.log("[generar] sanitizando LaTeX (arreglos deterministas)");
  const { texs: texsSanitizados, cambios } = sanitizarTex(texs);
  if (cambios.length > 0) {
    console.log(`[generar] cambios aplicados:\n  - ${cambios.join("\n  - ")}`);
  }

  console.log(`[generar] compilando (${motorLatexPara(contexto.idioma)} + tex4ebook)`);
  const compilados = await compilarTodo(slug, texsSanitizados, contexto.idioma);

  console.log("[generar] subiendo al worker (default/)");
  await subirCompilados(slug, compilados, tema, contexto.idioma);

  console.log(`[generar] actualizando ${materia}.json en KV (idioma: ${contexto.idioma || "es"})`);
  const resultadoKV = await agregarTemaAMateria(materia, tema, materiaNuevaInfo || null, contexto.idioma);
  if (resultadoKV.materiaNueva) {
    console.log(`[generar] "${materia}" no estaba en materias.json, se agregó como materia nueva`);
  }
  if (resultadoKV.yaExistia) {
    console.warn(`[generar] el tema "${tema}" ya estaba en ${materia}.json, no se duplicó`);
  }

  // Fire-and-forget: no se espera (ver comentario en generadorJson.js).
  dispararGeneradorJson(materia, tema, contexto.idioma);

  console.log(`[generar] listo: ${slug}`);
  return {
    ok: true,
    slug,
    aprobadoPorRevision: aprobado,
    correccionesPendientes: aprobado ? null : correcciones,
    temaYaExistiaEnJSON: resultadoKV.yaExistia,
  };
}
