// Cliente de Cloudflare KV vía API REST directa -- mismo patrón que
// generador-service-main/src/lib/kv.js. NO usa binding de Worker: el
// token de Cloudflare vive solo acá en el server (Render), nunca llega
// al browser ni a ningún cliente. Esta es la forma segura de hacerlo:
// las escrituras a KV solo las puede disparar quien tenga SERVICE_KEY
// (auth entre generador-service-main y este service) Y el propio proceso
// tenga CLOUDFLARE_API_TOKEN -- ninguno de los dos se expone al frontend.
//
// Namespace: practice_JSON (nuevo, separado de subject_JSON que usa el
// otro service para materias/temas). Acá van practice.json y exam.json
// por tema, con prefijo de key -- ver keyPractice/keyExam/keyFormulas abajo.
//
// Requiere estas 3 variables de entorno en Render:
//   CLOUDFLARE_ACCOUNT_ID
//   CLOUDFLARE_NAMESPACE_ID_PRACTICE   (namespace ID de practice_JSON)
//   CLOUDFLARE_API_TOKEN               (con permiso Account > Workers KV Storage > Edit)

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const NAMESPACE_ID = process.env.CLOUDFLARE_NAMESPACE_ID_PRACTICE;
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

function baseUrl(key) {
  return `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${NAMESPACE_ID}/values/${encodeURIComponent(key)}`;
}

/**
 * Lee un valor de KV y lo parsea como JSON.
 * Devuelve null si la key no existe (404).
 */
export async function leerJSON(key) {
  const resp = await fetch(baseUrl(key), {
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
 */
export async function escribirJSON(key, valor) {
  const resp = await fetch(baseUrl(key), {
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
}

// Las keys combinan materia+tema (separados por "--") en vez de usar
// solo el tema. Esto evita colisiones entre materias distintas que
// puedan tener un tema con el mismo nombre (ej. "Introducción" en
// Física y en Química) -- y tiene que coincidir EXACTO con como arma
// la key el Worker (arch-upload-worker/routes/practice.js y exam.js),
// que arma esta misma key a partir de la URL /practice/<materia>/<tema>.

/** Key de KV para el practice.json de un tema. Prefijo "practice:". */
export function keyPractice(slugMateria, slugTema) {
  return `practice:${slugMateria}--${slugTema}`;
}

/** Key de KV para el exam.json de un tema. Prefijo "exam:". */
export function keyExam(slugMateria, slugTema) {
  return `exam:${slugMateria}--${slugTema}`;
}

/** Key de KV para el formulas.json de un tema. Prefijo "formulas:". */
export function keyFormulas(slugMateria, slugTema) {
  return `formulas:${slugMateria}--${slugTema}`;
}
