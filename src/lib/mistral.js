import { fetchConTimeout } from "./fetchTimeout.js";

const MISTRAL_URL = "https://api.mistral.ai/v1/chat/completions";

// Timeout del fetch en sí. Clasificar/traducir son tareas chicas (deberían
// responder en segundos), pero el fallback de revisión (IA#4) pide hasta
// 4000 tokens -- se deja margen para eso.
const TIMEOUT_FETCH_MS = 60_000;

// Red de seguridad ADEMÁS del timeout de arriba (ver fetchTimeout.js para
// el detalle completo del bug): si por lo que sea una llamada nunca
// resuelve NI rechaza -- un bug futuro, una llamada que no pase por
// fetchConTimeout, lo que sea -- esto garantiza que colaMistral SIEMPRE
// avanza igual. Sin esto, una sola llamada colgada deja la cola entera
// trabada para el resto de la vida del proceso (esto fue exactamente lo
// que pasó el 18/09 con "ガロア理論": una vez trabada, ningún reintento
// servía de nada). El valor es mayor al timeout del fetch a propósito --
// en el caso normal, el fetch tiene que fallar primero y dar un error
// real y legible; esto es solo el último cinturón de seguridad.
const TIMEOUT_DURO_COLA_MS = 90_000;

function conTimeoutDuro(promesa, ms) {
  return Promise.race([
    promesa,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`[mistral] la llamada no terminó en ${ms}ms, se libera la cola igual`)),
        ms
      )
    ),
  ]);
}

// mistral-small tiene 1 request/segundo de cuota (ver /plateforme/limits).
// Reintentar cada llamada por separado no alcanza si hay más de una
// llamada en simultáneo en el mismo proceso (traducir + clasificar, o
// dos requests HTTP distintos que le pegan a la vez) -- ambas chocan, y
// como el backoff es el mismo (2^intento) sin jitter, tienden a volver a
// chocar en el mismo instante. Por eso serializamos TODAS las llamadas a
// Mistral acá, en un solo punto, con un espaciado mínimo entre el inicio
// de cada una -- así nunca salen dos al mismo tiempo, en vez de confiar
// en que el reintento las desincronice por suerte.
const ESPACIADO_MINIMO_MS = 1100; // > 1000ms para no pisar el límite de 1 req/s
let colaMistral = Promise.resolve();
let ultimoInicio = 0;

function serializar(fn) {
  const resultado = colaMistral.then(async () => {
    const espera = ultimoInicio + ESPACIADO_MINIMO_MS - Date.now();
    if (espera > 0) await new Promise((resolve) => setTimeout(resolve, espera));
    ultimoInicio = Date.now();
    return conTimeoutDuro(fn(), TIMEOUT_DURO_COLA_MS);
  });
  // Si fn() falla, colaMistral no debe quedar rota para la próxima llamada.
  colaMistral = resultado.catch(() => {});
  return resultado;
}

function jitter(ms) {
  // +-20% para que si dos procesos distintos (dos instancias, o el Worker
  // reintentando en paralelo) chocan igual, no vuelvan a reintentar en el
  // mismo instante exacto.
  return Math.round(ms * (0.8 + Math.random() * 0.4));
}

/**
 * Llama a la API de Mistral y devuelve el texto de la respuesta.
 * Si esperás JSON, pasá parseJson=true (limpia ```json y parsea).
 * Misma firma que la vieja llamarClaude(), para no tener que tocar
 * ia3.js / ia4.js / server.js más que el import.
 *
 * Reintentos en 429 (rate_limited): el free tier de Mistral tiene un
 * límite de requests bastante ajustado, y varias llamadas seguidas (ej:
 * traducir + clasificar, o clasificar + IA#2) lo pisan fácil. Además de
 * reintentar con backoff (respetando Retry-After si Mistral lo manda),
 * todas las llamadas pasan por serializar() para no salir en paralelo.
 */
export async function llamarIA({ system, prompt, model = "mistral-small-latest", maxTokens = 8000, parseJson = false }) {
  if (!process.env.MISTRAL_API_KEY) {
    throw new Error("MISTRAL_API_KEY no está configurada en variables de entorno");
  }

  return serializar(() => llamarIAInterno({ system, prompt, model, maxTokens, parseJson }));
}

async function llamarIAInterno({ system, prompt, model, maxTokens, parseJson }) {
  const maxIntentos = 4;

  for (let intento = 1; intento <= maxIntentos; intento++) {
    const resp = await fetchConTimeout(
      MISTRAL_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.MISTRAL_API_KEY}`,
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          messages: [
            { role: "system", content: system },
            { role: "user", content: prompt },
          ],
          ...(parseJson ? { response_format: { type: "json_object" } } : {}),
        }),
      },
      TIMEOUT_FETCH_MS
    );

    if (resp.ok) {
      const data = await resp.json();
      const texto = data.choices?.[0]?.message?.content ?? "";
      if (!parseJson) return texto;
      return extraerJson(texto, "Mistral");
    }

    const errText = await resp.text();

    if (resp.status === 401) {
      throw new Error(`Mistral API error 401 (Unauthorized): MISTRAL_API_KEY inválida. Response: ${errText}`);
    }

    if (resp.status === 429 && intento < maxIntentos) {
      const retryAfterHeader = parseInt(resp.headers.get("retry-after") || "", 10);
      const espera = !isNaN(retryAfterHeader) ? retryAfterHeader * 1000 : jitter(Math.pow(2, intento) * 1000);
      console.warn(`[mistral] 429 rate_limited (intento ${intento}/${maxIntentos}), espero ${espera}ms y reintento`);
      await new Promise((resolve) => setTimeout(resolve, espera));
      continue;
    }

    throw new Error(`Mistral API error ${resp.status}: ${errText}`);
  }

  throw new Error("Mistral API: se agotaron los reintentos por rate limit (429)");
}

/**
 * Extrae y parsea el JSON de la respuesta. Mistral con response_format
 * json_object normalmente devuelve JSON puro, pero si la respuesta se corta
 * por límite de maxTokens a mitad de un string largo, el parseo directo
 * falla igual. Misma lógica de extracción/recuperación que anthropic.js,
 * para no perder toda la ronda por un corte de tokens.
 */
function extraerJson(texto, origen) {
  const limpio = texto.replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(limpio);
  } catch {
    // seguimos abajo
  }

  const inicio = texto.indexOf("{");
  if (inicio === -1) {
    throw new Error(`No se pudo parsear JSON de ${origen}: no se encontró un bloque JSON válido\nTexto crudo:\n${texto}`);
  }

  let profundidad = 0;
  let dentroString = false;
  let escapando = false;
  for (let i = inicio; i < texto.length; i++) {
    const c = texto[i];
    if (escapando) {
      escapando = false;
      continue;
    }
    if (c === "\\") {
      escapando = true;
      continue;
    }
    if (c === '"') {
      dentroString = !dentroString;
      continue;
    }
    if (dentroString) continue;
    if (c === "{") profundidad++;
    if (c === "}") {
      profundidad--;
      if (profundidad === 0) {
        const bloque = texto.slice(inicio, i + 1);
        try {
          return JSON.parse(bloque);
        } catch (err) {
          throw new Error(`No se pudo parsear JSON de ${origen}: ${err.message}\nTexto crudo:\n${texto}`);
        }
      }
    }
  }

  let bloque = texto.slice(inicio);
  if (dentroString) bloque += '"';
  bloque += "}".repeat(Math.max(profundidad, 0));
  try {
    const resultado = JSON.parse(bloque);
    console.warn(
      `[mistral] JSON de ${origen} venía truncado (probable límite de maxTokens); ` +
      "se recuperó cerrando el bloque de forma heurística. Revisar si el contenido recuperado es completo."
    );
    return resultado;
  } catch {
    throw new Error(`No se pudo parsear JSON de ${origen}: no se encontró un bloque JSON válido\nTexto crudo:\n${texto}`);
  }
}
