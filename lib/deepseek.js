import { extraerJson } from "./extraerJson.js";

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";

/**
 * Llama a la API de DeepSeek (usada acá como "IA que crea" el primer
 * borrador) y devuelve el texto de la respuesta, o el JSON ya parseado
 * si parseJson=true. Misma firma que llamarIA() de mistral.js en el otro
 * service, a propósito -- así los dos clientes de IA de este repo
 * (deepseek.js, chatgpt.js) son intercambiables entre sí sin tocar el
 * código que los llama.
 */
export async function llamarIA({ system, prompt, model = "deepseek-chat", maxTokens = 8000, parseJson = false }) {
  if (!process.env.DEEPSEEK_API_KEY) {
    throw new Error("DEEPSEEK_API_KEY no está configurada en variables de entorno");
  }

  const resp = await fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.DEEPSEEK_API_KEY}`,
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
  });

  if (!resp.ok) {
    const errText = await resp.text();
    if (resp.status === 401) {
      throw new Error(`DeepSeek API error 401 (Unauthorized): DEEPSEEK_API_KEY inválida. Response: ${errText}`);
    }
    throw new Error(`DeepSeek API error ${resp.status}: ${errText}`);
  }

  const data = await resp.json();
  const texto = data.choices?.[0]?.message?.content ?? "";

  if (!parseJson) return texto;
  return extraerJson(texto, "DeepSeek");
}

/**
 * Detecta si un error de la API de DeepSeek es "tolerable" (falta de
 * crédito/cuota, clave inválida) -- mismo criterio que
 * esErrorDeCreditoAnthropic() del otro service, para poder decidir si
 * vale la pena reintentar o abortar el job.
 */
export function esErrorDeCreditoDeepSeek(err) {
  const msg = (err?.message || "").toLowerCase();
  return (
    msg.includes("credit balance") ||
    msg.includes("429") ||
    msg.includes("insufficient") ||
    msg.includes("quota") ||
    msg.includes("401") ||
    msg.includes("authentication")
  );
}
