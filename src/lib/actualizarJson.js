import { leerJSON, escribirJSON, keyMaterias, keyMateria } from "./kv.js";
import { slugify } from "./slugify.js";
import { llamarIA as llamarIAMistral } from "./mistral.js";

// Nombre legible del idioma para el prompt de traducción de la etiqueta
// de respaldo -- mismo mecanismo que lib/traducir.js (Intl.DisplayNames
// en vez de diccionario manual, porque el proyecto está pensado para
// ~70 idiomas y mantener una traducción a mano por idioma no escala).
let nombresIdioma;
try {
  nombresIdioma = new Intl.DisplayNames(["es"], { type: "language" });
} catch {
  nombresIdioma = null;
}
function nombreIdioma(codigo) {
  try {
    return nombresIdioma?.of(codigo) || codigo;
  } catch {
    return codigo;
  }
}

// FIX (bug "Sin clasificar" queda en español en cualquier idioma): antes
// esta etiqueta de respaldo era un literal fijo en español, escrito tal
// cual en materias.json sin importar el "idioma" que recibe esta misma
// función -- el frontend no tiene la culpa acá, muestra lo que ya vino
// mal guardado desde el backend.
//
// Ahora se traduce una sola vez por idioma (vía Mistral, mismo patrón
// que traducirTermino en lib/traducir.js) y se cachea en memoria para el
// resto de la vida del proceso: esta etiqueta es siempre el mismo texto
// fijo ("Sin clasificar"), así que no hay necesidad de traducirla de
// nuevo cada vez que se crea una materia nueva sin grupo.
const cacheEtiquetaSinClasificar = new Map(); // idioma -> texto traducido

async function etiquetaSinClasificar(idioma) {
  if (!idioma || idioma === "es") return "Sin clasificar";

  if (cacheEtiquetaSinClasificar.has(idioma)) {
    return cacheEtiquetaSinClasificar.get(idioma);
  }

  const nombreDestino = nombreIdioma(idioma);
  try {
    const system = `Traducís una etiqueta corta de interfaz (nombre de categoría) del español a ${nombreDestino}.
Tu única salida es la traducción, sin comillas, sin explicación, sin texto adicional.`;
    const prompt = `Etiqueta: "Sin clasificar"`;

    const resultado = await llamarIAMistral({ system, prompt, model: "ministral-3b-2512", maxTokens: 50, parseJson: false });
    const traducido = resultado.trim().replace(/^["']|["']$/g, "");

    const etiqueta = traducido || "Sin clasificar";
    cacheEtiquetaSinClasificar.set(idioma, etiqueta);
    return etiqueta;
  } catch (err) {
    console.warn(`[actualizarJson] no se pudo traducir "Sin clasificar" a ${idioma} (${err.message}), uso el texto en español`);
    // OJO: a propósito NO cacheamos el fallback -- si falló por algo
    // transitorio (Mistral caído un momento), la próxima materia sin
    // clasificar en este idioma vuelve a intentar la traducción real,
    // en vez de quedar pegada en español para siempre por este proceso.
    return "Sin clasificar";
  }
}

/**
 * Convierte un id de materia (ej: "teoria_numeros") en un título legible
 * de respaldo (ej: "Teoria numeros"), para cuando se crea una materia
 * nueva en materias.json sin que nadie haya mandado un título "lindo".
 */
function tituloDeRespaldo(materiaId) {
  const texto = materiaId.replace(/[_-]+/g, " ").trim();
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

/**
 * Se asegura de que la materia exista como entrada en materias.json
 * (el índice que lee el frontend para armar la grilla de materias).
 * Si ya está, no toca nada. Si no está, la agrega.
 *
 * materiaInfo opcional = { titulo, grupo } que ya vienen decididos (ej:
 * por el clasificador, cuando esNueva=true). Si no se pasa nada, se cae
 * en un título de respaldo derivado del id y grupo "Sin clasificar" (o
 * su traducción al "idioma" de esta instancia, ver etiquetaSinClasificar
 * arriba -- antes este texto quedaba en español sin importar el idioma).
 *
 * @param {string} materiaId
 * @param {{titulo?: string, grupo?: string}|null} materiaInfo
 * @param {string} idioma - idioma destino, ver kv.js
 * @returns {{ agregada: boolean }}
 */
async function asegurarMateriaEnIndice(materiaId, materiaInfo = null, idioma = "es") {
  const keyIndice = keyMaterias(idioma);
  const dataMaterias = (await leerJSON(keyIndice)) || { materias: [] };
  if (!Array.isArray(dataMaterias.materias)) dataMaterias.materias = [];

  const yaExiste = dataMaterias.materias.some((m) => m.id === materiaId);
  if (yaExiste) {
    return { agregada: false };
  }

  dataMaterias.materias.push({
    id: materiaId,
    titulo: materiaInfo?.titulo || tituloDeRespaldo(materiaId),
    grupo: materiaInfo?.grupo || (await etiquetaSinClasificar(idioma)),
    implementada: true,
    json: keyMateria(materiaId, idioma),
  });

  await escribirJSON(keyIndice, dataMaterias);
  return { agregada: true };
}

/**
 * Agrega un tema nuevo al JSON de la materia en KV (ej: algebra.json).
 * No usa IA: es un merge determinístico sobre el array "temas".
 *
 * Antes de tocar el JSON de la materia, se asegura de que la materia
 * misma esté listada en materias.json (el índice que arma la grilla del
 * frontend); si es una materia nueva, la agrega ahí primero, usando
 * materiaInfo (titulo/grupo) si se lo pasaron para no dejarla como
 * "Sin clasificar".
 *
 * Estructura esperada del JSON de materia (ver CONTEXTO):
 * {
 *   "temas": [ {"id": "...", "titulo": "..."}, ... ]
 * }
 *
 * IMPORTANTE - ediciones manuales desde el dashboard de Cloudflare KV:
 * la detección de "¿ya existe este tema?" se hace por el campo "id"
 * (un slug fijo, generado UNA sola vez a partir del título original),
 * y NO por el texto de "titulo". Esto es a propósito: si editás el
 * "titulo" de un tema a mano en el dashboard, ese cambio queda firme
 * para siempre, porque el pipeline ya no lo va a reconocer por texto
 * y de-duplicar/regenerar en base a eso. Lo mismo vale para temas que
 * vengan de datos viejos sin "id" todavía: al primer paso por acá se
 * les calcula el id a partir de su titulo actual y se guarda, y de ahí
 * en más ese id queda fijo aunque el titulo se edite después.
 *
 * Si la materia no existe todavía en KV, se crea desde cero.
 * Si el tema ya existe (comparación por id), no se duplica ni se toca
 * su titulo/contenido existente.
 *
 * @param {string} materiaId - id de la materia, ej: "algebra" (sin .json)
 * @param {string} tituloTema - título del tema a agregar, ej: "Derivadas"
 * @param {{titulo?: string, grupo?: string}|null} materiaInfo - opcional, ver asegurarMateriaEnIndice
 * @param {string} idioma - idioma destino, ver kv.js. Antes esta función
 *   siempre pisaba materias.json/<materiaId>.json (español) sin importar
 *   qué idioma se estuviera generando -- bug latente que nunca se notó
 *   porque solo corría una instancia (español).
 * @returns {{ agregado: boolean, yaExistia: boolean, materiaNueva: boolean }}
 */
export async function agregarTemaAMateria(materiaId, tituloTema, materiaInfo = null, idioma = "es") {
  const { agregada: materiaNueva } = await asegurarMateriaEnIndice(materiaId, materiaInfo, idioma);

  const key = keyMateria(materiaId, idioma);
  const dataMateria = (await leerJSON(key)) || { temas: [] };

  if (!Array.isArray(dataMateria.temas)) dataMateria.temas = [];

  // Compatibilidad con temas viejos sin "id": se les asigna uno ahora,
  // derivado de su titulo ACTUAL (que puede ya ser una edición manual).
  // A partir de acá ese id queda fijo, sin importar qué titulo tengan.
  let huboMigracion = false;
  for (const t of dataMateria.temas) {
    if (!t.id) {
      t.id = slugify((t.titulo || "").trim());
      huboMigracion = true;
    }
  }

  const idNuevoTema = slugify(tituloTema.trim());
  const yaExistia = dataMateria.temas.some((t) => t.id === idNuevoTema);

  if (yaExistia) {
    // Ya existe (por id): no se toca su titulo ni ningún otro campo,
    // aunque hayan cambiado mayúsculas/acentos/redacción del título.
    if (huboMigracion) await escribirJSON(key, dataMateria);
    return { agregado: false, yaExistia: true, materiaNueva };
  }

  dataMateria.temas.push({ id: idNuevoTema, titulo: tituloTema.trim() });

  // Mantener orden alfabético, como espera el front-end al listar temas.
  // Antes esto ordenaba siempre con locale "es" hardcodeado, sin importar
  // el idioma real del contenido -- bug latente que nunca se notó porque
  // solo corría una instancia (español). Si el código de idioma no es un
  // locale BCP-47 que Node reconozca (ej. "ceb", "tir" -- códigos propios
  // de idioma.js sin ICU data en Node), localeCompare tira RangeError: en
  // ese caso se cae a comparación sin locale explícito (undefined), que
  // sigue ordenando razonablemente en vez de reventar el request.
  try {
    dataMateria.temas.sort((a, b) =>
      (a.titulo || "").localeCompare(b.titulo || "", idioma, { sensitivity: "base" })
    );
  } catch (err) {
    console.warn(`[actualizarJson] localeCompare no reconoce idioma "${idioma}" (${err.message}), ordeno sin locale explícito`);
    dataMateria.temas.sort((a, b) =>
      (a.titulo || "").localeCompare(b.titulo || "", undefined, { sensitivity: "base" })
    );
  }

  await escribirJSON(key, dataMateria);
  return { agregado: true, yaExistia: false, materiaNueva };
}
