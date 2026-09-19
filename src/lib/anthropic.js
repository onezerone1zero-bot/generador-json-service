import { fetchConTimeout } from "./fetchTimeout.js";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const STATUS_URL = "https://status.claude.com/api/v2/status.json";

// Status page: chequeo rápido y no crítico (ya hay fallback si falla).
const TIMEOUT_STATUS_MS = 8_000;
// Generación real: Opus con hasta 16000 max_tokens puede tardar bastante
// en casos normales -- el timeout tiene que ser generoso para no cortar
// una respuesta que solo iba lenta, pero finito para no colgarse nunca
// más como pasó el 18/09.
const TIMEOUT_GENERACION_MS = 180_000;

// Cache del status para no consultar cada vez (gratis, 60 segundos)
let statusCache = {
  data: null,
  timestamp: 0,
  TTL: 60000,
};

/**
 * Obtiene el estado del servicio de Anthropic desde la página de estado.
 * Devuelve 'operational', 'degraded_performance', 'partial_outage', 'major_outage' o null.
 * Esta llamada es GRATUITA (no consume tokens de Anthropic).
 */
async function obtenerEstadoServicio() {
  const ahora = Date.now();
  if (statusCache.data && (ahora - statusCache.timestamp) < statusCache.TTL) {
    return statusCache.data;
  }

  try {
    const resp = await fetchConTimeout(
      STATUS_URL,
      { headers: { Accept: "application/json" } },
      TIMEOUT_STATUS_MS
    );
    if (!resp.ok) {
      console.warn(`[anthropic] No se pudo obtener status (HTTP ${resp.status}), asumiendo operativo.`);
      return null;
    }
    const data = await resp.json();
    const indicator = data?.status?.indicator || data?.status?.description || null;
    statusCache.data = indicator;
    statusCache.timestamp = ahora;
    return indicator;
  } catch (err) {
    console.warn(`[anthropic] Error consultando status: ${err.message}, asumiendo operativo.`);
    return null;
  }
}

/**
 * Prueba si un modelo está disponible con una llamada mínima.
 * Gasta ~2-3 tokens por intento (muchísimo menos que una generación real).
 * Hasta 3 intentos con backoff exponencial (1s, 2s, 4s).
 */
async function probarModelo(model) {
  const promptPrueba = "Responde exactamente con la palabra 'OK' y nada más.";
  const maxTokensPrueba = 5;

  for (let intento = 1; intento <= 3; intento++) {
    try {
      const resp = await llamarClaudeConModelo(
        "", // sin system, para ahorrar tokens
        promptPrueba,
        model,
        maxTokensPrueba,
        false // no parsear JSON
      );

      if (resp.trim() === "OK") {
        console.log(`[anthropic] ✅ Modelo ${model} disponible (intento ${intento})`);
        return true;
      }

      console.warn(
        `[anthropic] Modelo ${model} respondió inesperadamente: "${resp.slice(0, 50)}", ` +
        `reintentando (${intento}/3)...`
      );
    } catch (err) {
      const esTransitorio = esErrorTransitorio(err);
      if (!esTransitorio) {
        console.warn(`[anthropic] Modelo ${model} falló con error no transitorio: ${err.message.slice(0, 100)}`);
        return false;
      }
      console.warn(
        `[anthropic] Modelo ${model} falló en prueba ${intento}/3: ${err.message.slice(0, 100)}`
      );
    }

    // Espera exponencial entre intentos: 1s, 2s, 4s
    const delay = Math.pow(2, intento - 1) * 1000;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  console.warn(`[anthropic] ❌ Modelo ${model} no disponible después de 3 intentos de prueba`);
  return false;
}

/**
 * Llama a la API de Claude con un modelo específico.
 * PRIMERO prueba el modelo con una llamada mínima (~2-3 tokens).
 * Solo si la prueba es exitosa, procede con la generación real.
 *
 * Si el modelo principal (Opus) falla la prueba, prueba Sonnet, luego Haiku.
 * Si todos fallan la prueba, lanza un error.
 */
export async function llamarClaude({
  system,
  prompt,
  model = "claude-opus-4-8",
  maxTokens = 8000,
  parseJson = false,
}) {
  // 1) Chequeo rápido del status page global (gratis, solo para caídas graves)
  const status = await obtenerEstadoServicio();
  if (status === "major_outage") {
    throw new Error(
      "Anthropic está en interrupción global (major_outage). " +
      "No se intenta llamar a la API para no gastar tokens innecesariamente."
    );
  }

  // 2) Lista de modelos a probar en orden (excluimos duplicados)
  const modelos = [
    model, // normalmente "claude-opus-4-8"
    "claude-sonnet-4-5",
    "claude-haiku-4-5",
  ];
  const modelosUnicos = [...new Set(modelos)];

  // 3) Probamos cada modelo hasta encontrar uno disponible
  let modeloElegido = null;
  for (const modeloActual of modelosUnicos) {
    console.log(`[anthropic] 🔍 Probando disponibilidad de ${modeloActual}...`);
    const disponible = await probarModelo(modeloActual);
    if (disponible) {
      modeloElegido = modeloActual;
      console.log(`[anthropic] ✅ Usando ${modeloActual} para la generación`);
      break;
    }
  }

  if (!modeloElegido) {
    throw new Error(
      "Ningún modelo de Anthropic está disponible después de probar " +
      modelosUnicos.join(", ") + ". Verifica tu API key o el estado del servicio."
    );
  }

  // 4) Generación real con el modelo elegido (sin reintentos, porque ya probamos que funciona)
  try {
    return await llamarClaudeConModelo(system, prompt, modeloElegido, maxTokens, parseJson);
  } catch (err) {
    // Si falla inesperadamente (ej: 529 de último momento), lo reintentamos una vez
    // (esto es raro, porque la prueba ya verificó disponibilidad)
    console.warn(
      `[anthropic] ${modeloElegido} falló en generación a pesar de la prueba: ${err.message.slice(0, 100)}. ` +
      `Reintentando una vez...`
    );
    await new Promise((resolve) => setTimeout(resolve, 2000));
    return await llamarClaudeConModelo(system, prompt, modeloElegido, maxTokens, parseJson);
  }
}

/**
 * Función interna que hace la llamada real a la API de Anthropic.
 * No tiene reintentos; eso lo maneja la función externa.
 */
async function llamarClaudeConModelo(system, prompt, model, maxTokens, parseJson) {
  const resp = await fetchConTimeout(
    ANTHROPIC_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: prompt }],
      }),
    },
    TIMEOUT_GENERACION_MS
  );

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Anthropic API error ${resp.status}: ${errText}`);
  }

  const data = await resp.json();
  const texto = data.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  if (!parseJson) return texto;
  return extraerJson(texto);
}

/**
 * Determina si un error es transitorio (merece reintento en la prueba).
 */
function esErrorTransitorio(err) {
  const mensaje = err?.message || "";
  // Errores de red/tiempo de espera
  if (err?.name === "TypeError" || err?.code === "ECONNRESET" || err?.code === "ETIMEDOUT") {
    return true;
  }
  // Códigos de estado HTTP transitorios
  const match = mensaje.match(/API error (\d{3})/);
  if (match) {
    const status = parseInt(match[1], 10);
    return status === 529 || status === 429 || (status >= 500 && status <= 599);
  }
  // Por defecto, si no sabemos, asumimos que es transitorio
  return true;
}

/**
 * Reemplaza el contenido de bloques ```...``` y de spans `...` por espacios
 * para no confundir llaves del JSON con llaves en código citado.
 */
function ocultarCodigoEntreBackticks(texto) {
  return texto.replace(/```[\s\S]*?```|`[^`\n]*`/g, (match) => " ".repeat(match.length));
}

/**
 * Extrae y parsea el primer objeto JSON balanceado que aparece en el texto.
 */
function extraerJson(texto) {
  const sinFences = texto.replace(/```json/g, "```").split("```");
  const candidatos = [];
  if (sinFences.length > 1) {
    for (let i = 1; i < sinFences.length; i += 2) {
      candidatos.push(sinFences[i].trim());
    }
  }
  candidatos.push(texto.trim());

  for (const candidato of candidatos) {
    try {
      return JSON.parse(candidato);
    } catch {
      // seguir probando
    }
  }

  const textoParaBuscar = ocultarCodigoEntreBackticks(texto);
  const inicio = textoParaBuscar.indexOf("{");
  if (inicio !== -1) {
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
            throw new Error(`No se pudo parsear JSON de Claude: ${err.message}\nTexto crudo:\n${texto}`);
          }
        }
      }
    }

    const recuperado = intentarRecuperarTruncado(texto, inicio, profundidad, dentroString);
    if (recuperado) return recuperado;
  }

  throw new Error(`No se pudo parsear JSON de Claude: no se encontró un bloque JSON válido\nTexto crudo:\n${texto}`);
}

/**
 * Intenta recuperar un JSON truncado (cortado por límite de tokens).
 */
function intentarRecuperarTruncado(texto, inicio, profundidadFaltante, dentroString) {
  let bloque = texto.slice(inicio);
  if (dentroString) {
    bloque += '"';
  }
  bloque += "}".repeat(Math.max(profundidadFaltante, 0));

  try {
    const resultado = JSON.parse(bloque);
    console.warn(
      "[anthropic] JSON de Claude venía truncado (probable límite de maxTokens); " +
      "se recuperó cerrando el bloque de forma heurística."
    );
    return resultado;
  } catch {
    return null;
  }
}
