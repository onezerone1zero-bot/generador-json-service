// Cliente de Cloudflare KV vía API REST directa -- mismo patrón que
// generador-service-main/src/lib/kv.js. NO usa binding de Worker: el
// token de Cloudflare vive solo acá en el server (Render), nunca llega
// al browser ni a ningún cliente. Esta es la forma segura de hacerlo:
// las escrituras a KV solo las puede disparar quien tenga SERVICE_KEY
// (auth entre generador-service-main y este service) Y el propio proceso
// tenga CLOUDFLARE_API_TOKEN -- ninguno de los dos se expone al frontend.
//
// Namespaces separados por tipo: practice_JSON, exam_JSON, formula_JSON
// (distintos de subject_JSON, que usa el otro service para materias/
// temas). Cada tipo tiene su propio namespace ID en Cloudflare -- ver
// NAMESPACE_ID_POR_TIPO abajo. Las keys dentro de cada namespace igual
// combinan materia+tema -- ver keyPractice/keyExam/keyFormulas abajo.
//
// Requiere estas variables de entorno en Render:
//   CLOUDFLARE_ACCOUNT_ID
//   CLOUDFLARE_NAMESPACE_ID_PRACTICE   (namespace ID de practice_JSON)
//   CLOUDFLARE_NAMESPACE_ID_EXAM       (namespace ID de exam_JSON)
//   CLOUDFLARE_NAMESPACE_ID_FORMULA    (namespace ID de formula_JSON)
//   CLOUDFLARE_API_TOKEN               (con permiso Account > Workers KV Storage > Edit)

import { registrarKvEntrada } from "./supabase.js";

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

// Namespaces separados por tipo -- en la cuenta real, exam_JSON,
// formula_JSON y practice_JSON son namespaces DISTINTOS (cada uno con
// su propio ID en Cloudflare), no un solo namespace con prefijos de
// key. Si CLOUDFLARE_NAMESPACE_ID_EXAM no está seteada, cae a
// PRACTICE por retrocompatibilidad -- pero FORMULA es obligatoria.
const NAMESPACE_ID_POR_TIPO = {
  practice: process.env.CLOUDFLARE_NAMESPACE_ID_PRACTICE,
  exam: process.env.CLOUDFLARE_NAMESPACE_ID_EXAM || process.env.CLOUDFLARE_NAMESPACE_ID_PRACTICE,
  formula: process.env.CLOUDFLARE_NAMESPACE_ID_FORMULA,
};

function baseUrl(key, tipo) {
  const namespaceId = NAMESPACE_ID_POR_TIPO[tipo];
  if (!namespaceId) {
    throw new Error(`No hay CLOUDFLARE_NAMESPACE_ID configurado para tipo "${tipo}"`);
  }
  return `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`;
}

/**
 * Lee un valor de KV y lo parsea como JSON.
 * Devuelve null si la key no existe (404).
 */
export async function leerJSON(key, tipo) {
  const resp = await fetch(baseUrl(key, tipo), {
    headers: { Authorization: `Bearer ${API_TOKEN}` },
  });
  if (resp.status === 404) return null;
  if (!resp.ok) {
    throw new Error(`Fallo al leer KV (${key}): ${resp.status} ${await resp.text()}`);
  }
  const texto = await resp.text();
  try {
    return JSON.parse(texto);
  } catch (err) {
    throw new Error(`El valor de KV (${key}) no es JSON válido: ${err.message}`);
  }
}

/**
 * Escribe un objeto en KV, serializándolo como JSON.
 *
 * `ttlSegundos` (opcional): si se pasa, el valor expira solo pasado ese
 * tiempo (Cloudflare lo borra automáticamente). Se usa para el lock de
 * "generación en curso" (ver generar.js) -- así, si el proceso se cae a
 * mitad de camino y nadie llega a liberar el lock a mano, no queda
 * trabado para siempre: expira y un request posterior puede reintentar.
 * Cloudflare exige un mínimo de 60s de TTL.
 */
export async function escribirJSON(key, valor, tipo, { ttlSegundos } = {}) {
  const url = ttlSegundos ? `${baseUrl(key, tipo)}?expiration_ttl=${ttlSegundos}` : baseUrl(key, tipo);
  const resp = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(valor),
  });
  if (!resp.ok) {
    throw new Error(`Fallo al escribir KV (${key}): ${resp.status} ${await resp.text()}`);
  }

  // Registrar tamaño en Supabase, salvo que sea el lock temporal
  // (_enGeneracion, que usa ttlSegundos) -- ese no cuenta para el límite.
  //
  // NOTA DE SCHEMA (ver lib/supabase.js): kv_entradas agrupa por materia
  // completa, no por tema individual -- nunca tuvo columna `tema`, así
  // que no se manda acá (no se parsea de la key). El idioma sale directo
  // de process.env.IDIOMA, no hace falta separarlo de la key tampoco.
  if (!ttlSegundos) {
    const [, materiaTema] = key.split(":");
    if (materiaTema) {
      const [materia] = materiaTema.split("--");
      const idioma = process.env.IDIOMA || "es";
      const tamanoBytes = Buffer.byteLength(JSON.stringify(valor));
      const registro = await registrarKvEntrada(tipo, materia, idioma, tamanoBytes);
      if (!registro.ok) {
        console.error(`[kv] No se pudo registrar tamaño en Supabase para ${key}:`, registro.detalle);
      }
    }
  }
}

/**
 * Borra una key de KV. Usada para liberar el lock de "generación en
 * curso" cuando el pipeline falla antes de llegar a guardar el
 * resultado final -- así un retry posterior no tiene que esperar a que
 * expire el TTL. Es "best-effort": si el borrado en sí falla, no
 * rompe -- el TTL igual lo va a limpiar más tarde.
 */
export async function borrarJSON(key, tipo) {
  const resp = await fetch(baseUrl(key, tipo), {
    method: "DELETE",
    headers: { Authorization: `Bearer ${API_TOKEN}` },
  });
  if (!resp.ok && resp.status !== 404) {
    throw new Error(`Fallo al borrar KV (${key}): ${resp.status} ${await resp.text()}`);
  }
}

// Las keys combinan materia+tema (separados por "--") en vez de usar
// solo el tema. Esto evita colisiones entre materias distintas que
// puedan tener un tema con el mismo nombre (ej. "Introducción" en
// Física y en Química) -- y tiene que coincidir EXACTO con como arma
// la key el Worker (arch-upload-worker/routes/practice.js y exam.js),
// que arma esta misma key a partir de la URL /practice/<materia>/<tema>.
//
// SOPORTE DE IDIOMA (agregado, ver ANALISIS-idioma-generador-json.md):
// mismo criterio que sufijoIdioma() en generador-service-main/src/lib/kv.js
// -- "es" es el canónico y no lleva sufijo (así el contenido español ya
// existente sigue siendo válido sin migrar nada); cualquier otro idioma
// lleva "_<idioma>" AL FINAL de la key completa (después del slug de
// tema, no en el medio de "materia--tema"), para que el separador "--"
// siga funcionando igual al parsear la key de vuelta (ver escribirJSON
// más abajo, que necesita distinguir el sufijo del slug de tema).
function sufijoIdioma() {
  const idioma = process.env.IDIOMA || "es";
  return idioma === "es" ? "" : `_${idioma}`;
}

/**
 * Key de KV para el practice.json de un tema. Prefijo "practice:".
 *
 * @param {string} slugMateria
 * @param {string} slugTema
 * @param {string} [slugTemaCanonico] - si se pasa, se usa ESTE slug para
 *   la key en vez de slugTema. Ver nota "IDIOMA Y SLUG DE TEMA CANÓNICO"
 *   en el comentario de escribirJSON más abajo: sin esto, un mismo tema
 *   generado en dos idiomas distintos arma dos keys sin relación entre
 *   sí (slugify("Stoichiometry") !== slugify("Estequiometría")).
 */
export function keyPractice(slugMateria, slugTema, slugTemaCanonico) {
  return `practice:${slugMateria}--${slugTemaCanonico || slugTema}${sufijoIdioma()}`;
}

/** Key de KV para el exam.json de un tema. Prefijo "exam:". Ver keyPractice. */
export function keyExam(slugMateria, slugTema, slugTemaCanonico) {
  return `exam:${slugMateria}--${slugTemaCanonico || slugTema}${sufijoIdioma()}`;
}

/** Key de KV para el formulas.json de un tema. Prefijo "formulas:". Ver keyPractice. */
export function keyFormulas(slugMateria, slugTema, slugTemaCanonico) {
  return `formulas:${slugMateria}--${slugTemaCanonico || slugTema}${sufijoIdioma()}`;
}
