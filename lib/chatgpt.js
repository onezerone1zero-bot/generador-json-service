import { extraerJson } from "./extraerJson.js";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

/**
 * Llama a la API de OpenAI/ChatGPT (usada acá como "IA que corrige" el
 * borrador de DeepSeek). Misma firma que llamarIA() de deepseek.js.
 */
export async function llamarIA({ system, prompt, model = "gpt-4o", maxTokens = 8000, parseJson = false }) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY no está configurada en variables de entorno");
  }

  const resp = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
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
      throw new Error(`OpenAI API error 401 (Unauthorized): OPENAI_API_KEY inválida. Response: ${errText}`);
    }
    throw new Error(`OpenAI API error ${resp.status}: ${errText}`);
  }

  const data = await resp.json();
  const texto = data.choices?.[0]?.message?.content ?? "";

  if (!parseJson) return texto;
  return extraerJson(texto, "ChatGPT");
}

/**
 * Detecta si un error de la API de OpenAI es "tolerable" (falta de
 * crédito/cuota, clave inválida) -- mismo criterio que en deepseek.js.
 * Si ChatGPT falla así, el pipeline (ver generar.js) sigue con el
 * borrador de DeepSeek sin corregir, en vez de abortar el job entero.
 */
export function esErrorDeCreditoOpenAI(err) {
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
