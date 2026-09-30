// Anota el gasto de cada llamada a un modelo en el Worker "claude-count" (POST /registrar).
//
// Nunca rompe ni retrasa una generación: corre en segundo plano, ignora cualquier error y
// no hace nada si COUNT_URL o COUNT_SECRET no están configuradas (así se puede desplegar
// antes de tener el contador funcionando).
//
// Variables de entorno (todas opcionales):
//   COUNT_URL         -> URL del Worker, ej. https://claude-count.<subdominio>.workers.dev
//   COUNT_SECRET      -> el mismo COUNT_SECRET del Worker
//   PRECIOS_IA_JSON   -> sobreescribe/agrega precios: {"modelo":[usd_por_M_entrada, usd_por_M_salida]}
//
// Este archivo es idéntico en generador-service-main y generador-json-service-main.

// USD por 1M de tokens [entrada, salida].
// Anthropic: tabla oficial al 2026-09-25. Mistral: mistral.ai/pricing/api, verificado el 2026-09-29.
// Si cambian, claude-count avisa por Discord; corregir aquí o con PRECIOS_IA_JSON.
const PRECIOS = {
  "claude-fable-5-1": [10, 50],
  "claude-fable-5": [10, 50],
  "claude-opus-5-5": [4, 20],
  "claude-opus-5": [5, 25],
  "claude-opus-4-8": [5, 25],
  "claude-opus-4-7": [5, 25],
  "claude-opus-4-6": [5, 25],
  "claude-sonnet-5-5": [2, 10],
  "claude-sonnet-5": [2, 10],
  "claude-sonnet-4-6": [3, 15],
  "claude-sonnet-4-5": [3, 15],
  "claude-haiku-4-5": [1, 5],
  "mistral-small-latest": [0.15, 0.6], // Mistral Small 4
  "ministral-8b-2512": [0.15, 0.15], // Ministral 3 (8B)
  "ministral-3b-2512": [0.1, 0.1], // Ministral 3 (3B)
  "mistral-large-2512": [0.5, 1.5], // Mistral Large 3
};

// Modelo desconocido: se asume el precio más alto del proveedor (mejor sobreestimar que no contar).
const PRECIO_DESCONOCIDO = { anthropic: [10, 50], mistral: [2, 6] };

function precios() {
  if (!process.env.PRECIOS_IA_JSON) return PRECIOS;
  try {
    return { ...PRECIOS, ...JSON.parse(process.env.PRECIOS_IA_JSON) };
  } catch {
    console.warn("[contador] PRECIOS_IA_JSON no es JSON válido, se ignora");
    return PRECIOS;
  }
}

/**
 * @param {object} p
 * @param {"anthropic"|"mistral"} p.proveedor
 * @param {string} p.modelo
 * @param {string} p.concepto           ej. "generador-service" o "generador-json"
 * @param {number} p.tokensIn           tokens de entrada normales
 * @param {number} p.tokensOut
 * @param {number} [p.tokensCacheEscritura]  Anthropic: cache_creation_input_tokens (se cobra x1,25)
 * @param {number} [p.tokensCacheLectura]    Anthropic: cache_read_input_tokens (se cobra x0,10)
 */
export function registrarGasto({ proveedor, modelo, concepto, tokensIn, tokensOut, tokensCacheEscritura = 0, tokensCacheLectura = 0 }) {
  try {
    const { COUNT_URL, COUNT_SECRET } = process.env;
    if (!COUNT_URL || !COUNT_SECRET) return;

    const tIn = Number(tokensIn);
    const tOut = Number(tokensOut);
    if (!Number.isFinite(tIn) || !Number.isFinite(tOut)) {
      console.warn(`[contador] ${modelo}: la respuesta no trajo usage, no se anota el gasto`);
      return;
    }

    const conocido = precios()[modelo];
    const [pIn, pOut] = conocido || PRECIO_DESCONOCIDO[proveedor] || [10, 50];
    const entradaEquivalente = tIn + tokensCacheEscritura * 1.25 + tokensCacheLectura * 0.1;
    const costo = (entradaEquivalente * pIn + tOut * pOut) / 1_000_000;

    fetch(`${COUNT_URL.replace(/\/+$/, "")}/registrar`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${COUNT_SECRET}` },
      body: JSON.stringify({
        proveedor,
        concepto: `${concepto}:${modelo}${conocido ? "" : " (precio estimado)"}`.slice(0, 80),
        costo_usd: Math.round(costo * 1e6) / 1e6,
        tokens_in: Math.round(tIn + tokensCacheEscritura + tokensCacheLectura),
        tokens_out: Math.round(tOut),
      }),
      signal: AbortSignal.timeout(5000),
    })
      .then((r) => {
        if (!r.ok) console.warn(`[contador] /registrar respondió ${r.status}`);
      })
      .catch((e) => console.warn(`[contador] no se pudo anotar el gasto: ${e.message}`));
  } catch (e) {
    console.warn(`[contador] error inesperado: ${e.message}`);
  }
}
