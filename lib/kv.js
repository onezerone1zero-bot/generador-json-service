import { registrarKvEntrada } from "./supabase.js";

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

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

function separarIdiomaDeSlug(slugConSufijo) {
  const idiomaActual = process.env.IDIOMA || "es";
  if (idiomaActual === "es") return { slug: slugConSufijo, idioma: "es" };
  const sufijo = `_${idiomaActual}`;
  if (slugConSufijo.endsWith(sufijo)) {
    return { slug: slugConSufijo.slice(0, -sufijo.length), idioma: idiomaActual };
  }
  return { slug: slugConSufijo, idioma: idiomaActual };
}

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

  if (!ttlSegundos) {
    const [, materiaTema] = key.split(":");
    if (materiaTema) {
      const [materia, temaConSufijo] = materiaTema.split("--");
      const { slug: tema, idioma } = separarIdiomaDeSlug(temaConSufijo);
      const tamanoBytes = Buffer.byteLength(JSON.stringify(valor));
      const registro = await registrarKvEntrada(tipo, materia, tema, idioma, tamanoBytes);
      if (!registro.ok) {
        console.error(`[kv] No se pudo registrar tamaño en Supabase para ${key}:`, registro.detalle);
      }
    }
  }
}

export async function borrarJSON(key, tipo) {
  const resp = await fetch(baseUrl(key, tipo), {
    method: "DELETE",
    headers: { Authorization: `Bearer ${API_TOKEN}` },
  });
  if (!resp.ok && resp.status !== 404) {
    throw new Error(`Fallo al borrar KV (${key}): ${resp.status} ${await resp.text()}`);
  }
}

function sufijoIdioma() {
  const idioma = process.env.IDIOMA || "es";
  return idioma === "es" ? "" : `_${idioma}`;
}

export function keyPractice(slugMateria, slugTema, slugTemaCanonico) {
  return `practice:${slugMateria}--${slugTemaCanonico || slugTema}${sufijoIdioma()}`;
}

export function keyExam(slugMateria, slugTema, slugTemaCanonico) {
  return `exam:${slugMateria}--${slugTemaCanonico || slugTema}${sufijoIdioma()}`;
}

export function keyFormulas(slugMateria, slugTema, slugTemaCanonico) {
  return `formulas:${slugMateria}--${slugTemaCanonico || slugTema}${sufijoIdioma()}`;
}
