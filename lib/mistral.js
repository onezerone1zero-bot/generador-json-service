import { extraerJson } from "./extraerJson.js";

const MISTRAL_URL = "https://api.mistral.ai/v1/chat/completions";

/**
 * Llama a la API de Mistral (usada acá como "IA que corrige" el
 * borrador de Claude). La API de Mistral es compatible con el formato
 * chat-completions de OpenAI, así que esto es casi un calco de
 * chatgpt.js -- misma firma que llamarIA() de claude.js/deepseek.js.
 */
export async function llamarIA({ system, prompt, model = "mistral-small-latest", maxTokens = 8000, parseJson = false }) {
  if (!process.env.MISTRAL_API_KEY) {
    throw new Error("MISTRAL_API_KEY no está configurada en variables de entorno");
  }

  const resp = await fetch(MISTRAL_URL, {
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
  });

  if (!resp.ok) {
    const errText = await resp.text();
    if (resp.status === 401) {
      throw new Error(`Mistral API error 401 (Unauthorized): MISTRAL_API_KEY inválida. Response: ${errText}`);
    }
    throw new Error(`Mistral API error ${resp.status}: ${errText}`);
  }

  const data = await resp.json();
  const texto = data.choices?.[0]?.message?.content ?? "";

  if (!parseJson) return texto;
  return extraerJson(texto, "Mistral");
}

/**
 * Detecta si un error de la API de Mistral es "tolerable" (falta de
 * crédito/cuota, clave inválida, rate limit) -- mismo criterio que en
 * claude.js/deepseek.js/chatgpt.js. Si Mistral falla así, el pipeline
 * (ver generar.js) sigue con el borrador de Claude sin corregir.
 */
export function esErrorDeCreditoMistral(err) {
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
