import { extraerJson } from "./extraerJson.js";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Llama a la API de Claude (usada acá como "IA que crea" el primer
 * borrador). Misma firma que llamarIA() de mistral.js, pero
 * el formato de la API de Anthropic es distinto: el system prompt va
 * como campo aparte (no como mensaje), no existe response_format, y la
 * respuesta viene como un array "content" de bloques en vez de
 * choices[0].message.content -- por eso no comparte código con
 * mistral.js aunque tengan la misma firma hacia afuera.
 */
export async function llamarIA({ system, prompt, model = "claude-opus-4-8", maxTokens = 8000, parseJson = false, tool = null }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY no está configurada en variables de entorno");
  }

  const body = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: prompt }],
  };

  // Si se pasa `tool`, forzamos tool use: la API valida la respuesta
  // contra input_schema del lado del servidor y devuelve el objeto ya
  // parseado -- no puede venir con JSON mal formado (comillas
  // faltantes, comas colgantes, etc.), a diferencia de pedir "SOLO
  // JSON" en el prompt y parsear texto libre. Esto reemplaza a
  // extraerJson() para estos casos, que queda solo como fallback.
  if (tool) {
    body.tools = [{ name: tool.name, description: tool.description, input_schema: tool.input_schema }];
    body.tool_choice = { type: "tool", name: tool.name };
  }

  const resp = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    if (resp.status === 401) {
      throw new Error(`Anthropic API error 401 (Unauthorized): ANTHROPIC_API_KEY inválida. Response: ${errText}`);
    }
    throw new Error(`Anthropic API error ${resp.status}: ${errText}`);
  }

  const data = await resp.json();

  if (tool) {
    // stop_reason "max_tokens" es la señal directa de que el output se
    // cortó antes de cerrar el tool_use -- el síntoma en ese caso es
    // justo un input con campos faltantes o arrays vacíos/incompletos,
    // porque el JSON nunca llegó a cerrarse. Se loguea siempre (no solo
    // en el caso de error) para poder ver el margen real contra
    // maxTokens en corridas que SÍ salen bien, y así ajustar el límite
    // con datos en vez de estimación la próxima vez que haga falta.
    if (data.stop_reason === "max_tokens") {
      console.warn(
        `[claude] tool_use cortado por max_tokens (modelo=${model}, maxTokens=${maxTokens}, output_tokens=${data.usage?.output_tokens ?? "?"}) -- el borrador va a venir incompleto`
      );
    } else {
      console.log(
        `[claude] tool_use completo (modelo=${model}, stop_reason=${data.stop_reason}, output_tokens=${data.usage?.output_tokens ?? "?"}/${maxTokens})`
      );
    }

    const bloqueTool = (data.content || []).find((b) => b.type === "tool_use" && b.name === tool.name);
    if (!bloqueTool) {
      // No debería pasar con tool_choice forzado, pero por las dudas
      // no reventamos silenciosamente: dejamos rastro de qué vino.
      throw new Error(`Claude no devolvió el tool_use esperado (${tool.name}). Bloques recibidos: ${(data.content || []).map((b) => b.type).join(", ")}`);
    }
    return bloqueTool.input;
  }

  const texto = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

  // Fallback para llamadas sin tool (no usado actualmente en el
  // pipeline de generar-json, pero se mantiene por si algún caller
  // pide parseJson sin tool): extraerJson() pela fences de markdown y
  // recupera JSON truncado con heurística.
  if (!parseJson) return texto;
  return extraerJson(texto, "Claude");
}

/**
 * Detecta si un error de la API de Anthropic es "tolerable" (falta de
 * crédito/cuota, clave inválida, rate limit, sobrecarga) -- mismo
 * criterio que esErrorDeCreditoMistral().
 */
export function esErrorDeCreditoAnthropic(err) {
  const msg = (err?.message || "").toLowerCase();
  return (
    msg.includes("credit balance") ||
    msg.includes("429") ||
    msg.includes("insufficient") ||
    msg.includes("quota") ||
    msg.includes("401") ||
    msg.includes("authentication") ||
    msg.includes("overloaded")
  );
}
