import express from "express";
import { llamarIA as llamarIAMistral } from "./lib/mistral.js";
import { llamarClaude as llamarIAClaude } from "./lib/anthropic.js";
import { armarPromptIA2 } from "./prompts/ia2.js";
import { armarPromptClasificar } from "./prompts/clasificar.js";
import { leerJSON, keyMaterias, keyMateria } from "./lib/kv.js";
import { slugify } from "./lib/slugify.js";
import { esErrorDeCreditoAnthropic } from "./lib/generar.js";
import { encolarYEsperar, encolarSinEsperar, iniciarCola } from "./lib/cola.js";
import { avisarCallback } from "./lib/callback.js";
import { validarEnv } from "./lib/validarEnv.js";
import { traducirTermino } from "./lib/traducir.js";

// Validar variables de entorno antes de hacer cualquier cosa
validarEnv();

const app = express();
app.use(express.json({ limit: "2mb" }));

// Auth simple entre el worker (o quien dispare esto) y este servicio
function chequearAuth(req, res) {
  const auth = req.headers.authorization || "";
  const token = auth.replace("Bearer ", "");
  if (token !== process.env.SERVICE_KEY) {
    res.status(401).json({ error: "No autorizado" });
    return false;
  }
  return true;
}

// (Se sacó leerMateriasCanonicas() -- leía el índice español para que
// una instancia no-española reutilizara sus ids de materia al proponer
// una materia nueva. Se decidió que el id de materia NO debe relacionar
// instancias de distinto idioma entre sí: cada instancia deriva su
// propio id de su propio título local, sin cruzarlo contra otro idioma.
// Ver la nota en prompts/clasificar.js.)

/**
 * FIX (temas válidos descartados por moldePractica=null): IA#2 corría
 * solo con Mistral, sin segunda opinión -- a diferencia del paso de
 * clasificar (más abajo), que si le pide una segunda opinión a Claude
 * cuando duda. En la práctica, para temas sin componente gráfica obvia
 * (ej. "teoría de Galois", álgebra abstracta pura) Mistral a veces
 * marca esValido=true y esDuplicado=false correctamente, pero no logra
 * decidir si el molde es "modelo1" o "modelo2" y devuelve null en ese
 * campo -- y /aviso-tema-auto tiraba todo el tema abajo por eso solo,
 * aunque ya estaba validado. /crear-tema-callback tenía el problema
 * inverso: pasaba moldePractica=null tal cual a la cola sin avisar, y
 * el default silencioso de los templates (ia3.js/visual.js, que caen a
 * practica_modelo2.tex con cualquier valor que no sea exactamente
 * "modelo1") terminaba decidiendo por nosotros sin que quedara
 * registrado en ningún lado.
 *
 * Este helper unifica el criterio en los dos endpoints: si Mistral no
 * resuelve moldePractica, se le pide el mismo prompt a Claude como
 * segunda opinión (mismo patrón que clasificar). Si Claude tampoco lo
 * resuelve (falla, sin crédito, o también null), en vez de descartar un
 * tema que ya pasó esValido/esDuplicado, usamos "modelo2" (figura
 * opcional) como default explícito y logueado: es la opción menos
 * exigente -- todos los ejercicios se pueden resolver solo con el
 * texto -- así que nunca deja a IA#3 sin poder generar la práctica.
 */
async function resolverMoldePractica(resultadoIA2, { system, prompt, termino, logPrefix }) {
  if (resultadoIA2?.moldePractica) return resultadoIA2.moldePractica;

  console.log(`${logPrefix}: "${termino}" IA#2 (Mistral) no devolvió moldePractica, pido segunda opinión a Claude`);
  try {
    const resultadoClaude = await llamarIAClaude({ system, prompt, parseJson: true, maxTokens: 1000 });
    if (resultadoClaude?.moldePractica) {
      console.log(`${logPrefix}: "${termino}" Claude sí resolvió moldePractica: ${resultadoClaude.moldePractica}`);
      return resultadoClaude.moldePractica;
    }
    console.warn(`${logPrefix}: "${termino}" Claude tampoco devolvió moldePractica, uso "modelo2" (figura opcional) por default`);
  } catch (err) {
    if (esErrorDeCreditoAnthropic(err)) {
      console.warn(`${logPrefix}: "${termino}" Claude sin crédito/cuota, uso "modelo2" por default`);
    } else {
      console.warn(`${logPrefix}: "${termino}" Claude falló (${err.message.slice(0, 200)}), uso "modelo2" por default`);
    }
  }
  return "modelo2";
}

app.post("/generar", async (req, res) => {
  if (!chequearAuth(req, res)) return;

  const contexto = { ...req.body, idioma: (req.body.idioma || "es").trim() }; // { materia, tema, moldePractica, notasIA2, idioma }
  const { materia, tema, moldePractica } = contexto;

  if (!materia || !tema || !moldePractica) {
    return res.status(400).json({ error: "Faltan materia, tema o moldePractica" });
  }

  try {
    // Encola detrás de la cola de generarYPublicar y espera el resultado
    // acá mismo (mismo contrato síncrono de siempre) -- ver src/lib/cola.js.
    const resultado = await encolarYEsperar(contexto);
    res.json(resultado);
  } catch (err) {
    console.error("[generar] error:", err);
    res.status(500).json({ error: err.message });
  }
});

// FIX (bug "todo cae en Sin clasificar fuera de español"): esto antes
// validaba el propio "grupo" (texto libre, YA traducido al idioma de la
// instancia por armarPromptClasificar) contra una lista fija en español.
// Resultado: en CUALQUIER instancia no-española, la IA devolvía "grupo"
// correctamente traducido (ej. "Applied sciences"), ese texto nunca
// matcheaba ninguno de los 3 strings españoles hardcodeados acá, "grupo"
// quedaba null, y como abajo se exige título+grupo para aceptar una
// materia nueva, la clasificación entera se descartaba -- la materia
// terminaba SIEMPRE con "materia: null" y caía en "Sin clasificar",
// nunca importa qué tan bien hubiera clasificado la IA.
//
// Ahora validamos "grupoClave" (ver prompts/clasificar.js): una clave
// FIJA en inglés que la IA nunca traduce, sin importar el idioma de la
// instancia. El texto human-readable "grupo" ya no se valida contra una
// lista -- se confía en él tal cual lo devolvió la IA (ya viene con
// instrucciones de redacción consistente en el prompt), solo se exige
// que no venga vacío.
const GRUPOS_CLAVE_VALIDAS = ["exactas", "aplicadas", "no_obvias"];

// Red de seguridad SOLO para compatibilidad hacia atrás: si por lo que
// sea la IA no mandó "grupoClave" (ej. un modelo de fallback que todavía
// no vio el prompt actualizado) pero "grupo" vino con uno de los 3
// strings españoles exactos de siempre, lo mapeamos igual en vez de
// descartar la clasificación. Fuera de español, si no vino grupoClave no
// hay forma confiable de inferir la clave desde texto libre traducido,
// así que en ese caso sí se descarta (mejor "Sin clasificar" ocasional
// que confiar en un match de texto que puede fallar en silencio).
const GRUPO_TEXTO_ES_A_CLAVE = {
  "Ciencias exactas": "exactas",
  "Ciencias aplicadas": "aplicadas",
  "Aplicaciones no obvias": "no_obvias",
};

/**
 * Normaliza y valida lo que devolvió la IA (Mistral o Claude) para
 * /clasificar, así el resto del endpoint no tiene que desconfiar del
 * shape del JSON en cada uso.
 *
 * OJO - caso "materia nueva sin id": cuando esNueva=true, la IA a veces
 * manda materia=null y solo un "titulo" prolijo (ej: "Combinatoria"),
 * esperando que nosotros derivemos el id (ej: "combinatoria"). Antes este
 * caso se descartaba entero apenas materia venía null, aunque titulo y
 * grupo fueran válidos - eso tiraba a la basura propuestas correctas de
 * materia nueva. Ahora, si esNueva=true y no vino "materia" pero sí un
 * titulo utilizable, derivamos el id con slugify(titulo) antes de seguir.
 *
 * Este id derivado por slugify SOLO se usa cuando la IA no devolvió un
 * "materia" ya elegido (ni local ni canónico, ver armarPromptClasificar) -
 * si el prompt tiene la lista de ids canónicos y la IA hizo bien su
 * trabajo, "materia" ya viene con el id canónico reutilizado y esta rama
 * ni se ejecuta.
 */
function normalizarResultadoClasificacion(resultado, materiasExistentes) {
  const esNueva = resultado?.esNueva === true;
  let materia = typeof resultado?.materia === "string" ? resultado.materia.trim() : null;
  const confianza = ["alta", "media", "baja"].includes(resultado?.confianza) ? resultado.confianza : "baja";

  if (!materia && esNueva) {
    const tituloParaId = typeof resultado?.titulo === "string" ? resultado.titulo.trim() : "";
    if (tituloParaId) {
      materia = slugify(tituloParaId).replace(/-/g, "_");
    }
  }

  if (!materia) {
    return { materia: null, esNueva: false, titulo: null, grupo: null, confianza };
  }

  if (!esNueva) {
    // Tiene que ser una materia que ya existe; si la IA "inventó" un id que
    // no está en la lista sin marcar esNueva, no confiamos en eso. Pero si
    // la IA se equivocó de flag (dijo esNueva=false para algo que en
    // realidad no existe todavía), no lo descartamos sin más: lo tratamos
    // como propuesta de materia nueva igual, con título de respaldo (el
    // propio id, ya que no tenemos un "titulo" prolijo en este caso) y
    // grupo "Sin clasificar", en vez de perder la clasificación entera.
    if (!materiasExistentes.includes(materia)) {
      return {
        materia,
        esNueva: true,
        titulo: null, // se usa el título de respaldo derivado del id, ver actualizarJson.js
        grupo: null,  // se usa "Sin clasificar", ver actualizarJson.js
        confianza: "media",
      };
    }
    return { materia, esNueva: false, titulo: null, grupo: null, confianza };
  }

  // esNueva=true: exigimos título y grupo válidos, si no, no es una
  // propuesta usable.
  const titulo = typeof resultado?.titulo === "string" && resultado.titulo.trim() ? resultado.titulo.trim() : null;
  const grupoTexto = typeof resultado?.grupo === "string" && resultado.grupo.trim() ? resultado.grupo.trim() : null;

  // grupoClave manda: si vino y es una de las 3 válidas, el texto en
  // "grupo" se acepta tal cual (ver comentario arriba de GRUPOS_CLAVE_VALIDAS).
  // Si no vino grupoClave, solo aceptamos el texto vía el fallback de
  // compatibilidad (strings españoles exactos).
  const grupoClave = GRUPOS_CLAVE_VALIDAS.includes(resultado?.grupoClave)
    ? resultado.grupoClave
    : (grupoTexto && GRUPO_TEXTO_ES_A_CLAVE[grupoTexto]) || null;

  const grupo = grupoClave ? grupoTexto : null;
  if (!titulo || !grupo) {
    return { materia: null, esNueva: false, titulo: null, grupo: null, confianza: "baja" };
  }
  return { materia, esNueva: true, titulo, grupo, confianza };
}

/**
 * POST /clasificar
 * Recibe { termino, idioma?, idiomaOrigen? } y devuelve a qué materia
 * pertenece probablemente: una que ya existe, o una materia nueva
 * propuesta (esNueva=true) si el término no encaja en ninguna de las
 * existentes pero es un tema real.
 *
 * idioma es el idioma DESTINO (ISO 2 letras) contra el que se clasifica
 * (decide qué materias.json/materia.json se lee); default "es" si no se
 * manda. Esta instancia ya no tiene un idioma fijo propio (antes salía de
 * process.env.IDIOMA) -- el Worker manda el idioma en cada request, así
 * cualquier instancia desplegada puede atender cualquier idioma.
 *
 * idiomaOrigen es opcional: si el llamador (Worker/frontend) sabe en qué
 * idioma estaba escrito el término originalmente, ayuda a traducirTermino()
 * a no tener que detectarlo por su cuenta. Ver lib/traducir.js.
 *
 * Costo: Mistral resuelve el caso normal (rápido y gratis/barato). Solo
 * si Mistral queda dudoso (confianza "media" o "baja") se pide una
 * segunda opinión a Claude, que es pago — así se lo usa lo menos posible.
 * Si Claude no está disponible (sin crédito, caído, etc.), nos quedamos
 * con el veredicto de Mistral tal cual, sin cortar el flujo.
 *
 * Devuelve { materia, esNueva, titulo, grupo, confianza }.
 * Si algo falla (Mistral caído, materias.json no existe, etc.) devuelve
 * materia=null en vez de 500, para no romper el flujo de aviso-tema que
 * lo llama: es una sugerencia, no algo crítico.
 */
app.post("/clasificar", async (req, res) => {
  if (!chequearAuth(req, res)) return;

  const { termino: terminoOriginal, idiomaOrigen, idioma: idiomaDestino } = req.body || {};
  if (!terminoOriginal || typeof terminoOriginal !== "string") {
    return res.status(400).json({ error: "Falta 'termino'" });
  }
  const idioma = (idiomaDestino || "es").trim();

  try {
    const termino = await traducirTermino(terminoOriginal, idioma, idiomaOrigen);
    const dataMaterias = await leerJSON(keyMaterias(idioma));
    const materias = Array.isArray(dataMaterias?.materias)
      ? dataMaterias.materias.map((m) => m.id).filter(Boolean)
      : [];

    const { system, prompt } = armarPromptClasificar(termino, materias, idioma);

    // ministral-8b-2512: más margen de rate (3.13 req/s vs 1 req/s de
    // mistral-small-latest) que clasificar necesita porque corre casi
    // pegado a traducirTermino, sin perder capacidad de razonamiento.
    const resultadoMistral = await llamarIAMistral({ system, prompt, model: "ministral-8b-2512", parseJson: true, maxTokens: 300 });
    let resultado = normalizarResultadoClasificacion(resultadoMistral, materias);

    if (resultado.confianza !== "alta" || !resultado.materia) {
      const motivo = resultado.confianza !== "alta" ? `dudó (${resultado.confianza})` : `dijo "alta" pero no clasificó nada`;
      console.log(`[clasificar] Mistral ${motivo} con "${termino}", pido segunda opinión a Claude`);
      try {
        const resultadoClaude = await llamarIAClaude({ system, prompt, parseJson: true, maxTokens: 300 });
        const normalizado = normalizarResultadoClasificacion(resultadoClaude, materias);
        // Solo reemplazamos el veredicto de Mistral si Claude está más seguro,
        // o si logró clasificar algo donde Mistral se había quedado en null.
        if (normalizado.confianza === "alta" || (normalizado.materia && (resultado.confianza === "baja" || !resultado.materia))) {
          resultado = normalizado;
        }
      } catch (err) {
        if (esErrorDeCreditoAnthropic(err)) {
          console.warn(`[clasificar] Claude sin crédito/cuota, sigo con el veredicto de Mistral`);
        } else {
          console.warn(`[clasificar] Claude falló (${err.message.slice(0, 200)}), sigo con el veredicto de Mistral`);
        }
      }
    }

    const detalle = resultado.materia
      ? `${resultado.materia}${resultado.esNueva ? " (nueva)" : ""}`
      : "(sin materia clara)";
    console.log(`[clasificar] "${termino}" -> ${detalle} (${resultado.confianza})`);

    res.json(resultado);
  } catch (err) {
    console.error("[clasificar] error, devuelvo null:", err.message);
    res.json({ materia: null, esNueva: false, titulo: null, grupo: null, confianza: "baja" });
  }
});

/**
 * POST /aviso-tema-auto
 * Endpoint que llama el Worker (arch-upload-worker) en segundo plano cuando
 * un usuario avisa que le falta un tema. A diferencia de /generar, acá NO
 * se le manda materia/moldePractica ya decididos: este endpoint arma todo
 * el pipeline solo, arrancando desde el término crudo.
 *
 * Recibe { termino, idioma?, idiomaOrigen? } -- idioma es el idioma
 * DESTINO en el que se genera el contenido (default "es"); idiomaOrigen
 * es opcional, ver /clasificar más arriba y lib/traducir.js.
 *
 * Flujo:
 *   1. Clasificar el término en una materia (misma lógica que /clasificar:
 *      Mistral, con Claude de respaldo si la confianza no es alta).
 *   2. Si no se pudo determinar una materia clara -> ok:false.
 *   3. IA#2 valida que sea un tema real, no duplicado, y elige el molde de
 *      práctica (modelo1/modelo2) contra los temas ya cargados en esa
 *      materia.
 *   4. Si es válido y no duplicado -> generarYPublicar vía la cola (igual
 *      que /generar): genera, revisa, compila, sube a R2 y actualiza el
 *      JSON en KV.
 *
 * Devuelve { ok: true, materia, slug } en éxito, o
 * { ok: false, motivo } cuando el término no generó nada (no se pudo
 * clasificar, no es válido, o ya existe). El Worker usa "motivo" tal cual
 * para el aviso de Discord, así que conviene que sea legible.
 */
app.post("/aviso-tema-auto", async (req, res) => {
  if (!chequearAuth(req, res)) return;

  const { termino: terminoOriginal, idiomaOrigen, idioma: idiomaDestino } = req.body || {};
  if (!terminoOriginal || typeof terminoOriginal !== "string") {
    return res.status(400).json({ ok: false, motivo: "Falta 'termino'" });
  }
  const idioma = (idiomaDestino || "es").trim();

  try {
    // 0) Traducir el término (una sola vez, acá al principio) al idioma
    // pedido en este request. Todo lo que sigue (clasificar, IA#2,
    // tituloNormalizado que recibe IA#3) trabaja sobre el término ya
    // traducido -- ver lib/traducir.js.
    const termino = await traducirTermino(terminoOriginal, idioma, idiomaOrigen);
    if (termino !== terminoOriginal) {
      console.log(`[aviso-auto] término traducido: "${terminoOriginal}" -> "${termino}"`);
    }

    // (Antes había acá una pausa manual de 1200ms para no pisar a Mistral
    // con clasificar de acá abajo -- ya no hace falta, lib/mistral.js
    // serializa todas las llamadas a Mistral del proceso entre sí.)

    // 1) Clasificar el término en una materia (existente o nueva)
    const dataMaterias = await leerJSON(keyMaterias(idioma));
    const materiasExistentes = Array.isArray(dataMaterias?.materias)
      ? dataMaterias.materias.map((m) => m.id).filter(Boolean)
      : [];
    console.log(`[DEBUG-clasificar] materiasExistentes (${materiasExistentes.length}):`, JSON.stringify(materiasExistentes));

    const { system: sysClasificar, prompt: promptClasificar } = armarPromptClasificar(termino, materiasExistentes, idioma);
    const resultadoMistral = await llamarIAMistral({ system: sysClasificar, prompt: promptClasificar, model: "ministral-8b-2512", parseJson: true, maxTokens: 300 });
    console.log(`[DEBUG-clasificar] Mistral crudo para "${termino}":`, JSON.stringify(resultadoMistral));
    let clasificacion = normalizarResultadoClasificacion(resultadoMistral, materiasExistentes);
    console.log(`[DEBUG-clasificar] Mistral normalizado:`, JSON.stringify(clasificacion));

    // Pedimos segunda opinión a Claude si Mistral no está seguro (confianza
    // != alta) O si dijo "alta" pero igual no logró clasificar nada
    // (materia null) - un "alta" en un rechazo total no es confiable, es
    // más señal de que el prompt no le dio una salida clara que de certeza
    // real. Sin este segundo caso, un false-negative con confianza "alta"
    // queda blindado para siempre y nunca llega a pedirle ayuda a Claude.
    const necesitaSegundaOpinion = clasificacion.confianza !== "alta" || !clasificacion.materia;

    if (necesitaSegundaOpinion) {
      const motivo = clasificacion.confianza !== "alta" ? `dudó (${clasificacion.confianza})` : `dijo "alta" pero no clasificó nada`;
      console.log(`[aviso-auto] Mistral ${motivo} clasificando "${termino}", pido segunda opinión a Claude`);
      try {
        const resultadoClaude = await llamarIAClaude({ system: sysClasificar, prompt: promptClasificar, parseJson: true, maxTokens: 300 });
        console.log(`[DEBUG-clasificar] Claude crudo para "${termino}":`, JSON.stringify(resultadoClaude));
        const normalizado = normalizarResultadoClasificacion(resultadoClaude, materiasExistentes);
        console.log(`[DEBUG-clasificar] Claude normalizado:`, JSON.stringify(normalizado));
        // Si Claude sí logró clasificar algo (materia no-null) y Mistral se
        // había quedado en null, nos quedamos con Claude aunque su propia
        // confianza no sea "alta" - un intento concreto vale más que nada.
        if (normalizado.confianza === "alta" || (normalizado.materia && (clasificacion.confianza === "baja" || !clasificacion.materia))) {
          clasificacion = normalizado;
        }
      } catch (err) {
        if (esErrorDeCreditoAnthropic(err)) {
          console.warn(`[aviso-auto] Claude sin crédito/cuota, sigo con el veredicto de Mistral`);
        } else {
          console.warn(`[aviso-auto] Claude falló (${err.message.slice(0, 200)}), sigo con el veredicto de Mistral`);
        }
      }
    }

    if (!clasificacion.materia) {
      console.log(`[aviso-auto] "${termino}" no se pudo clasificar en ninguna materia`);
      return res.json({ ok: false, motivo: "No se identificó una materia clara para este término" });
    }

    const materia = clasificacion.materia;

    // 2) IA#2: ¿es un tema real? ¿ya existe con otro nombre? ¿qué molde le corresponde?
    //
    // FIX (idioma-diffs review, menor): antes esto solo miraba dataMateria.temas,
    // a diferencia de /crear-tema-callback que también incluye "frecuentes".
    // Con esto ambos endpoints chequean duplicados contra la misma lista
    // completa de temas conocidos de la materia.
    const dataMateria = (await leerJSON(keyMateria(materia, idioma))) || { temas: [], frecuentes: [] };
    const temasExistentes = [...(dataMateria.temas || []), ...(dataMateria.frecuentes || [])];

    const { system: sysIA2, prompt: promptIA2 } = armarPromptIA2(materia, termino, temasExistentes, idioma);
    const resultadoIA2 = await llamarIAMistral({ system: sysIA2, prompt: promptIA2, model: "ministral-8b-2512", parseJson: true, maxTokens: 1000 });

    if (!resultadoIA2?.esValido) {
      console.log(`[aviso-auto] "${termino}" IA#2 lo marcó inválido: ${resultadoIA2?.razon}`);
      return res.json({ ok: false, motivo: resultadoIA2?.razon || "No es un tema válido para esta biblioteca" });
    }
    if (resultadoIA2?.esDuplicado) {
      console.log(`[aviso-auto] "${termino}" IA#2 lo marcó duplicado de "${resultadoIA2.tituloExistenteEquivalente}"`);
      return res.json({ ok: false, motivo: `Ya existe como "${resultadoIA2.tituloExistenteEquivalente}"` });
    }
    const moldePractica = await resolverMoldePractica(resultadoIA2, {
      system: sysIA2,
      prompt: promptIA2,
      termino,
      logPrefix: "[aviso-auto]",
    });

    // 3) Generar y publicar (mismo flujo que /generar, vía la cola)
    const contexto = {
      materia,
      tema: resultadoIA2.tituloNormalizado || termino,
      moldePractica,
      notasIA2: resultadoIA2.notas,
      materiaNuevaInfo: clasificacion.esNueva ? { titulo: clasificacion.titulo, grupo: clasificacion.grupo } : null,
      idioma,
    };

    const resultado = await encolarYEsperar(contexto);
    return res.json({ ok: true, materia, slug: resultado.slug });
  } catch (err) {
    console.error("[aviso-auto] error:", err);
    return res.status(500).json({ ok: false, motivo: err.message });
  }
});

// ---------- POST /crear-tema-callback (disparado por analyzer_con_vi) ----------
//
// A diferencia de /generar, acá no hay un término de búsqueda escrito por
// un usuario -- lo único que tenemos es la materia candidata (ya resuelta
// por analyzer_con_vi) y el resumen que calculó con Groq (nombre_sugerido,
// descripción) sobre el archivo subido. Con eso corremos primero IA#2
// (decide título real del tema + molde de práctica) y recién después
// encolamos el mismo pipeline de generación que usan /generar y
// /aviso-tema-auto (generarYPublicar: Mistral + segunda opinión de Claude +
// figura + sanitización), vía la cola.
//
// Responde 200 al toque (para no dejar a analyzer_con_vi esperando); el
// resultado real viaja después por el callback_url que mandaron, cuando la
// cola le toque el turno a este job.
app.post("/crear-tema-callback", (req, res) => {
  if (!chequearAuth(req, res)) return;

  const { materia, job_id, callback_url, nombre_sugerido, descripcion, idioma_origen, idioma: idiomaDestino } = req.body;

  if (!materia || !job_id || !callback_url) {
    return res.status(400).json({ error: "Faltan materia, job_id o callback_url" });
  }

  // PENDIENTE: analyzer_con_vi (repo aparte) todavía no manda "idioma" acá,
  // solo idioma_origen (el idioma del archivo subido, no necesariamente el
  // idioma en el que hay que generar el contenido). Mientras no lo mande,
  // esto cae en "es" -- que es exactamente el comportamiento de hoy.
  const idioma = (idiomaDestino || "es").trim();

  res.json({ ok: true, recibido: job_id });

  // Fire-and-forget: no bloquea la respuesta HTTP. Cualquier resultado
  // (éxito o fallo) se avisa por el callback, no por esta respuesta.
  procesarCreacionDeTema({ materia, job_id, callback_url, nombre_sugerido, descripcion, idiomaOrigen: idioma_origen, idioma }).catch((err) => {
    console.error(`[crear-tema-callback] error no capturado para job ${job_id}:`, err);
  });
});

async function procesarCreacionDeTema({ materia: materiaSugerida, job_id, callback_url, nombre_sugerido, descripcion, idiomaOrigen, idioma }) {
  const secret = process.env.ANALYZER_CALLBACK_SECRET;
  let materia = materiaSugerida;

  try {
    const terminoBuscadoOriginal = [nombre_sugerido, descripcion].filter(Boolean).join(". ");

    if (!terminoBuscadoOriginal) {
      await avisarCallback(callback_url, secret, {
        job_id,
        ok: false,
        materia,
        slug: null,
        motivo: "No se recibió nombre_sugerido ni descripcion -- sin contexto no se puede elegir un tema",
      });
      return;
    }

    // Traducir una sola vez, al principio, igual que en /aviso-tema-auto
    // (ver lib/traducir.js) -- analyzer_con_vi manda nombre_sugerido y
    // descripcion en el idioma en que vino el aporte del usuario, no
    // necesariamente el de esta instancia. Si analyzer_con_vi llega a
    // mandar idioma_origen en el futuro, se usa acá para no tener que
    // detectarlo; mientras no lo mande, traducirTermino lo detecta solo
    // (ver FIX en lib/traducir.js).
    const terminoBuscado = await traducirTermino(terminoBuscadoOriginal, idioma, idiomaOrigen);
    if (terminoBuscado !== terminoBuscadoOriginal) {
      console.log(`[crear-tema-callback] job ${job_id}: término traducido: "${terminoBuscadoOriginal}" -> "${terminoBuscado}"`);
    }

    // ---------- Reclasificar la materia contra el índice real ----------
    // analyzer_con_vi manda una "materia" candidata que dedujo Groq mirando
    // solo el PDF, sin saber qué materias existen (ni cómo están armadas)
    // en este sitio -- puede estar equivocada (ej: "geometria" para un PDF
    // que en realidad es de "analisis_matematico"). IA#2, más abajo, NO
    // elige materia: solo valida si el tema encaja DENTRO de la materia
    // que le pasamos. Así que antes de eso corremos el mismo paso que ya
    // usan /clasificar y /aviso-tema-auto: clasificar terminoBuscado contra
    // el índice real (materias.json en KV), con Claude de segunda opinión
    // si Mistral duda. Si la reclasificación en sí falla (KV caído, etc.),
    // no se pierde el job entero -- se sigue con la materia que mandó
    // analyzer_con_vi, que es mejor que nada.
    let materiaNuevaInfo = null;
    try {
      const dataMaterias = await leerJSON(keyMaterias(idioma));
      const materiasExistentes = Array.isArray(dataMaterias?.materias)
        ? dataMaterias.materias.map((m) => m.id).filter(Boolean)
        : [];

      const { system: sysClasificar, prompt: promptClasificar } = armarPromptClasificar(terminoBuscado, materiasExistentes, idioma);
      const resultadoMistral = await llamarIAMistral({ system: sysClasificar, prompt: promptClasificar, model: "ministral-8b-2512", parseJson: true, maxTokens: 300 });
      let clasificacion = normalizarResultadoClasificacion(resultadoMistral, materiasExistentes);

      const necesitaSegundaOpinion = clasificacion.confianza !== "alta" || !clasificacion.materia;
      if (necesitaSegundaOpinion) {
        const motivoDuda = clasificacion.confianza !== "alta" ? `dudó (${clasificacion.confianza})` : `dijo "alta" pero no clasificó nada`;
        console.log(`[crear-tema-callback] job ${job_id}: Mistral ${motivoDuda} clasificando "${terminoBuscado}", pido segunda opinión a Claude`);
        try {
          const resultadoClaude = await llamarIAClaude({ system: sysClasificar, prompt: promptClasificar, parseJson: true, maxTokens: 300 });
          const normalizado = normalizarResultadoClasificacion(resultadoClaude, materiasExistentes);
          if (normalizado.confianza === "alta" || (normalizado.materia && (clasificacion.confianza === "baja" || !clasificacion.materia))) {
            clasificacion = normalizado;
          }
        } catch (err) {
          if (esErrorDeCreditoAnthropic(err)) {
            console.warn(`[crear-tema-callback] job ${job_id}: Claude sin crédito/cuota, sigo con el veredicto de Mistral`);
          } else {
            console.warn(`[crear-tema-callback] job ${job_id}: Claude falló (${err.message.slice(0, 200)}), sigo con el veredicto de Mistral`);
          }
        }
      }

      if (!clasificacion.materia) {
        console.log(`[crear-tema-callback] job ${job_id}: "${terminoBuscado}" no se pudo clasificar en ninguna materia`);
        await avisarCallback(callback_url, secret, {
          job_id,
          ok: false,
          materia,
          slug: null,
          motivo: "No se identificó una materia clara para este término",
        });
        return;
      }

      if (clasificacion.materia !== materia) {
        console.log(`[crear-tema-callback] job ${job_id}: reclasificado de "${materia}" (sugerida por analyzer_con_vi) a "${clasificacion.materia}"`);
      }
      materia = clasificacion.materia;
      if (clasificacion.esNueva) {
        materiaNuevaInfo = { titulo: clasificacion.titulo, grupo: clasificacion.grupo };
      }
    } catch (err) {
      console.warn(`[crear-tema-callback] job ${job_id}: no se pudo reclasificar (${err.message}), sigo con la materia recibida "${materia}"`);
    }

    console.log(`[crear-tema-callback] job ${job_id}: IA#2 para "${terminoBuscado}" en ${materia}`);

    const dataMateria = (await leerJSON(keyMateria(materia, idioma))) || { temas: [], frecuentes: [] };
    const temasExistentes = [...(dataMateria.temas || []), ...(dataMateria.frecuentes || [])];

    const { system, prompt } = armarPromptIA2(materia, terminoBuscado, temasExistentes, idioma);
    const revisionIA2 = await llamarIAMistral({ system, prompt, model: "ministral-8b-2512", parseJson: true, maxTokens: 1000 });

    if (!revisionIA2.esValido) {
      await avisarCallback(callback_url, secret, {
        job_id,
        ok: false,
        materia,
        slug: null,
        motivo: revisionIA2.razon || "IA#2 no consideró válido este tema",
      });
      return;
    }

    if (revisionIA2.esDuplicado && revisionIA2.tituloExistenteEquivalente) {
      // Ya existe con otro nombre -- no generamos contenido de nuevo,
      // devolvemos el tema existente para que analyzer_con_vi lo use.
      console.log(`[crear-tema-callback] job ${job_id}: duplicado de "${revisionIA2.tituloExistenteEquivalente}"`);
      await avisarCallback(callback_url, secret, {
        job_id,
        ok: true,
        materia,
        slug: slugify(revisionIA2.tituloExistenteEquivalente),
        motivo: "coincide con un tema ya existente",
      });
      return;
    }

    const moldePractica = await resolverMoldePractica(revisionIA2, {
      system,
      prompt,
      termino: terminoBuscado,
      logPrefix: `[crear-tema-callback] job ${job_id}`,
    });

    const contexto = {
      materia,
      tema: revisionIA2.tituloNormalizado,
      moldePractica,
      notasIA2: revisionIA2.notas,
      materiaNuevaInfo,
      idioma,
    };

    // Encola y sigue: el resultado (éxito o fallo) lo avisa la cola por
    // callback_url cuando le toque el turno a este job, no acá.
    console.log(`[crear-tema-callback] job ${job_id}: encolando generación para ${materia}/${contexto.tema}`);
    await encolarSinEsperar(contexto, { callbackUrl: callback_url, callbackSecret: secret, jobIdAnalyzer: job_id });
  } catch (err) {
    console.error(`[crear-tema-callback] job ${job_id} falló:`, err);
    await avisarCallback(callback_url, secret, {
      job_id,
      ok: false,
      materia,
      slug: null,
      motivo: err.message,
    });
  }
}

app.get("/health", (_req, res) => res.json({ ok: true }));

iniciarCola().catch((err) => console.error("[cola] no se pudo inicializar:", err));

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`generador-contenido-service escuchando en :${port}`));
