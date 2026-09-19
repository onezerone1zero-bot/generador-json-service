// Cliente de Cloudflare KV vía API REST (no vía Worker directo).
// Namespace usado: subject_JSON (el mismo que lee tu Worker en /materias
// y /materia/:id).
//
// Requiere estas 3 variables de entorno en Render:
//   CLOUDFLARE_ACCOUNT_ID
//   CLOUDFLARE_NAMESPACE_ID   (namespace ID de subject_JSON)
//   CLOUDFLARE_API_TOKEN      (con permiso Account > Workers KV Storage > Edit)

import { fetchConTimeout } from "./fetchTimeout.js";

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const NAMESPACE_ID = process.env.CLOUDFLARE_NAMESPACE_ID;
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

const TIMEOUT_MS = 15_000;

function baseUrl(key) {
  return `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${NAMESPACE_ID}/values/${encodeURIComponent(key)}`;
}

/**
 * Lee un valor de KV y lo parsea como JSON.
 * Devuelve null si la key no existe (404), tal como hace tu Worker.
 */
export async function leerJSON(key) {
  const resp = await fetchConTimeout(
    baseUrl(key),
    { headers: { Authorization: `Bearer ${API_TOKEN}` } },
    TIMEOUT_MS
  );

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
 * Sufijo de idioma para las keys de KV. "es" es el canónico y no lleva
 * sufijo (así el contenido español ya existente, escrito antes de que
 * existiera soporte de idiomas, sigue siendo válido sin migrar nada).
 * Cualquier otro idioma (en, pt, ...) lleva "_<idioma>".
 *
 * Tiene que coincidir EXACTO con el criterio que usa kv.js del Worker
 * (arch-upload-worker) -- ver /areas/hybrid-storage.md.
 *
 * CAMBIO: ya no lee process.env.IDIOMA -- esta instancia ya no tiene un
 * idioma fijo propio, recibe el idioma destino en cada request (ver
 * server.js). Todo lo que llame a keyMaterias/keyMateria tiene que pasar
 * el idioma explícito.
 */
function sufijoIdioma(idioma) {
  return !idioma || idioma === "es" ? "" : `_${idioma}`;
}

/**
 * Key de materias.json para el idioma pedido.
 */
export function keyMaterias(idioma) {
  return `materias${sufijoIdioma(idioma)}.json`;
}

/**
 * Key de <materiaId>.json para el idioma pedido.
 */
export function keyMateria(materiaId, idioma) {
  return `${materiaId}${sufijoIdioma(idioma)}.json`;
}

// (Se sacó keyMateriasCanonica() -- existía para que una instancia
// no-española pudiera leer el índice español y reutilizar sus ids de
// materia. Se decidió que el id de materia NO debe relacionar
// instancias de distinto idioma entre sí -- ver la nota en
// prompts/clasificar.js -- así que este puente ya no hace falta.)

/**
 * Escribe un objeto en KV, serializándolo como JSON.
 */
export async function escribirJSON(key, valor) {
  const resp = await fetchConTimeout(
    baseUrl(key),
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(valor),
    },
    TIMEOUT_MS
  );

  if (!resp.ok) {
    throw new Error(`Fallo al escribir KV (${key}): ${resp.status} ${await resp.text()}`);
  }
}
