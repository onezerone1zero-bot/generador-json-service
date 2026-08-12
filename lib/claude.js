import { extraerJson } from "./extraerJson.js";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Llama a la API de Claude (usada acá como "IA que crea" el primer
 * borrador). Misma firma que llamarIA() de chatgpt.js/deepseek.js, pero
 * el formato de la API de Anthropic es distinto: el system prompt va
 * como campo aparte (no como mensaje), no existe response_format, y la
 * respuesta viene como un array "content" de bloques en vez de
 * choices[0].message.content -- por eso no comparte código con
 * chatgpt.js/mistral.js aunque tengan la misma firma hacia afuera.
 */
export async function llamarIA({ system, prompt, model = "claude-haiku-4-5-20251001", maxTokens = 8000, parseJson = false }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY no está configurada en variables de entorno");
  }

  const resp = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    if (resp.status === 401) {
      throw new Error(`Anthropic API error 401 (Unauthorized): ANTHROPIC_API_KEY inválida. Response: ${errText}`);
    }
    throw new Error(`Anthropic API error ${resp.status}: ${errText}`);
  }

  const data = await resp.json();
  const texto = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

  // No hay response_format acá -- extraerJson() ya sabe pelar fences de
  // markdown y recuperar JSON truncado, así que alcanza con el prompt
  // pidiendo "SOLO JSON" (ver prompts.js).
  if (!parseJson) return texto;
  return extraerJson(texto, "Claude");
}

/**
 * Detecta si un error de la API de Anthropic es "tolerable" (falta de
 * crédito/cuota, clave inválida, rate limit, sobrecarga) -- mismo
 * criterio que esErrorDeCreditoDeepSeek()/esErrorDeCreditoOpenAI().
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
